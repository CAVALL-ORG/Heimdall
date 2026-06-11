import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fusedRingPairs, isDenseDraft, isDenseCandidate, hasWedgeStereo } from '../../src/adapter/graph-intent/dense-signal';

// ─────────────────────────────────────────────────────────────────────
// Dense signal (plan 2026-05-31-dense-vision-targeted-readback §4.1).
//   isDenseDraft := fusedRingPairs >= 2 AND atoms.length >= 18
//   fusedRingPairs := unordered ring pairs sharing >= 2 declared atom ids.
// Gates the dense zoom-verify instruction + the crop-gate relaxation.
// Pure + deterministic; the FP-safe "fast on easy" guarantee lives here.
// ─────────────────────────────────────────────────────────────────────

const ring = (...atoms: number[]) => ({ atoms });
const atomsN = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));

describe('fusedRingPairs', () => {
  it('two rings sharing >=2 atoms (fused edge) = 1 pair', () => {
    expect(fusedRingPairs([ring(1, 2, 3, 4, 5, 6), ring(5, 6, 7, 8, 9, 10)])).toBe(1);
  });

  it('two rings sharing exactly 1 atom (spiro) = 0 pairs', () => {
    expect(fusedRingPairs([ring(1, 2, 3, 4, 5, 6), ring(6, 7, 8, 9, 10, 11)])).toBe(0);
  });

  it('two disjoint rings = 0 pairs', () => {
    expect(fusedRingPairs([ring(1, 2, 3, 4, 5, 6), ring(7, 8, 9, 10, 11, 12)])).toBe(0);
  });

  it('three linearly-fused rings = 2 pairs (anthracene-like)', () => {
    expect(
      fusedRingPairs([ring(1, 2, 3, 4, 5, 6), ring(4, 5, 7, 8, 9, 10), ring(8, 9, 11, 12, 13, 14)]),
    ).toBe(2);
  });

  it('empty / single ring = 0 pairs', () => {
    expect(fusedRingPairs([])).toBe(0);
    expect(fusedRingPairs([ring(1, 2, 3, 4, 5, 6)])).toBe(0);
  });
});

describe('isDenseDraft', () => {
  it('benzene (1 ring, 6 heavy) = NOT dense', () => {
    expect(isDenseDraft({ atoms: atomsN(6), rings: [ring(1, 2, 3, 4, 5, 6)] })).toBe(false);
  });

  it('fused bicyclic naphthalene (fp1, 10 heavy) = NOT dense', () => {
    expect(
      isDenseDraft({ atoms: atomsN(10), rings: [ring(1, 2, 3, 4, 5, 6), ring(5, 6, 7, 8, 9, 10)] }),
    ).toBe(false);
  });

  it('small fused cage (fp2 but only 12 heavy) = NOT dense (heavy floor exempts tiny clear cages)', () => {
    const cage = [ring(1, 2, 3, 4, 5, 6), ring(4, 5, 7, 8, 9, 10), ring(8, 9, 11, 12, 1, 2)];
    expect(fusedRingPairs(cage)).toBeGreaterThanOrEqual(2);
    expect(isDenseDraft({ atoms: atomsN(12), rings: cage })).toBe(false);
  });

  it('large fused polycycle (fp2, 20 heavy) = DENSE', () => {
    expect(
      isDenseDraft({
        atoms: atomsN(20),
        rings: [ring(1, 2, 3, 4, 5, 6), ring(4, 5, 7, 8, 9, 10), ring(8, 9, 11, 12, 13, 14)],
      }),
    ).toBe(true);
  });

  it('committed A011H fixture (fp3, 35 heavy) = DENSE', () => {
    const a011h = JSON.parse(
      readFileSync(fileURLToPath(new URL('../fixtures/ez/A011H.graph.json', import.meta.url)), 'utf8'),
    );
    expect(fusedRingPairs(a011h.rings)).toBe(3);
    expect(a011h.atoms.length).toBeGreaterThanOrEqual(18);
    expect(isDenseDraft(a011h)).toBe(true);
  });
});

describe('isDenseCandidate', () => {
  it('18 heavy atoms, no rings declared = CANDIDATE (declaration-independent)', () => {
    expect(isDenseCandidate({ atoms: atomsN(18), rings: [] })).toBe(true);
  });

  it('62 heavy atoms = CANDIDATE', () => {
    expect(isDenseCandidate({ atoms: atomsN(62), rings: [] })).toBe(true);
  });

  it('6 heavy atoms (I001/I015 floor) = NOT a candidate', () => {
    expect(isDenseCandidate({ atoms: atomsN(6), rings: [] })).toBe(false);
  });

  it('17 heavy atoms (one below floor) = NOT a candidate', () => {
    expect(isDenseCandidate({ atoms: atomsN(17), rings: [] })).toBe(false);
  });
});

describe('hasWedgeStereo', () => {
  it('true when a bond carries a wedge', () => {
    expect(hasWedgeStereo({
      atoms: [{}, {}],
      bonds: [{ wedge: 'solid' }, { wedge: null }],
    })).toBe(true);
  });
  it('true when an atom carries wedge_to_implicit_h', () => {
    expect(hasWedgeStereo({
      atoms: [{ wedge_to_implicit_h: 'hashed' }],
      bonds: [{ wedge: null }],
    })).toBe(true);
  });
  it('false for an E/Z-only or wedgeless graph', () => {
    expect(hasWedgeStereo({
      atoms: [{}, {}],
      bonds: [{ wedge: null }, { wedge: null, geom: 'cis' }],
    })).toBe(false);
  });
});
