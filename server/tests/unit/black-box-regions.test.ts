import { describe, it, expect } from 'vitest';
import {
  validateBlackBoxRegions,
  checkBlackBoxFreeze,
  latchCommittedRegions,
  validateGraphIntent,
} from '../../src/adapter/graph-intent/validator';
import type { GraphIntent, BlackBoxRegion } from '../../src/types/graph-intent';

// Minimal GraphIntent shaped for the black-box checks (they read only
// atoms/bonds/black_box_regions). A small fused two-ring graph:
//   triangle R1 = {1,2,3}; atom 3 has a crossing bond 3-4 out to a chain 4-5.
function gi(over: Partial<GraphIntent>): GraphIntent {
  return {
    version: 1,
    atoms: [
      { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'R1' },
      { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'R1' },
      { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'R1' },
      { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 5, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
    ],
    bonds: [
      { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 3, b: 1, order: 1, wedge: null, wedge_from: null },
      { a: 3, b: 4, order: 1, wedge: null, wedge_from: null },
      { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 5, rings: 0, heteroatoms: {} },
    ...over,
  } as GraphIntent;
}

const goodRegion: BlackBoxRegion = {
  id: 'r1',
  boundary_atoms: [1, 2, 3],
  ports: [{ id: 'p1', boundary_atom: 3, order: 1 }],
  status: 'open',
};

describe('validateBlackBoxRegions — coherence (FP=0)', () => {
  it('absent carrier → no issues (back-compat / fast-on-easy)', () => {
    expect(validateBlackBoxRegions(gi({}))).toEqual([]);
    expect(validateBlackBoxRegions(gi({ black_box_regions: [] }))).toEqual([]);
  });

  it('valid region with a realized crossing port → no issues (FP=0 positive)', () => {
    expect(validateBlackBoxRegions(gi({ black_box_regions: [goodRegion] }))).toEqual([]);
  });

  it('boundary atom not in atoms[] → rejects', () => {
    const r = { ...goodRegion, boundary_atoms: [1, 2, 99] };
    const issues = validateBlackBoxRegions(gi({ black_box_regions: [r] }));
    expect(issues.some((i) => /boundary atom 99 not in atoms/.test(i.message))).toBe(true);
  });

  it('port boundary_atom not a region boundary member → rejects', () => {
    const r = { ...goodRegion, ports: [{ id: 'p1', boundary_atom: 4, order: 1 as const }] };
    const issues = validateBlackBoxRegions(gi({ black_box_regions: [r] }));
    expect(issues.some((i) => /not a member of region r1 boundary_atoms/.test(i.message))).toBe(true);
  });

  it('port with no realized crossing bond → rejects (self-contradiction)', () => {
    // boundary atom 1 has only in-boundary bonds (1-2, 1-3) — no crossing out.
    const r = { ...goodRegion, ports: [{ id: 'p1', boundary_atom: 1, order: 1 as const }] };
    const issues = validateBlackBoxRegions(gi({ black_box_regions: [r] }));
    expect(issues.some((i) => /no order-1 bond crosses out of region r1/.test(i.message))).toBe(true);
  });

  it('wrong declared crossing order → rejects', () => {
    // 3-4 is order 1; declaring the port order 2 has no matching crossing.
    const r = { ...goodRegion, ports: [{ id: 'p1', boundary_atom: 3, order: 2 as const }] };
    const issues = validateBlackBoxRegions(gi({ black_box_regions: [r] }));
    expect(issues.some((i) => /no order-2 bond crosses out/.test(i.message))).toBe(true);
  });

  it('duplicate region id → rejects', () => {
    const issues = validateBlackBoxRegions(
      gi({ black_box_regions: [goodRegion, { ...goodRegion }] }),
    );
    expect(issues.some((i) => /duplicate black_box region id r1/.test(i.message))).toBe(true);
  });
});

describe('checkBlackBoxFreeze — cross-round structural freeze', () => {
  const prior: BlackBoxRegion[] = [goodRegion];

  it('no prior → no issues', () => {
    expect(checkBlackBoxFreeze(undefined, gi({}))).toEqual([]);
    expect(checkBlackBoxFreeze([], gi({}))).toEqual([]);
  });

  it('monotonic ADD interior (boundary + ports intact) → ok', () => {
    // add interior atom 6 + bond 3-6; region preserved, now resolved.
    const current = gi({
      atoms: [
        ...gi({}).atoms,
        { id: 6, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null },
      ],
      bonds: [...gi({}).bonds, { a: 3, b: 6, order: 1, wedge: null, wedge_from: null }],
      black_box_regions: [{ ...goodRegion, status: 'resolved' }],
    });
    expect(checkBlackBoxFreeze(prior, current)).toEqual([]);
  });

  it('committed boundary atom deleted → freeze violation', () => {
    const current = gi({
      atoms: gi({}).atoms.filter((a) => a.id !== 2),
      black_box_regions: [goodRegion],
    });
    const issues = checkBlackBoxFreeze(prior, current);
    expect(issues.some((i) => /committed boundary atom 2 was deleted/.test(i.message))).toBe(true);
  });

  it('committed boundary atom dropped from region → freeze violation', () => {
    const current = gi({
      black_box_regions: [{ ...goodRegion, boundary_atoms: [1, 3] }],
    });
    const issues = checkBlackBoxFreeze(prior, current);
    expect(issues.some((i) => /committed boundary atom 2 was dropped/.test(i.message))).toBe(true);
  });

  it('committed port re-pointed → freeze violation', () => {
    const current = gi({
      black_box_regions: [{ ...goodRegion, ports: [{ id: 'p1', boundary_atom: 1, order: 1 }] }],
    });
    const issues = checkBlackBoxFreeze(prior, current);
    expect(issues.some((i) => /committed port p1 .*re-pointed or removed/.test(i.message))).toBe(true);
  });

  it('committed region removed → freeze violation', () => {
    const current = gi({ black_box_regions: [] });
    const issues = checkBlackBoxFreeze(prior, current);
    expect(issues.some((i) => /committed region r1 was removed/.test(i.message))).toBe(true);
  });
});

describe('latchCommittedRegions — only self-coherent rounds freeze (deadlock guard)', () => {
  const prior: BlackBoxRegion[] = [goodRegion];

  it('coherent current regions → latch them (early-freeze even while interior unresolved)', () => {
    // Same coherent perimeter, no freeze issues; interior may still be open.
    expect(
      latchCommittedRegions(undefined, gi({ black_box_regions: [goodRegion] }), []),
    ).toEqual([goodRegion]);
  });

  it('incoherent current regions (port with no crossing) → do NOT latch; keep prior', () => {
    // The deadlock root: a bad first commit must NOT become the frozen ref.
    const bad = { ...goodRegion, ports: [{ id: 'p1', boundary_atom: 1, order: 1 as const }] };
    // First-ever commit (no prior): nothing gets frozen → next round is free.
    expect(latchCommittedRegions(undefined, gi({ black_box_regions: [bad] }), [])).toBeUndefined();
    // With a good prior: the bad submission keeps the good prior, never the bad one.
    expect(latchCommittedRegions(prior, gi({ black_box_regions: [bad] }), [])).toEqual(prior);
  });

  it('freeze-violating round → keep prior (do not adopt the violating submission)', () => {
    const freezeIssues = [{ path: 'x', message: 'freeze violation: committed port re-pointed' }];
    expect(
      latchCommittedRegions(prior, gi({ black_box_regions: [goodRegion] }), freezeIssues),
    ).toEqual(prior);
  });

  it('omitted / empty regions → sticky (keep prior)', () => {
    expect(latchCommittedRegions(prior, gi({}), [])).toEqual(prior);
    expect(latchCommittedRegions(prior, gi({ black_box_regions: [] }), [])).toEqual(prior);
  });
});

describe('validateGraphIntent — black-box coherence is wired into the single-source enforcer', () => {
  // Confirms validateBlackBoxRegions runs inside validateGraphIntent, so the
  // check fires at BOTH validate_graph preflight AND the translator build path.
  it('valid full graph with no carrier → valid (back-compat)', () => {
    expect(validateGraphIntent(gi({})).valid).toBe(true);
  });
  it('valid full graph + valid region → valid', () => {
    expect(validateGraphIntent(gi({ black_box_regions: [goodRegion] })).valid).toBe(true);
  });
  it('valid full graph + incoherent region → invalid with the coherence message', () => {
    const r = { ...goodRegion, ports: [{ id: 'p1', boundary_atom: 1, order: 1 as const }] };
    const res = validateGraphIntent(gi({ black_box_regions: [r] }));
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.errors.some((e) => /no order-1 bond crosses out of region r1/.test(e.message))).toBe(true);
    }
  });
});
