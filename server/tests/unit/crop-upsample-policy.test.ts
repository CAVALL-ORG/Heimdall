import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { cropTools } from '../../src/mcp/tools/crop';
import { writeUnresolvedTargets } from '../../src/mcp/tools/row-state';

// T1 (crop-after-validate) is ON by default. Seed a permissive sidecar
// so the proximity check accepts any (x, y) the test calls with — these
// tests only exercise the upsample policy, not the sequencing gate.
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

async function createSquareTestImage(size: number, path: string) {
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toFile(path);
}

const cropTool = cropTools[0];

type OkData = {
  path: string;
  upsampled: boolean;
  dimensions: { n: number; sourceWidth: number; sourceHeight: number };
};

describe('crop_source_image upsample policy (Phase 1 Task A)', () => {
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

  it('600x600 source, 200x200 crop → upsample to >=600 (bicubic)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-upsample-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(600, fixturePath);

    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x: 300,
      y: 300,
      w: 200,
      h: 200,
    });
    expect(result.ok).toBe(true);
    const data = result.data as OkData;
    expect(data.upsampled).toBe(true);
    expect(data.dimensions.n).toBeGreaterThanOrEqual(600);

    const meta = await sharp(data.path).metadata();
    expect(meta.width).toBeGreaterThanOrEqual(600);
    expect(meta.height).toBeGreaterThanOrEqual(600);
  });

  it('600x600 source, 500x500 crop → upsample to >=1000 (captured 500px < 1000 target)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-upsample-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(600, fixturePath);

    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x: 300,
      y: 300,
      w: 500,
      h: 500,
    });
    expect(result.ok).toBe(true);
    const data = result.data as OkData;
    expect(data.upsampled).toBe(true);
    expect(data.dimensions.n).toBeGreaterThanOrEqual(1000);

    const meta = await sharp(data.path).metadata();
    expect(meta.width).toBeGreaterThanOrEqual(1000);
    expect(meta.height).toBeGreaterThanOrEqual(1000);
  });

  it('4000x4000 source, 800x800 crop → upsample to 1000 (regression: cliff fix)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-upsample-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(4000, fixturePath);

    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x: 2000,
      y: 2000,
      w: 800,
      h: 800,
    });
    expect(result.ok).toBe(true);
    const data = result.data as OkData;
    expect(data.upsampled).toBe(true);
    expect(data.dimensions.n).toBe(1000);

    const meta = await sharp(data.path).metadata();
    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(1000);
  });

  it('350x350 source, 200x200 crop → upsample to 1000 (captured 200px < 1000 target)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-upsample-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(350, fixturePath);

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
    const data = result.data as OkData;
    expect(data.upsampled).toBe(true);
    expect(data.dimensions.n).toBe(1000);

    const meta = await sharp(data.path).metadata();
    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(1000);
  });

  it('1200x1200 source, 300x300 crop → upsample to 1000 (captured 300px < 1000 target)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-upsample-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(1200, fixturePath);

    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x: 600,
      y: 600,
      w: 300,
      h: 300,
    });
    expect(result.ok).toBe(true);
    const data = result.data as OkData;
    expect(data.upsampled).toBe(true);
    expect(data.dimensions.n).toBe(1000);

    const meta = await sharp(data.path).metadata();
    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(1000);
  });

  it('1200x1200 source, 800x800 crop → upsample to 1000 (captured 800px < 1000 target)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-upsample-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(1200, fixturePath);

    const result = await cropTool.run({} as never, {
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x: 600,
      y: 600,
      w: 800,
      h: 800,
    });
    expect(result.ok).toBe(true);
    const data = result.data as OkData;
    expect(data.upsampled).toBe(true);
    expect(data.dimensions.n).toBe(1000);

    const meta = await sharp(data.path).metadata();
    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(1000);
  });

  it('source under 300 px → source_resolution_too_low refusal (unchanged)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-upsample-'));
    cleanups.push(outDir);
    seedPermissiveSidecar(outDir);
    const fixturePath = join(outDir, 'src.png');
    await createSquareTestImage(250, fixturePath);

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
});
