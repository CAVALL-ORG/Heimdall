import { describe, expect, it } from 'vitest';
import { coerceCropDims } from '../../src/mcp/tools/crop';

describe('coerceCropDims', () => {
  it('passes a valid square request unchanged', () => {
    expect(coerceCropDims({ w: 200, h: 200 })).toEqual({ n: 200, coerced: null });
  });
  it('accepts width/height aliases for w/h', () => {
    expect(coerceCropDims({ width: 300, height: 300 })).toEqual({ n: 300, coerced: null });
  });
  it('auto-squares a non-square request to min(w,h)', () => {
    const r = coerceCropDims({ w: 200, h: 300 });
    expect(r.n).toBe(200);
    expect(r.coerced).toMatch(/square/);
  });
  it('auto-clamps below the minimum to 150', () => {
    const r = coerceCropDims({ w: 100, h: 100 });
    expect(r.n).toBe(150);
    expect(r.coerced).toMatch(/clamp/);
  });
  it('auto-clamps above the maximum to 1200', () => {
    const r = coerceCropDims({ w: 5000, h: 5000 });
    expect(r.n).toBe(1200);
    expect(r.coerced).toMatch(/clamp/);
  });
  it('prefers w/h over width/height when both present', () => {
    expect(coerceCropDims({ w: 200, h: 200, width: 999, height: 999 }).n).toBe(200);
  });
});

import { nearestTarget } from '../../src/mcp/tools/row-state';

describe('nearestTarget', () => {
  const targets = [
    { record_id: 'a1', field: 'drawn_H', x_center: 100, y_center: 100, bbox_radius: 40, round: 1 },
    { record_id: 'a2', field: 'charge', x_center: 500, y_center: 500, bbox_radius: 40, round: 1 },
  ];
  it('returns the closest named target to a mis-centered crop', () => {
    expect(nearestTarget(targets, 120, 110)?.record_id).toBe('a1');
  });
  it('returns null for an empty target list', () => {
    expect(nearestTarget([], 0, 0)).toBeNull();
  });
});
