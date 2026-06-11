import { describe, it, expect } from 'vitest';
import { computeInkRecenter } from '../../src/mcp/tools/crop-recenter';

// F3 (stereo-polarity three-lever plan):
// the crop tool measures the ink centroid of the captured window and, ONLY when
// a small feature is crammed off-center (the dense-core failure signature),
// recenters on it. Pure helper: takes an already-extracted grayscale buffer
// (dark pixel < 128 = ink) and decides. Source-frame mapping uses the visible
// portion's top-left (visibleLeft/visibleTop).

// Build a W×H grayscale buffer (255=white), painting an optional black rect.
function gray(
  W: number,
  H: number,
  rect: { x: number; y: number; w: number; h: number } | null,
): Uint8Array {
  const g = new Uint8Array(W * H).fill(255);
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.h; y++)
      for (let x = rect.x; x < rect.x + rect.w; x++) g[y * W + x] = 0;
  }
  return g;
}

describe('computeInkRecenter (F3 gate)', () => {
  it('no-ops when the ink is already centered (offset gate)', () => {
    // 40×40 blob centered in a 200×200 window; ink fraction low but on-center.
    const buf = gray(200, 200, { x: 80, y: 80, w: 40, h: 40 });
    const r = computeInkRecenter(buf, 200, 200, 0, 0, 100, 100, 200);
    expect(r.recenter).toBeNull();
    expect(r.inkCentroidSource).not.toBeNull();
    expect(r.inkCentroidSource!.x).toBeCloseTo(99.5, 0);
    expect(r.inkCentroidSource!.y).toBeCloseTo(99.5, 0);
  });

  it('recenters when sparse ink is crammed in a corner (the failure case)', () => {
    // 30×30 blob top-left; requested center is the frame center (100,100).
    const buf = gray(200, 200, { x: 10, y: 10, w: 30, h: 30 });
    const r = computeInkRecenter(buf, 200, 200, 0, 0, 100, 100, 200);
    expect(r.recenter).not.toBeNull();
    // blob cols/rows 10..39 → centroid 24.5 → round → 25
    expect(r.recenter!.centerX).toBe(25);
    expect(r.recenter!.centerY).toBe(25);
  });

  it('does NOT recenter a frame-filling crop even if off-center (fraction gate, FP=0)', () => {
    // 120×120 ink (fraction 0.36 ≫ 0.08) with an off-center centroid.
    const buf = gray(200, 200, { x: 10, y: 10, w: 120, h: 120 });
    const r = computeInkRecenter(buf, 200, 200, 0, 0, 100, 100, 200);
    expect(r.inkFraction).toBeGreaterThan(0.08);
    expect(r.recenter).toBeNull();
  });

  it('is graceful on a blank (all-white) crop', () => {
    const buf = gray(200, 200, null);
    const r = computeInkRecenter(buf, 200, 200, 0, 0, 100, 100, 200);
    expect(r.inkCentroidSource).toBeNull();
    expect(r.inkFraction).toBe(0);
    expect(r.recenter).toBeNull();
  });

  it('maps the centroid to SOURCE coords via visibleLeft/visibleTop', () => {
    // Visible portion sits at source (500,300); blob at gray (10,10,20,20).
    const buf = gray(60, 60, { x: 10, y: 10, w: 20, h: 20 });
    const r = computeInkRecenter(buf, 60, 60, 500, 300, 530, 330, 60);
    expect(r.inkCentroidSource!.x).toBeCloseTo(519.5, 0); // 500 + 19.5
    expect(r.inkCentroidSource!.y).toBeCloseTo(319.5, 0); // 300 + 19.5
  });
});
