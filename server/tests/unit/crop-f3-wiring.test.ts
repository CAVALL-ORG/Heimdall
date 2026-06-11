import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { cropTools } from '../../src/mcp/tools/crop';
import { writeUnresolvedTargets } from '../../src/mcp/tools/row-state';

// F3 wiring (plan 2026-06-03-stereo-polarity-three-lever-plan §2 Lever A).
// The crop tool, ONLY on a dense row (sidecar dense:true), recenters the crop
// window on the ink centroid when a small feature is crammed off-center, and
// returns ink_centroid_source. A non-dense row is byte-identical (no recenter,
// no new field). The crop-after-validate gate is disabled so a bare crop runs;
// the dense flag is controlled purely via the sidecar.

const cropTool = cropTools[0];
type OkData = {
  path: string;
  window: { left: number; top: number; right: number; bottom: number };
  ink_centroid_source?: { x: number; y: number };
  recentered?: boolean;
};

let priorGate: string | undefined;
beforeAll(() => {
  priorGate = process.env.KETCHER_CROP_AFTER_VALIDATE;
  process.env.KETCHER_CROP_AFTER_VALIDATE = '0';
});
afterAll(() => {
  if (priorGate === undefined) delete process.env.KETCHER_CROP_AFTER_VALIDATE;
  else process.env.KETCHER_CROP_AFTER_VALIDATE = priorGate;
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

// 800×800 white source with one black blob.
async function makeSource(path: string, blob: { x: number; y: number; n: number }) {
  const overlay = await sharp({
    create: { width: blob.n, height: blob.n, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
  await sharp({
    create: { width: 800, height: 800, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: overlay, left: blob.x, top: blob.y }])
    .png()
    .toFile(path);
}

function setup(dense: boolean | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'cav-f3-'));
  dirs.push(dir);
  const src = join(dir, 'source.png');
  writeUnresolvedTargets(dir, { ok: true, round: 1, rowId: 'r', targets: [], dense });
  return { dir, src };
}

const args = (src: string, dir: string) => ({
  rowId: 'r', sourceImagePath: src, outputDir: dir, x: 400, y: 400, w: 300, h: 300,
});

describe('F3 dense-gated ink recenter', () => {
  it('DENSE + corner-crammed ink → recenters the window on the ink', async () => {
    const { dir, src } = setup(true);
    await makeSource(src, { x: 270, y: 270, n: 30 }); // centroid ~284.5, far from center 400
    const r = (await cropTool.run({} as never, args(src, dir))) as { ok: boolean; data: OkData };
    expect(r.ok).toBe(true);
    expect(r.data.recentered).toBe(true);
    expect(r.data.ink_centroid_source!.x).toBeCloseTo(284.5, 0);
    // requested window left = 400 − 150 = 250; recentered left = 285 − 150 = 135
    expect(r.data.window.left).toBe(135);
  });

  it('DENSE + already-centered ink → NO recenter (FP=0 on a well-framed dense crop)', async () => {
    const { dir, src } = setup(true);
    await makeSource(src, { x: 385, y: 385, n: 30 }); // centroid ~399.5 ≈ center 400
    const r = (await cropTool.run({} as never, args(src, dir))) as { ok: boolean; data: OkData };
    expect(r.ok).toBe(true);
    expect(r.data.recentered).toBeFalsy();
    expect(r.data.window.left).toBe(250); // requested window, untouched
  });

  it('NON-dense + corner-crammed ink → byte-identical (no recenter, no field)', async () => {
    const { dir, src } = setup(false);
    await makeSource(src, { x: 270, y: 270, n: 30 });
    const r = (await cropTool.run({} as never, args(src, dir))) as { ok: boolean; data: OkData };
    expect(r.ok).toBe(true);
    expect(r.data.recentered).toBeFalsy();
    expect(r.data.ink_centroid_source).toBeUndefined();
    expect(r.data.window.left).toBe(250);
  });
});
