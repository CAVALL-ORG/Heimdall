import { describe, it, expect } from 'vitest';
import { detectDegenerateStereoGeometry } from '../../src/adapter/graph-intent/detect-degenerate-stereo';

// Coordinate-fidelity advisory (plan 2026-06-03-stereocenter-coordinate-fidelity-plan
// Lever A, detect-only). A dense wedge stereocenter whose two IN-PLANE neighbors
// (drawn neighbors minus the wedge target) are near-collinear (~180° apart) has an
// ill-conditioned 2D frame → Indigo decodes the wrong R/S even with a correct wedge
// stroke (A009 atom 19 = 177.5°). The detector flags those centers so the agent
// re-reads the in-plane bond DIRECTIONS from a crop. Advisory only — never changes
// the SMILES. Honest limit: it must NOT fire on A011's 23°-off center (no backend
// lever catches that; only an agent angle does).

// place a neighbor at `deg` degrees, radius 10, from a center at origin
function at(deg: number): { x: number; y: number } {
  const r = (deg * Math.PI) / 180;
  return { x: 10 * Math.cos(r), y: 10 * Math.sin(r) };
}

describe('detectDegenerateStereoGeometry (Lever A detector)', () => {
  it('flags a center whose in-plane pair is near-collinear (A009 atom 19, 177.5°)', () => {
    const coords: Record<number, { x: number; y: number }> = {
      1: { x: 0, y: 0 }, // center
      2: at(0),
      3: at(177.5),
    };
    const out = detectDegenerateStereoGeometry(
      [1],
      () => [2, 3],
      (id) => coords[id],
    );
    expect(out).toHaveLength(1);
    expect(out[0].center).toBe(1);
    expect(out[0].collinear).toBe(true);
    expect(out[0].minSeparationToStraight).toBeCloseTo(2.5, 1);
  });

  it('does NOT flag a clean trigonal center (neighbors 120° apart)', () => {
    const coords: Record<number, { x: number; y: number }> = {
      1: { x: 0, y: 0 },
      2: at(0),
      3: at(120),
    };
    const out = detectDegenerateStereoGeometry([1], () => [2, 3], (id) => coords[id]);
    expect(out).toHaveLength(0);
  });

  it('does NOT flag A011-style 23°-off center (honest limit: detector cannot catch it)', () => {
    const coords: Record<number, { x: number; y: number }> = {
      1: { x: 0, y: 0 },
      2: at(0),
      3: at(156.8), // 23.2° from collinear
    };
    const out = detectDegenerateStereoGeometry([1], () => [2, 3], (id) => coords[id]);
    expect(out).toHaveLength(0);
  });

  it('skips a center with fewer than 2 in-plane neighbors (no pair to test)', () => {
    const coords: Record<number, { x: number; y: number }> = {
      1: { x: 0, y: 0 },
      2: at(45),
    };
    const out = detectDegenerateStereoGeometry([1], () => [2], (id) => coords[id]);
    expect(out).toHaveLength(0);
  });

  it('skips gracefully when a neighbor coord is missing', () => {
    const coords: Record<number, { x: number; y: number }> = {
      1: { x: 0, y: 0 },
      2: at(0),
      // 3 missing
    };
    const out = detectDegenerateStereoGeometry([1], () => [2, 3], (id) => coords[id]);
    expect(out).toHaveLength(0);
  });
});
