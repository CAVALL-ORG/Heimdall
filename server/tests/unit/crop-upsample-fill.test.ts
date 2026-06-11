import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { cropTools } from '../../src/mcp/tools/crop';

// Bug under test (agent-orch-<run-id>/A011/438_344_150_150_up.png):
// the upsample path composited the UN-scaled visible portion onto a base that
// sharp resized FIRST (sharp applies resize before composite regardless of
// chain order), so a sub-1000px capture landed 1:1 in the top-left corner of
// the 1000×1000 output instead of being scaled to FILL the frame. The fix
// bakes the composite to a real raster (png().toBuffer() round-trip) BEFORE
// the resize. These tests assert the rendered pixels FILL the frame and the
// documented back-map (source_x = left + px·capturedN/outputN) holds.

const cropTool = cropTools[0];

// The task contract: disable the crop-after-validate gate so a bare crop is
// accepted (no preceding validate_graph round in these unit tests).
let priorGate: string | undefined;
beforeAll(() => {
  priorGate = process.env.KETCHER_CROP_AFTER_VALIDATE;
  process.env.KETCHER_CROP_AFTER_VALIDATE = '0';
});
afterAll(() => {
  if (priorGate === undefined) delete process.env.KETCHER_CROP_AFTER_VALIDATE;
  else process.env.KETCHER_CROP_AFTER_VALIDATE = priorGate;
});

type OkData = {
  path: string;
  upsampled: boolean;
  window: { left: number; top: number; right: number; bottom: number };
  capturedN: number;
  outputN: number;
};

// Build a white W×H source PNG, optionally painting a black rectangle.
async function makeSource(
  width: number,
  height: number,
  path: string,
  black?: { left: number; top: number; w: number; h: number },
): Promise<void> {
  let img = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  });
  if (black) {
    const overlay = await sharp({
      create: {
        width: black.w,
        height: black.h,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    img = img.composite([{ input: overlay, left: black.left, top: black.top }]);
  }
  await img.png().toFile(path);
}

// Scan a PNG for non-white pixels (any RGB channel < 250) and return the ink
// bounding box + a coverage count. Returns null bbox when fully white.
async function inkBBox(path: string): Promise<{
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
  width: number;
  height: number;
}> {
  const { data, info } = await sharp(path)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * ch;
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY, count, width: info.width, height: info.height };
}

// Mean (centroid) of all non-white pixels in a PNG.
async function inkCentroid(
  path: string,
): Promise<{ cx: number; cy: number; count: number }> {
  const { data, info } = await sharp(path)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * ch;
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
        sx += x;
        sy += y;
        count++;
      }
    }
  }
  return { cx: sx / count, cy: sy / count, count };
}

// Sample whether a single output pixel is white.
async function pixelIsWhite(path: string, px: number, py: number): Promise<boolean> {
  const { data, info } = await sharp(path)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const i = (py * info.width + px) * ch;
  return data[i] >= 250 && data[i + 1] >= 250 && data[i + 2] >= 250;
}

async function runCrop(args: {
  rowId: string;
  sourceImagePath: string;
  outputDir: string;
  x: number;
  y: number;
  w: number;
  h: number;
}): Promise<{ ok: boolean; data: OkData }> {
  const parsed = cropTool.inputValidator.parse(args);
  const result = await cropTool.run({} as never, parsed);
  return result as { ok: boolean; data: OkData };
}

describe('crop_source_image upsample FILLS the frame (resize-before-composite bug)', () => {
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

  it('Fill: an all-black crop window upsamples to ink that spans the FULL 1000px output', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-fill-'));
    cleanups.push(outDir);
    const fixturePath = join(outDir, 'src.png');
    // Fully black 800×800 source — every crop window is solid ink.
    await makeSource(800, 800, fixturePath, { left: 0, top: 0, w: 800, h: 800 });

    const N = 200;
    const result = await runCrop({
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x: 400,
      y: 400,
      w: N,
      h: N,
    });
    expect(result.ok).toBe(true);
    expect(result.data.upsampled).toBe(true);
    expect(result.data.outputN).toBe(1000);

    const bbox = await inkBBox(result.data.path);
    // After the fix the solid-ink window fills the whole 1000×1000 frame.
    // BEFORE the fix the ink lands 1:1 in a ~200px top-left corner (RED).
    expect(bbox.maxX - bbox.minX + 1).toBeGreaterThanOrEqual(950);
    expect(bbox.maxY - bbox.minY + 1).toBeGreaterThanOrEqual(950);
  });

  it('Back-map: a small marker maps to the documented output pixel (source_x = left + px·capturedN/outputN)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-fill-'));
    cleanups.push(outDir);
    const fixturePath = join(outDir, 'src.png');
    // White source with one 12×12 black marker at a known source point P.
    const markerSize = 12;
    const P = { x: 360, y: 300 }; // marker CENTER
    await makeSource(800, 800, fixturePath, {
      left: P.x - markerSize / 2,
      top: P.y - markerSize / 2,
      w: markerSize,
      h: markerSize,
    });

    // In-bounds crop window of side N centered at C, with P well inside.
    const C = { x: 400, y: 340 };
    const N = 200;
    const result = await runCrop({
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x: C.x,
      y: C.y,
      w: N,
      h: N,
    });
    expect(result.ok).toBe(true);
    const { window, capturedN, outputN } = result.data;
    expect(capturedN).toBe(N);
    expect(outputN).toBe(1000);

    // Forward map (inverse of the documented back-map): the marker at source P
    // should appear at output (ex, ey).
    const ex = ((P.x - window.left) * outputN) / capturedN;
    const ey = ((P.y - window.top) * outputN) / capturedN;

    const centroid = await inkCentroid(result.data.path);
    expect(centroid.count).toBeGreaterThan(0);
    // Tolerance ≈ ±30px for cubic-resample blur of the upscaled marker.
    expect(Math.abs(centroid.cx - ex)).toBeLessThanOrEqual(30);
    expect(Math.abs(centroid.cy - ey)).toBeLessThanOrEqual(30);

    // Sanity: confirm the documented back-map round-trips the centroid to P.
    const backX = window.left + (centroid.cx * capturedN) / outputN;
    const backY = window.top + (centroid.cy * capturedN) / outputN;
    expect(Math.abs(backX - P.x)).toBeLessThanOrEqual(8);
    expect(Math.abs(backY - P.y)).toBeLessThanOrEqual(8);
  });

  it('OOB white-pad preserved: in-source ink is scaled to fill, off-source region stays white', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'crop-fill-'));
    cleanups.push(outDir);
    const fixturePath = join(outDir, 'src.png');
    // Fully black 500×500 source so the in-source half of the window is solid ink.
    await makeSource(500, 500, fixturePath, { left: 0, top: 0, w: 500, h: 500 });

    // Center near the top-left corner: the left & top halves of the window run
    // off-source (white pad); the bottom-right quadrant is solid black source.
    const x = 50;
    const y = 50;
    const N = 200;
    const result = await runCrop({
      rowId: 'test',
      sourceImagePath: fixturePath,
      outputDir: outDir,
      x,
      y,
      w: N,
      h: N,
    });
    expect(result.ok).toBe(true);
    const { window, capturedN, outputN } = result.data;
    expect(window.left).toBeLessThan(0);
    expect(window.top).toBeLessThan(0);
    expect(outputN).toBe(1000);

    // (a) In-source ink is SCALED to fill, not stuck 1:1 in a tiny corner.
    // The in-source region (source x,y >= 0) occupies the bottom-right of the
    // window. Its forward-mapped left/top edges:
    const inkLeft = ((0 - window.left) * outputN) / capturedN;
    const inkTop = ((0 - window.top) * outputN) / capturedN;
    const bbox = await inkBBox(result.data.path);
    // Ink should reach the far (bottom-right) corner of the 1000px output.
    expect(bbox.maxX).toBeGreaterThanOrEqual(950);
    expect(bbox.maxY).toBeGreaterThanOrEqual(950);
    // Ink should START roughly at the forward-mapped source edge (scaled), not
    // at output pixel ~0 (which is where the un-scaled-corner bug would put it).
    expect(bbox.minX).toBeGreaterThanOrEqual(inkLeft - 30);
    expect(bbox.minY).toBeGreaterThanOrEqual(inkTop - 30);

    // (b) A patch that maps to off-source coords is WHITE (pad not stretched).
    // Output pixel (10,10) back-maps to source (window.left + small, …) < 0.
    const probe = { px: 10, py: 10 };
    const srcX = window.left + (probe.px * capturedN) / outputN;
    const srcY = window.top + (probe.py * capturedN) / outputN;
    expect(srcX).toBeLessThan(0); // confirm the probe is genuinely off-source
    expect(srcY).toBeLessThan(0);
    expect(await pixelIsWhite(result.data.path, probe.px, probe.py)).toBe(true);
  });
});
