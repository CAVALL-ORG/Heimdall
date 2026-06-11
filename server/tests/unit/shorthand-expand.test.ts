/**
 * Task 5F — pre-expansion of shorthand-glyph atoms on the direct GraphIntent
 * path. Pure-function coverage for `shorthand-expand.ts`: glyph atoms are
 * replaced by their decomposed heavy-atom subgraph, external bonds re-wire to
 * the attachment anchor, and counts are recomputed for the expanded graph.
 */
import { describe, expect, it } from 'vitest';
import {
  expandShorthand,
  findUnknownShorthand,
  findInvalidShorthandExpansion,
  hasShorthand,
  isShorthandAtom,
} from '../../src/adapter/graph-intent/shorthand-expand';
import type { GraphIntent } from '../../src/types/graph-intent';

// Benzene ring (6 C) with a single carbon carrying an `OMe` glyph node (id 6).
// As the agent SEES it: 7 visible nodes (6 ring C + 1 OMe glyph), 1 ring,
// heteroatoms {} (the O is opaque inside the glyph).
function anisoleViaGlyph(): GraphIntent {
  return {
    version: 1,
    label: 'anisole-via-OMe-glyph',
    atoms: [
      { id: 0, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
      { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
      { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
      { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
      { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
      { id: 5, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
      // Shorthand glyph node: element is an ignored placeholder.
      { id: 6, element: 'C', shorthand: 'OMe', drawn_H: null, charge: 0, radical: 0, ring: null },
    ],
    bonds: [
      { a: 0, b: 1, order: 1, wedge: null, wedge_from: null },
      { a: 1, b: 2, order: 2, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 3, b: 4, order: 2, wedge: null, wedge_from: null },
      { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
      { a: 5, b: 0, order: 2, wedge: null, wedge_from: null },
      // ring carbon 0 → OMe glyph
      { a: 0, b: 6, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [
      { id: 'r1', atoms: [0, 1, 2, 3, 4, 5], kind: 'kekule' },
    ],
    counts: { heavy: 7, rings: 1, heteroatoms: {} },
  };
}

describe('shorthand-expand (Task 5F)', () => {
  it('isShorthandAtom / hasShorthand detect the glyph carrier', () => {
    const g = anisoleViaGlyph();
    expect(hasShorthand(g)).toBe(true);
    expect(isShorthandAtom(g.atoms[6])).toBe(true);
    expect(isShorthandAtom(g.atoms[0])).toBe(false);
    expect(isShorthandAtom({ shorthand: '   ' })).toBe(false);
  });

  it('expands OMe glyph into O + CH3, re-wires the ring bond to O, recomputes counts', () => {
    const expanded = expandShorthand(anisoleViaGlyph());

    // 6 ring C + (O + CH3) = 8 heavy atoms; the glyph node (id 6) is gone.
    expect(expanded.atoms).toHaveLength(8);
    expect(expanded.atoms.some((a) => a.id === 6)).toBe(false);

    // Exactly one O appeared (the OMe oxygen) plus one CH3 carbon.
    const oxygens = expanded.atoms.filter((a) => a.element === 'O');
    expect(oxygens).toHaveLength(1);
    const methyl = expanded.atoms.find((a) => a.element === 'C' && a.drawn_H === 3);
    expect(methyl).toBeDefined();

    // The ring carbon 0 is now bonded to the O (attachment anchor), not to a
    // dangling id-6. Find the bond that used to be 0–6.
    const oId = oxygens[0].id;
    const ringToO = expanded.bonds.find(
      (b) => (b.a === 0 && b.b === oId) || (b.a === oId && b.b === 0),
    );
    expect(ringToO).toBeDefined();

    // O–CH3 internal bond is present.
    const oToMethyl = expanded.bonds.find(
      (b) =>
        (b.a === oId && b.b === methyl!.id) ||
        (b.a === methyl!.id && b.b === oId),
    );
    expect(oToMethyl).toBeDefined();

    // Counts recomputed for the EXPANDED graph: 8 heavy, 1 ring, O:1.
    expect(expanded.counts.heavy).toBe(8);
    expect(expanded.counts.rings).toBe(1);
    expect(expanded.counts.heteroatoms).toEqual({ O: 1 });
  });

  it('expands Ph glyph into a 6-membered carbon ring (recomputes 2 rings total)', () => {
    const g: GraphIntent = {
      version: 1,
      atoms: [
        { id: 0, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
        { id: 1, element: 'C', shorthand: 'Ph', drawn_H: null, charge: 0, radical: 0, ring: null },
      ],
      bonds: [{ a: 0, b: 1, order: 1, wedge: null, wedge_from: null }],
      rings: [],
      counts: { heavy: 2, rings: 0, heteroatoms: {} },
    };
    const expanded = expandShorthand(g);
    // 1 methyl C + 6 phenyl C = 7 heavy atoms.
    expect(expanded.atoms).toHaveLength(7);
    expect(expanded.atoms.every((a) => a.element === 'C')).toBe(true);
    // One ring contributed by the phenyl.
    expect(expanded.counts.heavy).toBe(7);
    expect(expanded.counts.rings).toBe(1);
  });

  it('does not mutate the input graph', () => {
    const g = anisoleViaGlyph();
    const before = JSON.parse(JSON.stringify(g));
    expandShorthand(g);
    expect(g).toEqual(before);
  });

  it('passes a shorthand-free graph through unchanged', () => {
    const g: GraphIntent = {
      version: 1,
      atoms: [
        { id: 0, element: 'C', drawn_H: 4, charge: 0, radical: 0, ring: null },
      ],
      bonds: [],
      rings: [],
      counts: { heavy: 1, rings: 0, heteroatoms: {} },
    };
    expect(expandShorthand(g)).toBe(g);
  });

  it('findUnknownShorthand flags only unresolvable glyph text', () => {
    const g: GraphIntent = {
      version: 1,
      atoms: [
        { id: 0, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 1, element: 'C', shorthand: 'OMe', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 2, element: 'C', shorthand: 'Xyz', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 3, element: 'C', shorthand: '13C', drawn_H: null, charge: 0, radical: 0, ring: null },
      ],
      bonds: [
        { a: 0, b: 1, order: 1, wedge: null, wedge_from: null },
        { a: 0, b: 2, order: 1, wedge: null, wedge_from: null },
        { a: 0, b: 3, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [],
      counts: { heavy: 4, rings: 0, heteroatoms: {} },
    };
    const unknown = findUnknownShorthand(g);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toEqual({ atomId: 2, text: 'Xyz' });
  });

  it('throws if expandShorthand is reached with an unknown glyph (backend-bug guard)', () => {
    const g: GraphIntent = {
      version: 1,
      atoms: [
        { id: 0, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 1, element: 'C', shorthand: 'Xyz', drawn_H: null, charge: 0, radical: 0, ring: null },
      ],
      bonds: [{ a: 0, b: 1, order: 1, wedge: null, wedge_from: null }],
      rings: [],
      counts: { heavy: 2, rings: 0, heteroatoms: {} },
    };
    expect(() => expandShorthand(g)).toThrow(/unknown shorthand/i);
  });
});

// ── ADR-0002 (W2a) — declared shorthand_resolution.expansion consumption ─────
// An OFF-table glyph that carries a valid `shorthand_resolution.expansion`
// (the table-entry-shaped subgraph the agent declared) is no longer "unknown":
// the translator splices the declared expansion through the SAME path table
// entries take. A glyph WITHOUT a resolution still fails closed (unchanged).

// Phenol carbon (id 0) carrying an off-table `TBS` glyph (id 1) whose declared
// expansion is the SiMe2-tBu silyl group. Local expansion shape (matches the
// W1 schema / decomposeShorthand return):
//   atoms[0] Si (attachment), [1] CH3, [2] CH3, [3] C(quaternary), [4..6] CH3
//   bonds wire Si–CH3 ×2 + Si–Cq + Cq–CH3 ×3; attachment_atom_offset = 0 (Si).
function tbsOnCarbon(): GraphIntent {
  return {
    version: 1,
    label: 'tbs-via-declared-expansion',
    atoms: [
      { id: 0, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
      {
        id: 1,
        element: 'C',
        shorthand: 'TBS',
        drawn_H: null,
        charge: 0,
        radical: 0,
        ring: null,
        shorthand_resolution: {
          source: 'paper_legend',
          legend_ref: 'dict#1',
          expansion: {
            atoms: [
              { element: 'Si' }, // 0 — attachment
              { element: 'C', drawn_H: 3 }, // 1
              { element: 'C', drawn_H: 3 }, // 2
              { element: 'C', drawn_H: 0 }, // 3 — quaternary C
              { element: 'C', drawn_H: 3 }, // 4
              { element: 'C', drawn_H: 3 }, // 5
              { element: 'C', drawn_H: 3 }, // 6
            ],
            bonds: [
              { a: 0, b: 1, order: 1 },
              { a: 0, b: 2, order: 1 },
              { a: 0, b: 3, order: 1 },
              { a: 3, b: 4, order: 1 },
              { a: 3, b: 5, order: 1 },
              { a: 3, b: 6, order: 1 },
            ],
            attachment_atom_offset: 0,
          },
        },
      },
    ],
    bonds: [{ a: 0, b: 1, order: 1, wedge: null, wedge_from: null }],
    rings: [],
    counts: { heavy: 2, rings: 0, heteroatoms: {} },
  };
}

describe('shorthand-expand declared resolution (W2a)', () => {
  it('expandShorthand splices a declared off-table expansion (TBS → Si + 6 C), re-wires the external bond to the attachment atom', () => {
    const expanded = expandShorthand(tbsOnCarbon());

    // anchor CH3 (id 0) + 7 expansion atoms (Si + 6 C) = 8 heavy atoms; the
    // glyph node (id 1) is gone.
    expect(expanded.atoms).toHaveLength(8);
    expect(expanded.atoms.some((a) => a.id === 1)).toBe(false);

    // Exactly one Si appeared (the silyl attachment atom).
    const silicons = expanded.atoms.filter((a) => a.element === 'Si');
    expect(silicons).toHaveLength(1);
    const siId = silicons[0].id;

    // anchor CH3 + 6 expansion C = 7 carbons.
    expect(expanded.atoms.filter((a) => a.element === 'C')).toHaveLength(7);

    // The external bond (anchor C id 0 → glyph) re-wired to the Si attachment.
    const anchorToSi = expanded.bonds.find(
      (b) => (b.a === 0 && b.b === siId) || (b.a === siId && b.b === 0),
    );
    expect(anchorToSi).toBeDefined();

    // Si has 3 internal expansion bonds (2 methyls + quaternary C) plus the 1
    // external anchor bond = degree 4.
    const siDegree = expanded.bonds.filter(
      (b) => b.a === siId || b.b === siId,
    ).length;
    expect(siDegree).toBe(4);

    // Counts recomputed for the expanded graph: 8 heavy, 0 rings, Si:1.
    expect(expanded.counts.heavy).toBe(8);
    expect(expanded.counts.rings).toBe(0);
    expect(expanded.counts.heteroatoms).toEqual({ Si: 1 });
  });

  it('does not mutate the input graph when splicing a declared expansion', () => {
    const g = tbsOnCarbon();
    const before = JSON.parse(JSON.stringify(g));
    expandShorthand(g);
    expect(g).toEqual(before);
  });

  it('findUnknownShorthand does NOT flag an off-table glyph WITH a resolution, but DOES flag one WITHOUT', () => {
    const withRes = tbsOnCarbon();
    expect(findUnknownShorthand(withRes)).toHaveLength(0);

    // Same off-table glyph with the resolution stripped → still flagged.
    const withoutRes: GraphIntent = {
      ...withRes,
      atoms: withRes.atoms.map((a) =>
        a.id === 1
          ? { id: 1, element: 'C', shorthand: 'TBS', drawn_H: null, charge: 0, radical: 0, ring: null }
          : a,
      ),
    };
    const flagged = findUnknownShorthand(withoutRes);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toEqual({ atomId: 1, text: 'TBS' });
  });

  it('table glyph wins even if a resolution is somehow also present (no crash, uses table)', () => {
    // OMe IS in the table; a resolution is redundant (validate rejects it at
    // preflight) but expandShorthand must not crash if it reaches here — the
    // table expansion is used.
    const g: GraphIntent = {
      version: 1,
      atoms: [
        { id: 0, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
        {
          id: 1,
          element: 'C',
          shorthand: 'OMe',
          drawn_H: null,
          charge: 0,
          radical: 0,
          ring: null,
          shorthand_resolution: {
            source: 'agent_inference',
            expansion: {
              // Deliberately WRONG expansion (N instead of O) to prove the
              // table — not the resolution — is used for a table glyph.
              atoms: [{ element: 'N' }, { element: 'C', drawn_H: 3 }],
              bonds: [{ a: 0, b: 1, order: 1 }],
              attachment_atom_offset: 0,
            },
          },
        },
      ],
      bonds: [{ a: 0, b: 1, order: 1, wedge: null, wedge_from: null }],
      rings: [],
      counts: { heavy: 2, rings: 0, heteroatoms: {} },
    };
    const expanded = expandShorthand(g);
    // Table OMe → O + CH3 used (not the bogus N from the resolution).
    expect(expanded.atoms.filter((a) => a.element === 'O')).toHaveLength(1);
    expect(expanded.atoms.filter((a) => a.element === 'N')).toHaveLength(0);
  });
});

describe('shorthand-expand referential-integrity of a declared expansion (W2a)', () => {
  // An off-table glyph whose declared expansion has a bond index out of range.
  function badBondIndex(): GraphIntent {
    return {
      version: 1,
      atoms: [
        { id: 0, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
        {
          id: 1,
          element: 'C',
          shorthand: 'ZZZ',
          drawn_H: null,
          charge: 0,
          radical: 0,
          ring: null,
          shorthand_resolution: {
            source: 'agent_inference',
            expansion: {
              atoms: [{ element: 'O' }, { element: 'C', drawn_H: 3 }],
              // bond b=5 is out of range for a 2-atom expansion.
              bonds: [{ a: 0, b: 5, order: 1 }],
              attachment_atom_offset: 0,
            },
          },
        },
      ],
      bonds: [{ a: 0, b: 1, order: 1, wedge: null, wedge_from: null }],
      rings: [],
      counts: { heavy: 2, rings: 0, heteroatoms: {} },
    };
  }

  // An off-table glyph whose declared expansion has an attachment offset out of
  // range.
  function badAttachmentOffset(): GraphIntent {
    return {
      version: 1,
      atoms: [
        { id: 0, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
        {
          id: 1,
          element: 'C',
          shorthand: 'ZZZ',
          drawn_H: null,
          charge: 0,
          radical: 0,
          ring: null,
          shorthand_resolution: {
            source: 'agent_inference',
            expansion: {
              atoms: [{ element: 'O' }, { element: 'C', drawn_H: 3 }],
              bonds: [{ a: 0, b: 1, order: 1 }],
              // offset 9 is out of range for a 2-atom expansion.
              attachment_atom_offset: 9,
            },
          },
        },
      ],
      bonds: [{ a: 0, b: 1, order: 1, wedge: null, wedge_from: null }],
      rings: [],
      counts: { heavy: 2, rings: 0, heteroatoms: {} },
    };
  }

  it('findInvalidShorthandExpansion catches an out-of-range bond index', () => {
    const issues = findInvalidShorthandExpansion(badBondIndex());
    expect(issues).toHaveLength(1);
    expect(issues[0].atomId).toBe(1);
    expect(issues[0].text).toBe('ZZZ');
  });

  it('findInvalidShorthandExpansion catches an out-of-range attachment_atom_offset', () => {
    const issues = findInvalidShorthandExpansion(badAttachmentOffset());
    expect(issues).toHaveLength(1);
    expect(issues[0].atomId).toBe(1);
  });

  it('findInvalidShorthandExpansion is clean for a valid declared expansion', () => {
    expect(findInvalidShorthandExpansion(tbsOnCarbon())).toHaveLength(0);
  });

  it('expandShorthand defensively throws on a malformed declared expansion (out-of-range bond)', () => {
    expect(() => expandShorthand(badBondIndex())).toThrow(/expansion/i);
  });

  it('expandShorthand defensively throws on a bad attachment_atom_offset', () => {
    expect(() => expandShorthand(badAttachmentOffset())).toThrow(/expansion/i);
  });
});
