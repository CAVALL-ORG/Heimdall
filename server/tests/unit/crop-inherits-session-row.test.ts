import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  resolveRowState,
  writeUnresolvedTargets,
  _resetSessionUuidForTest,
} from '../../src/mcp/tools/row-state';
import { cropTools } from '../../src/mcp/tools/crop';

// ─────────────────────────────────────────────────────────────────────
// F5 footgun — crop_source_image after the row's validate_graph hits
// `crop_before_validate` in agent-orch runs.
//
// validate_graph is called with explicit rowId + outputDir + sourceImagePath
// (branch 1 of resolveRowState, records the session row). crop_source_image
// carries sourceImagePath but NO outputDir, so it used to hit branch 2 and
// fork to a divergent `ketcher-row-<hash>` dir — never finding the sidecar
// validate wrote into the row's outputDir → `crop_before_validate`.
//
// The fix makes a same-image call with no explicit outputDir INHERIT the
// established session row (branch-2 top guard), while a DIFFERENT image still
// re-binds (multi-image-batch safe).
// ─────────────────────────────────────────────────────────────────────

const cropTool = cropTools[0];

async function createImage(path: string, n = 1000): Promise<void> {
  await sharp({
    create: { width: n, height: n, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toFile(path);
}

describe('crop_source_image inherits the validate-established session row (F5 fix)', () => {
  const cleanups: string[] = [];
  let rowDir: string;
  let img: string;

  beforeEach(async () => {
    _resetSessionUuidForTest();
    rowDir = mkdtempSync(join(tmpdir(), 'crop-inherit-row-'));
    cleanups.push(rowDir);
    img = join(rowDir, 'source.png');
    await createImage(img);
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

  it('case 1 — anchorless same-image call inherits the explicit-anchor row', () => {
    // agent-orch validate_graph: explicit rowId + outputDir + sourceImagePath
    // (branch 1; records the session row WITH the image).
    resolveRowState({ rowId: 'A011', outputDir: rowDir, sourceImagePath: img });
    // crop_source_image: carries sourceImagePath but NO outputDir.
    const got = resolveRowState({ sourceImagePath: img });
    expect(got.outputDir).toBe(rowDir);
    expect(got.rowId).toBe('A011');
  });

  it('case 2 — end-to-end crop finds the dense sidecar without an explicit outputDir', async () => {
    process.env.KETCHER_CROP_AFTER_VALIDATE = '1';
    // Branch 1: validate establishes the session row for this image.
    resolveRowState({ rowId: 'A011', outputDir: rowDir, sourceImagePath: img });
    // validate writes a dense sidecar into the row's outputDir.
    writeUnresolvedTargets(rowDir, {
      ok: false,
      round: 1,
      rowId: 'A011',
      dense: true,
      targets: [],
    });
    // crop resolves its dir the way server.ts does — from sourceImagePath only.
    const r = resolveRowState({ sourceImagePath: img });
    const result = await cropTool.run(
      {} as never,
      cropTool.inputValidator.parse({
        sourceImagePath: img,
        outputDir: r.outputDir,
        rowId: r.rowId,
        x: 500,
        y: 500,
        w: 200,
        h: 200,
      }),
    );
    // The gate passes because the inherited dir IS where validate wrote the
    // sidecar — NOT `crop_before_validate`.
    expect(result.ok).toBe(true);
  });

  it('case 3 — multi-image safety: a DIFFERENT image re-binds (no bleed)', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'crop-inherit-A-'));
    const dirB = mkdtempSync(join(tmpdir(), 'crop-inherit-B-'));
    cleanups.push(dirA, dirB);
    const imgA = join(dirA, 'a.png');
    const imgB = join(dirB, 'b.png');
    await createImage(imgA);
    await createImage(imgB);

    resolveRowState({ rowId: 'A011', outputDir: dirA, sourceImagePath: imgA });
    // A DIFFERENT image with no outputDir must NOT inherit A's row.
    const b = resolveRowState({ sourceImagePath: imgB });
    expect(b.outputDir).not.toBe(dirA);
  });

  it('case 4 — back-compat: explicit outputDir + rowId stays authoritative', () => {
    const dirX = mkdtempSync(join(tmpdir(), 'crop-inherit-X-'));
    cleanups.push(dirX);
    const r = resolveRowState({ rowId: 'X', outputDir: dirX, sourceImagePath: img });
    expect(r.outputDir).toBe(dirX);
    expect(r.rowId).toBe('X');
    expect(r.defaulted).toBe(false);
  });

  it('case 5 — symlink-rewrite resilience (the LIVE agent-orch bug): validate records the <dir>/source.png symlink, bare crop carries the original', async () => {
    // Reproduces the live failure missed by cases 1-4 (which pass the SAME
    // string to both calls). In production the server rewrites a tool's
    // sourceImagePath to a `<outputDir>/source.png` symlink (renameImageHandle,
    // T6 path indirection), and validate.run re-records THAT symlink into
    // lastResolvedRow (validate.ts:932 resolveRowState(parsed.sourceImagePath)).
    // The subsequent crop carries the ORIGINAL path, so a plain string compare
    // (symlink !== original) breaks the inherit → crop_before_validate.
    const origDir = mkdtempSync(join(tmpdir(), 'crop-inherit-orig-'));
    const rowDir5 = mkdtempSync(join(tmpdir(), 'crop-inherit-sym-'));
    cleanups.push(origDir, rowDir5);
    const original = join(origDir, 'taxol_core.png');
    await createImage(original);
    const symlink = join(rowDir5, 'source.png'); // what renameImageHandle creates
    symlinkSync(original, symlink);

    // validate.run (post-rename) records the SYMLINK path as the session image:
    resolveRowState({ rowId: 'A004', outputDir: rowDir5, sourceImagePath: symlink });
    // bare crop_source_image carries the ORIGINAL path (the agent re-sends it):
    const got = resolveRowState({ sourceImagePath: original });
    expect(got.outputDir).toBe(rowDir5); // must inherit via realpath canonicalization
    expect(got.rowId).toBe('A004');
  });
});
