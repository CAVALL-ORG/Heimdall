import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { cropTools } from '../../src/mcp/tools/crop';
import { writeUnresolvedTargets } from '../../src/mcp/tools/row-state';

// ─────────────────────────────────────────────────────────────────────
// T1 — crop-after-validate relaxation on DENSE rows (plan §4.3).
// When the validate round wrote `dense:true`, the agent may self-direct
// confirmation crops (the zoom-verify loop): both the `no_pending_targets`
// (clean draft, targets:[]) and `crop_target_not_named` (proximity) branches
// are skipped. `crop_before_validate` and the tile budget still apply. A
// non-dense / dense-absent sidecar keeps the strict gate (back-compat).
// ─────────────────────────────────────────────────────────────────────

const cropTool = cropTools[0];

async function createImage(path: string, n = 1000): Promise<void> {
  await sharp({
    create: { width: n, height: n, channels: 3, background: { r: 200, g: 200, b: 200 } },
  })
    .png()
    .toFile(path);
}

const cropArgs = (src: string, dir: string) => ({
  rowId: 'r', sourceImagePath: src, outputDir: dir, x: 800, y: 800, w: 200, h: 200,
});

describe('T1 dense crop-gate relaxation', () => {
  const cleanups: string[] = [];
  let dir: string;
  let src: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cav-dense-'));
    cleanups.push(dir);
    src = join(dir, 'source.png');
    await createImage(src);
    process.env.KETCHER_CROP_AFTER_VALIDATE = '1';
  });

  afterEach(() => {
    for (const d of cleanups) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    cleanups.length = 0;
    delete process.env.KETCHER_CROP_AFTER_VALIDATE;
  });

  it('dense + clean draft (ok:true, targets:[]) ACCEPTS a self-directed crop', async () => {
    writeUnresolvedTargets(dir, { ok: true, round: 1, rowId: 'r', targets: [], dense: true });
    const result = await cropTool.run({} as never, cropArgs(src, dir));
    expect(result.ok).toBe(true);
  });

  it('dense + targets present but crop far from any target ACCEPTS (proximity skipped)', async () => {
    writeUnresolvedTargets(dir, {
      ok: false, round: 1, rowId: 'r', dense: true,
      targets: [{ record_id: 'atom:1', field: 'x', x_center: 100, y_center: 100, bbox_radius: 0, round: 1 }],
    });
    const result = await cropTool.run({} as never, cropArgs(src, dir));
    expect(result.ok).toBe(true);
  });

  it('dense:true does NOT bypass crop_before_validate (no sidecar yet)', async () => {
    const result = await cropTool.run({} as never, cropArgs(src, dir));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('crop_before_validate');
  });

  it('NON-dense clean draft still REJECTS with no_pending_targets (back-compat)', async () => {
    writeUnresolvedTargets(dir, { ok: true, round: 1, rowId: 'r', targets: [], dense: false });
    const result = await cropTool.run({} as never, cropArgs(src, dir));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('no_pending_targets');
  });

  it('dense ABSENT (undefined) keeps the strict gate (byte-identical back-compat)', async () => {
    writeUnresolvedTargets(dir, { ok: true, round: 1, rowId: 'r', targets: [] });
    const result = await cropTool.run({} as never, cropArgs(src, dir));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('no_pending_targets');
  });
});
