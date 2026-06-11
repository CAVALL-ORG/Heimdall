import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { cropTools } from '../../src/mcp/tools/crop';
import { writeUnresolvedTargets } from '../../src/mcp/tools/row-state';

const cropTool = cropTools[0];

function seedPermissiveSidecar(outDir: string) {
  writeUnresolvedTargets(outDir, {
    ok: false,
    round: 1,
    rowId: 'r',
    targets: [
      {
        record_id: 'seed',
        field: 'wildcard',
        x_center: 0,
        y_center: 0,
        bbox_radius: 1_000_000,
        round: 1,
      },
    ],
  });
}

async function image(path: string, n: number) {
  await sharp({
    create: {
      width: n,
      height: n,
      channels: 3,
      background: { r: 200, g: 200, b: 200 },
    },
  })
    .png()
    .toFile(path);
}

describe('T5 numeric-telemetry scrub (KETCHER_SCRUB_TELEMETRY=1)', () => {
  const cleanups: string[] = [];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scrub-'));
    cleanups.push(dir);
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
    delete process.env.KETCHER_SCRUB_TELEMETRY;
  });

  it('crop ok payload drops tile_count / tile_budget_* in favor of degraded boolean', async () => {
    process.env.KETCHER_SCRUB_TELEMETRY = '1';
    const src = join(dir, 'src.png');
    await image(src, 1000);
    seedPermissiveSidecar(dir);
    const result = await cropTool.run({} as never, {
      rowId: 'r',
      sourceImagePath: src,
      outputDir: dir,
      x: 500,
      y: 500,
      w: 200,
      h: 200,
    });
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.tile_count).toBeUndefined();
    expect(data.tile_budget_used).toBeUndefined();
    expect(data.tile_budget_remaining).toBeUndefined();
    expect(typeof data.degraded).toBe('boolean');
  });

  it('source_too_small message strips the < 300 literal and the LOCK token', async () => {
    process.env.KETCHER_SCRUB_TELEMETRY = '1';
    const src = join(dir, 'small.png');
    await image(src, 200);
    seedPermissiveSidecar(dir);
    const result = await cropTool.run({} as never, {
      rowId: 'r',
      sourceImagePath: src,
      outputDir: dir,
      x: 100,
      y: 100,
      w: 150,
      h: 150,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('source_too_small');
    const msg = result.error?.message ?? '';
    expect(msg).not.toMatch(/<\s*300/);
    expect(msg).not.toMatch(/LOCK\s*27/);
    expect(msg).toMatch(/source_resolution_too_low/);
  });

  it('flag explicitly disabled preserves legacy payload shape and integers in messages', async () => {
    process.env.KETCHER_SCRUB_TELEMETRY = '0';
    const src = join(dir, 'src.png');
    await image(src, 1000);
    seedPermissiveSidecar(dir);
    const result = await cropTool.run({} as never, {
      rowId: 'r',
      sourceImagePath: src,
      outputDir: dir,
      x: 500,
      y: 500,
      w: 200,
      h: 200,
    });
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(typeof data.tile_count).toBe('number');
    expect(typeof data.tile_budget_used).toBe('number');
    expect(typeof data.tile_budget_remaining).toBe('number');
  });
});
