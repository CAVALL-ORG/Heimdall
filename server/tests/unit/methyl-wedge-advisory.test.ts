import { describe, it, expect } from 'vitest';
import {
  detectFusionMethylWedges,
  buildMethylWedgeAdvisory,
} from '../../src/adapter/graph-intent/stereo-advisory';

// Minimal graphs for the pure detector (not dense-gated).
function methylOnFusionCarbon() {
  // parent 1 sits in two declared rings (fusion); methyl 9 is its wedge target.
  return {
    atoms: [
      { id: 1, element: 'C' }, { id: 2, element: 'C' }, { id: 3, element: 'C' },
      { id: 4, element: 'C' }, { id: 5, element: 'C' }, { id: 6, element: 'C' },
      { id: 7, element: 'C' }, { id: 8, element: 'C' }, { id: 9, element: 'C' }, // 9 = methyl
    ],
    bonds: [
      { a: 1, b: 2, order: 1 }, { a: 2, b: 3, order: 1 }, { a: 3, b: 1, order: 1 },
      { a: 1, b: 4, order: 1 }, { a: 4, b: 5, order: 1 }, { a: 5, b: 1, order: 1 },
      { a: 1, b: 9, order: 1, wedge: 'hashed', wedge_from: 1 }, // methyl wedge on fusion C 1
    ],
    rings: [
      { id: 'rA', atoms: [1, 2, 3] },
      { id: 'rB', atoms: [1, 4, 5] }, // atom 1 in BOTH rings => fusion
    ],
    counts: {},
  };
}

describe('detectFusionMethylWedges', () => {
  it('fires on a wedge to a terminal methyl whose parent is a ring-fusion carbon', () => {
    expect(detectFusionMethylWedges(methylOnFusionCarbon())).toEqual([1]);
  });

  it('is silent when the parent lies in only ONE ring (the always-correct atom3 class)', () => {
    const g = methylOnFusionCarbon();
    g.rings = [{ id: 'rA', atoms: [1, 2, 3] }]; // parent 1 now in a single ring
    expect(detectFusionMethylWedges(g)).toEqual([]);
  });

  it('is silent on a wedge to a terminal HETEROATOM (OH), not a methyl', () => {
    const g = methylOnFusionCarbon();
    g.atoms[8] = { id: 9, element: 'O' };
    expect(detectFusionMethylWedges(g)).toEqual([]);
  });

  it('is silent on a wedge to a NON-terminal carbon (degree > 1)', () => {
    const g = methylOnFusionCarbon();
    g.bonds.push({ a: 9, b: 2, order: 1 }); // methyl now degree 2
    expect(detectFusionMethylWedges(g)).toEqual([]);
  });

  it('is silent when there is no wedge', () => {
    const g = methylOnFusionCarbon();
    g.bonds = g.bonds.map((b) => ({ a: b.a, b: b.b, order: b.order }));
    expect(detectFusionMethylWedges(g)).toEqual([]);
  });
});

describe('buildMethylWedgeAdvisory', () => {
  it('is null on a sparse (non-dense) draft even with a fusion methyl wedge', () => {
    expect(buildMethylWedgeAdvisory(methylOnFusionCarbon() as never)).toBeNull();
  });
});
