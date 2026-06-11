/**
 * P4.9 — unit coverage for the post-expansion count recompute
 * (`recomputeCounts`, exercised through the public `expandShorthand`).
 *
 * The agent declares VISIBLE-node counts (the glyph is one node); after the
 * backend expands the glyph into its heavy-atom subgraph, the counts must be
 * recomputed to the true heavy/ring/heteroatom totals. These are pure (no
 * runtime/Ketcher) so they run in the fast unit suite; the e2e
 * (direct-shape-shorthand.e2e.test.ts) covers the full build+export round-trip.
 */
import { describe, expect, it } from 'vitest';
import { expandShorthand } from '../../src/adapter/graph-intent/shorthand-expand';
import type { GraphIntent, IntentAtom, IntentBond } from '../../src/types/graph-intent';

function atom(id: number, extra: Partial<IntentAtom> = {}): IntentAtom {
  return { id, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, ...extra };
}
function bond(a: number, b: number, order: 1 | 2 | 3 = 1): IntentBond {
  return { a, b, order, wedge: null, wedge_from: null };
}
function graphWith(atoms: IntentAtom[], bonds: IntentBond[], rings: GraphIntent['rings'] = []): GraphIntent {
  return {
    version: 1,
    label: 'shorthand-counts',
    atoms,
    bonds,
    rings,
    // Pre-expansion (VISIBLE-node) counts — intentionally wrong post-expansion
    // so the assertions prove recomputeCounts actually recounted.
    counts: { heavy: atoms.length, rings: rings.length, heteroatoms: {} },
  };
}

describe('expandShorthand recomputes counts after glyph decomposition', () => {
  it('OMe on benzene → 8 heavy (7 C + 1 O), 1 ring, heteroatoms {O:1}', () => {
    const g = graphWith(
      [
        atom(0, { ring: 'r1' }),
        atom(1, { ring: 'r1' }),
        atom(2, { ring: 'r1' }),
        atom(3, { ring: 'r1' }),
        atom(4, { ring: 'r1' }),
        atom(5, { ring: 'r1' }),
        atom(6, { shorthand: 'OMe' }),
      ],
      [
        bond(0, 1, 2), bond(1, 2), bond(2, 3, 2), bond(3, 4), bond(4, 5, 2),
        bond(5, 0), bond(0, 6),
      ],
      [{ id: 'r1', atoms: [0, 1, 2, 3, 4, 5], kind: 'kekule' }],
    );
    const out = expandShorthand(g);
    expect(out.counts.heavy).toBe(8);
    expect(out.counts.rings).toBe(1);
    expect(out.counts.heteroatoms).toEqual({ O: 1 });
  });

  it('Ph on a methyl → toluene: 7 C, 1 ring, no heteroatoms', () => {
    const g = graphWith([atom(0), atom(1, { shorthand: 'Ph' })], [bond(0, 1)]);
    const out = expandShorthand(g);
    expect(out.counts.heavy).toBe(7);
    expect(out.counts.rings).toBe(1);
    expect(out.counts.heteroatoms).toEqual({});
  });

  it('tBu on a methyl → 5 C, 0 rings, no heteroatoms', () => {
    const g = graphWith([atom(0), atom(1, { shorthand: 'tBu' })], [bond(0, 1)]);
    const out = expandShorthand(g);
    expect(out.counts.heavy).toBe(5);
    expect(out.counts.rings).toBe(0);
    expect(out.counts.heteroatoms).toEqual({});
  });

  it('no shorthand atom → counts unchanged (passthrough)', () => {
    const g = graphWith([atom(0), atom(1)], [bond(0, 1)]);
    const out = expandShorthand(g);
    expect(out.counts.heavy).toBe(2);
    expect(out.counts.rings).toBe(0);
  });
});
