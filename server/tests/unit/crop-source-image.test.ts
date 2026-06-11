import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { cropTools } from '../../src/mcp/tools/crop';
import { writeUnresolvedTargets } from '../../src/mcp/tools/row-state';

// T1 (crop-after-validate) is ON by default in Phase 2. These tests
// were written before T1 existed and exercise crop geometry / tile
// budget mechanics, not the T1 sequence gate. Seed a permissive
// sidecar (one wildcard target with a huge bbox_radius) so the
// proximity check accepts any (x, y) the test calls with.
function seedPermissiveSidecar(outDir: string) {
  writeUnresolvedTargets(outDir, {
    ok: false,
    round: 1,
    rowId: 'test',
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

// Dense rows get the higher TILE_BUDGET_DENSE cap. Same permissive wildcard
// target, plus the `dense` flag the validate sidecar sets from isDenseDraft of
// a fused polycyclic submission.
function seedDenseSidecar(outDir: string) {
  writeUnresolvedTargets(outDir, {
    ok: false,
    round: 1,
    rowId: 'test',
    dense: true,
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

const FIXTURE = join(
  process.cwd().endsWith('server')
    ? '..'
    : '.',
  'tests/scientific/images/wikipedia/glucose_wiki.png',
);

const cropTool = cropTools[0];

async function createSquareTestImage(width: number, height: number, path: string) {
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toFile(path);
}

describe('crop_source_image (LOCK 1)', () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    cleanups.length = 0;
  });

  it('auto-squares a non-square crop to min(w,h) instead of rejecting (C1 coercion)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-test-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(800, 800, fixturePath);

    // w=200, h=300 → coerced to N=200 (min), succeeds
    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x: 400,
      y: 400,
      w: 200,
      h: 300,
    });
    expect(result.ok).toBe(true);
    // coerced_to field advertises the correction
    expect((result.data as { coerced_to?: string }).coerced_to).toMatch(/square/);
  });

  it('auto-clamps N below 150 floor to 150 instead of rejecting (C1 coercion)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-test-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(800, 800, fixturePath);

    // w=100, h=100 → clamped to N=150, succeeds
    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x: 400,
      y: 400,
      w: 100,
      h: 100,
    });
    expect(result.ok).toBe(true);
    expect((result.data as { coerced_to?: string }).coerced_to).toMatch(/clamp/);
  });

  it('auto-clamps N above 1200 ceiling to 1200 instead of rejecting (C1 coercion)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-test-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(1800, 1800, fixturePath);

    // w=1300, h=1300 → clamped to N=1200, succeeds
    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x: 900,
      y: 900,
      w: 1300,
      h: 1300,
    });
    expect(result.ok).toBe(true);
    expect((result.data as { coerced_to?: string }).coerced_to).toMatch(/clamp/);
  });

  it('writes a square crop centered on (x,y) (upsamples small region under Phase 1 Task A)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-test-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(1000, 1000, fixturePath);

    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x: 500,
      y: 500,
      w: 200,
      h: 200,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { path: string; upsampled: boolean; dimensions: { n: number } };
    expect(existsSync(data.path)).toBe(true);
    // Revised policy: capturedRealPx=200 < UPSAMPLE_TARGET=1000 → upsample to 1000.
    expect(data.upsampled).toBe(true);
    expect(data.dimensions.n).toBe(1000);

    const meta = await sharp(data.path).metadata();
    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(1000);
  });

  it('pads with white when crop window exceeds source bounds (LOCK 1)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-test-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(500, 500, fixturePath);

    // Center crop near the edge — half the N×N falls outside source bounds.
    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x: 50,
      y: 50,
      w: 200,
      h: 200,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { path: string; dimensions: { n: number } };
    // Revised policy: capturedRealPx=200 < UPSAMPLE_TARGET=1000 → upsample to 1000 (still padded).
    const meta = await sharp(data.path).metadata();
    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(1000);
  });

  it('refuses sources with min(w,h) < 300 (LOCK 27)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-test-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(250, 250, fixturePath);

    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x: 125,
      y: 125,
      w: 150,
      h: 150,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('source_too_small');
  });

  it('upsamples crops to N=1000 for low-res sources 300 ≤ min < 400 (Phase 1 Task A revised)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-test-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(350, 350, fixturePath);

    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x: 175,
      y: 175,
      w: 200,
      h: 200,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { path: string; upsampled: boolean; dimensions: { n: number } };
    expect(data.upsampled).toBe(true);
    // Revised policy: capturedRealPx=200 < UPSAMPLE_TARGET=1000 → upsample to 1000.
    expect(data.dimensions.n).toBe(1000);
    expect(data.path.endsWith('_up.png')).toBe(true);

    const meta = await sharp(data.path).metadata();
    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(1000);
  });

  it('returns tile_count = ceil(capturedRealPx/200)² (LOCK 30 — bills real px, not upsampled)', async () => {
    const prev = process.env.KETCHER_SCRUB_TELEMETRY;
    process.env.KETCHER_SCRUB_TELEMETRY = '0';
    try {
      const outDir = mkdtempSync(join(tmpdir(), 'crop-test-'));
      cleanups.push(outDir);
      seedPermissiveSidecar(outDir);
      const fixturePath = join(outDir, 'src.png');
      await createSquareTestImage(1200, 1200, fixturePath);

      const result = await cropTool.run({} as never, {
        rowId: 'test',
        sourceImagePath: fixturePath,
        outputDir: outDir,
        x: 600,
        y: 600,
        w: 400,
        h: 400,
      });
      expect(result.ok).toBe(true);
      const data = result.data as { tile_count: number };
      // Revised policy: capturedRealPx=400 < UPSAMPLE_TARGET=1000 → upsample
      // fires but budget bills capturedRealPx=400. ceil(400/200) = 2; 2² = 4.
      expect(data.tile_count).toBe(4);
    } finally {
      if (prev === undefined) delete process.env.KETCHER_SCRUB_TELEMETRY;
      else process.env.KETCHER_SCRUB_TELEMETRY = prev;
    }
  });

  it('LOCK 30: refuses the crop that would push cumulative tile budget over 50', async () => {
    const prev = process.env.KETCHER_SCRUB_TELEMETRY;
    process.env.KETCHER_SCRUB_TELEMETRY = '0';
    try {
      const outDir = mkdtempSync(join(tmpdir(), 'crop-test-'));
      cleanups.push(outDir);
      seedPermissiveSidecar(outDir);
      const fixturePath = join(outDir, 'src.png');
      await createSquareTestImage(2400, 2400, fixturePath);

      const callCrop = async (offset: number) =>
        cropTool.run({} as never, {
          rowId: 'test',
          sourceImagePath: fixturePath,
          outputDir: outDir,
          x: 800 + offset,
          y: 800,
          w: 800,
          h: 800,
        });

      const a = await callCrop(0);
      expect(a.ok).toBe(true);
      expect((a.data as { tile_budget_used: number }).tile_budget_used).toBe(16);

      const b = await callCrop(10);
      expect(b.ok).toBe(true);
      expect((b.data as { tile_budget_used: number }).tile_budget_used).toBe(32);

      const c = await callCrop(20);
      expect(c.ok).toBe(true);
      expect((c.data as { tile_budget_used: number }).tile_budget_used).toBe(48);

      const d = await callCrop(30);
      expect(d.ok).toBe(false);
      expect(d.error?.code).toBe('tile_budget_exhausted');
      const details = d.error?.details as {
        tile_budget_used: number;
        count_consumed: false;
      };
      expect(details.tile_budget_used).toBe(48);
      expect(details.count_consumed).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.KETCHER_SCRUB_TELEMETRY;
      else process.env.KETCHER_SCRUB_TELEMETRY = prev;
    }
  });

  it('LOCK 30: dense rows get a higher tile cap (the 4th 800px crop a sparse row refuses at 50 succeeds)', async () => {
    const prev = process.env.KETCHER_SCRUB_TELEMETRY;
    process.env.KETCHER_SCRUB_TELEMETRY = '0';
    try {
      const outDir = mkdtempSync(join(tmpdir(), 'crop-test-'));
      cleanups.push(outDir);
      seedDenseSidecar(outDir);
      const fixturePath = join(outDir, 'src.png');
      await createSquareTestImage(2400, 2400, fixturePath);

      const callCrop = async (offset: number) =>
        cropTool.run({} as never, {
          rowId: 'test',
          sourceImagePath: fixturePath,
          outputDir: outDir,
          x: 800 + offset,
          y: 800,
          w: 800,
          h: 800,
        });

      // 4 × 16-tile crops = 64 tiles. A sparse row (cap 50) refuses the 4th;
      // a dense row (cap 200) accepts it — proving the dense gate is in effect.
      for (let i = 0; i < 3; i++) expect((await callCrop(i * 10)).ok).toBe(true);
      const fourth = await callCrop(30);
      expect(fourth.ok).toBe(true);
      expect(
        (fourth.data as { tile_budget_used: number }).tile_budget_used,
      ).toBe(64);
    } finally {
      if (prev === undefined) delete process.env.KETCHER_SCRUB_TELEMETRY;
      else process.env.KETCHER_SCRUB_TELEMETRY = prev;
    }
  });

  it('LOCK 30: tile budget is per-row (different outputDir resets counter)', async () => {
    const prev = process.env.KETCHER_SCRUB_TELEMETRY;
    process.env.KETCHER_SCRUB_TELEMETRY = '0';
    try {
      const outDirA = mkdtempSync(join(tmpdir(), 'crop-test-'));
      const outDirB = mkdtempSync(join(tmpdir(), 'crop-test-'));
      cleanups.push(outDirA, outDirB);
      seedPermissiveSidecar(outDirA);
      seedPermissiveSidecar(outDirB);
      const fixturePath = join(outDirA, 'src.png');
      await createSquareTestImage(2400, 2400, fixturePath);

      const call = async (outDir: string) =>
        cropTool.run({} as never, {
          rowId: 'test',
          sourceImagePath: fixturePath,
          outputDir: outDir,
          x: 800,
          y: 800,
          w: 800,
          h: 800,
        });

      for (let i = 0; i < 3; i++) {
        const r = await call(outDirA);
        expect(r.ok).toBe(true);
      }
      const fresh = await call(outDirB);
      expect(fresh.ok).toBe(true);
      expect(
        (fresh.data as { tile_budget_used: number }).tile_budget_used,
      ).toBe(16);
    } finally {
      if (prev === undefined) delete process.env.KETCHER_SCRUB_TELEMETRY;
      else process.env.KETCHER_SCRUB_TELEMETRY = prev;
    }
  });

  it('F1: returns the source-frame window {left,top,right,bottom} centered on (x,y) with capturedN/outputN (upsample case)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-test-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(1000, 1000, fixturePath);

    const x = 500;
    const y = 500;
    const N = 200;
    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x,
      y,
      w: N,
      h: N,
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      window: { left: number; top: number; right: number; bottom: number };
      capturedN: number;
      outputN: number;
    };
    // Window is the FULL (unclamped) crop window centered on (x,y).
    expect(data.window.left).toBe(x - Math.floor(N / 2));
    expect(data.window.top).toBe(y - Math.floor(N / 2));
    expect(data.window.right).toBe(data.window.left + N);
    expect(data.window.bottom).toBe(data.window.top + N);
    expect(data.capturedN).toBe(N);
    // N < 1000 → upsampled to 1000.
    expect(data.outputN).toBe(1000);
    // Back-map of the output-image center returns the requested source center.
    const scale = data.capturedN / data.outputN;
    const backMappedCenterX = data.window.left + (data.outputN / 2) * scale;
    const backMappedCenterY = data.window.top + (data.outputN / 2) * scale;
    expect(Math.abs(backMappedCenterX - x)).toBeLessThanOrEqual(1);
    expect(Math.abs(backMappedCenterY - y)).toBeLessThanOrEqual(1);
  });

  it('F1: outputN === capturedN when N >= 1000 (no upsample)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-test-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(2000, 2000, fixturePath);

    const x = 1000;
    const y = 1000;
    const N = 1200; // >= UPSAMPLE_TARGET (1000) → no upsample, outputN === N
    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x,
      y,
      w: N,
      h: N,
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      window: { left: number; top: number; right: number; bottom: number };
      capturedN: number;
      outputN: number;
    };
    expect(data.window.left).toBe(x - Math.floor(N / 2));
    expect(data.window.top).toBe(y - Math.floor(N / 2));
    expect(data.window.right).toBe(data.window.left + N);
    expect(data.window.bottom).toBe(data.window.top + N);
    expect(data.capturedN).toBe(N);
    expect(data.outputN).toBe(N);
  });

  it('F1: window.left/top are NEGATIVE (not clamped to 0) when the crop runs off the source edge', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-test-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(500, 500, fixturePath);

    // Center near the top-left corner: half the N×N window falls off-source.
    const x = 50;
    const y = 50;
    const N = 200;
    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x,
      y,
      w: N,
      h: N,
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      window: { left: number; top: number; right: number; bottom: number };
      capturedN: number;
      outputN: number;
    };
    // left = 50 - 100 = -50; returned as-is (the negative region is white pad).
    expect(data.window.left).toBe(x - Math.floor(N / 2));
    expect(data.window.top).toBe(y - Math.floor(N / 2));
    expect(data.window.left).toBeLessThan(0);
    expect(data.window.top).toBeLessThan(0);
    expect(data.window.right).toBe(data.window.left + N);
    expect(data.window.bottom).toBe(data.window.top + N);
    expect(data.capturedN).toBe(N);
    expect(data.outputN).toBe(1000);
  });

  it('writes deterministic filename <x>_<y>_<w>_<h>(_up)?.png', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-test-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(800, 800, fixturePath);

    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x: 100,
      y: 200,
      w: 150,
      h: 150,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { path: string };
    // Revised policy: capturedRealPx=150 < UPSAMPLE_TARGET=1000 →
    // upsample fires, so the filename gets the `_up` suffix.
    expect(data.path.endsWith('100_200_150_150_up.png')).toBe(true);
  });
});
