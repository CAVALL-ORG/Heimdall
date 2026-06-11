import { describe, expect, it } from 'vitest';
import { planEZCoordinateLock } from '../../src/adapter/graph-intent/ez-coordinate-lock';
import type { FrozenCoords } from '../../src/adapter/graph-intent/stereo-transfer';
import type { GraphIntent, IntentAtom, IntentBond } from '../../src/types/graph-intent';

function atom(id: number, element = 'C'): IntentAtom {
  return { id, element, drawn_H: null, charge: 0, radical: 0, ring: null };
}
function bond(
  a: number,
  b: number,
  order: 1 | 2 | 3 = 1,
  geom?: 'cis' | 'trans',
): IntentBond {
  return { a, b, order, wedge: null, wedge_from: null, ...(geom ? { geom } : {}) };
}
function graphOf(atoms: IntentAtom[], bonds: IntentBond[]): GraphIntent {
  return {
    version: 1,
    label: 'test',
    atoms,
    bonds,
    rings: [],
    counts: { heavy: atoms.length, rings: 0, heteroatoms: {} },
  };
}

/**
 * Backbone:  n1(12) — a(10) == b(11) — n2(13) — 14
 * Axis a→b lies on y=0. n1 is fixed above (y=+1). n2/14 sit on whichever side
 * the scenario dictates. Stereocenter, when present, is parked on the a-side
 * (atom 12) so the clean half to reflect is the b-side {11,13,14}.
 */
function chainGraph(): { graph: GraphIntent } {
  const atoms = [atom(10), atom(11), atom(12), atom(13), atom(14)];
  const bonds = [
    bond(10, 11, 2, 'cis'),
    bond(10, 12, 1),
    bond(11, 13, 1),
    bond(13, 14, 1),
  ];
  return { graph: graphOf(atoms, bonds) };
}
const AXIS_COORDS = (n2y: number, n14y: number): FrozenCoords => ({
  10: { x: 0, y: 0 },
  11: { x: 1, y: 0 },
  12: { x: -0.5, y: 1 }, // n1 above the axis
  13: { x: 1.5, y: n2y }, // n2
  14: { x: 2.5, y: n14y },
});

describe('planEZCoordinateLock', () => {
  it('reflects the stereocenter-free half when declared cis but built trans', () => {
    const { graph } = chainGraph(); // bond 10=11 declared cis
    const frozen = AXIS_COORDS(-1, -1); // n2 below → currently trans
    const plan = planEZCoordinateLock({
      graph,
      frozenCoords: frozen,
      stereocenterIds: new Set([12]), // a-side carries the stereocenter
    });
    const rec = plan.records.find((r) => r.a === 10 && r.b === 11)!;
    expect(rec.action).toBe('reflected');
    expect(rec.reflectedHalf).toBe('b');
    // n2 (13) and 14 flip across y=0 → y becomes +1; a-side (10,12) untouched.
    const u13 = plan.updates.find((u) => u.id === 13)!;
    const u14 = plan.updates.find((u) => u.id === 14)!;
    expect(u13.y).toBeCloseTo(1);
    expect(u14.y).toBeCloseTo(1);
    expect(plan.updates.some((u) => u.id === 10 || u.id === 12)).toBe(false);
  });

  it('is a no-op when the built geometry already matches the declared cis', () => {
    const { graph } = chainGraph();
    const frozen = AXIS_COORDS(1, 1); // n2 above → already cis
    const plan = planEZCoordinateLock({
      graph,
      frozenCoords: frozen,
      stereocenterIds: new Set([12]),
    });
    const rec = plan.records.find((r) => r.a === 10 && r.b === 11)!;
    expect(rec.action).toBe('already_correct');
    expect(plan.updates).toHaveLength(0);
  });

  it('reflects when declared trans but built cis', () => {
    const atoms = [atom(10), atom(11), atom(12), atom(13), atom(14)];
    const bonds = [
      bond(10, 11, 2, 'trans'),
      bond(10, 12, 1),
      bond(11, 13, 1),
      bond(13, 14, 1),
    ];
    const graph = graphOf(atoms, bonds);
    const frozen = AXIS_COORDS(1, 1); // n2 above → currently cis, want trans
    const plan = planEZCoordinateLock({
      graph,
      frozenCoords: frozen,
      stereocenterIds: new Set([12]),
    });
    const rec = plan.records.find((r) => r.a === 10 && r.b === 11)!;
    expect(rec.action).toBe('reflected');
    const u13 = plan.updates.find((u) => u.id === 13)!;
    expect(u13.y).toBeCloseTo(-1);
  });

  it('skips a double bond inside a ring (no clean bipartition)', () => {
    // 10=11 in a 4-ring 10-11-13-12-10; removing 10-11 stays connected.
    const atoms = [atom(10), atom(11), atom(12), atom(13)];
    const bonds = [
      bond(10, 11, 2, 'cis'),
      bond(10, 12, 1),
      bond(12, 13, 1),
      bond(13, 11, 1),
    ];
    const graph = graphOf(atoms, bonds);
    const frozen: FrozenCoords = {
      10: { x: 0, y: 0 },
      11: { x: 1, y: 0 },
      12: { x: -0.5, y: 1 },
      13: { x: 1.5, y: -1 },
    };
    const plan = planEZCoordinateLock({ graph, frozenCoords: frozen, stereocenterIds: new Set() });
    const rec = plan.records.find((r) => r.a === 10 && r.b === 11)!;
    expect(rec.action).toBe('skipped');
    expect(rec.reason).toBe('ring_bond');
    expect(plan.updates).toHaveLength(0);
  });

  it('skips when an end is not 1,2-disubstituted (ambiguous reference)', () => {
    // b(11) has two heavy neighbors besides a → ambiguous cis/trans reference.
    const atoms = [atom(10), atom(11), atom(12), atom(13), atom(15)];
    const bonds = [
      bond(10, 11, 2, 'cis'),
      bond(10, 12, 1),
      bond(11, 13, 1),
      bond(11, 15, 1),
    ];
    const graph = graphOf(atoms, bonds);
    const frozen: FrozenCoords = {
      10: { x: 0, y: 0 },
      11: { x: 1, y: 0 },
      12: { x: -0.5, y: 1 },
      13: { x: 1.5, y: -1 },
      15: { x: 1.5, y: 1 },
    };
    const plan = planEZCoordinateLock({ graph, frozenCoords: frozen, stereocenterIds: new Set() });
    const rec = plan.records.find((r) => r.a === 10 && r.b === 11)!;
    expect(rec.action).toBe('skipped');
    expect(rec.reason).toBe('not_disubstituted');
  });

  it('skips when both halves carry a stereocenter (sandwiched E/Z)', () => {
    const { graph } = chainGraph();
    const frozen = AXIS_COORDS(-1, -1); // mismatch (declared cis, built trans)
    const plan = planEZCoordinateLock({
      graph,
      frozenCoords: frozen,
      stereocenterIds: new Set([12, 13]), // both halves carry stereo
    });
    const rec = plan.records.find((r) => r.a === 10 && r.b === 11)!;
    expect(rec.action).toBe('skipped');
    expect(rec.reason).toBe('between_stereocenters');
    expect(plan.updates).toHaveLength(0);
  });

  it('returns an empty plan when there are no declared-geom bonds', () => {
    const atoms = [atom(10), atom(11)];
    const bonds = [bond(10, 11, 2)];
    const plan = planEZCoordinateLock({
      graph: graphOf(atoms, bonds),
      frozenCoords: { 10: { x: 0, y: 0 }, 11: { x: 1, y: 0 } },
      stereocenterIds: new Set(),
    });
    expect(plan.records).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
  });
});
