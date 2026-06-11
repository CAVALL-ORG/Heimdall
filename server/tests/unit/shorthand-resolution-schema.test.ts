/**
 * ADR-0002 (W1) — `shorthand_resolution` provenance schema field.
 *
 * Covers the additive optional field + its pure-structural rules
 * (`intentAtomSchema`'s superRefine): legend_ref present iff
 * source==='paper_legend', and shorthand_resolution may only ride an atom that
 * also carries `shorthand`. Asserts real zod parse accept/reject, not mocks.
 *
 * The table-collision rule (semantic — needs the table) is validator-path and
 * is covered in `validate-graph.test.ts`, not here.
 */
import { describe, expect, it } from 'vitest';
import {
  graphIntentSchema,
  shorthandResolutionSchema,
  type ShorthandExpansion,
} from '../../src/types/graph-intent';

// An off-table-shaped expansion (TBS = Si(CH3)2C(CH3)3) in the same table-entry
// shape decomposeShorthand() returns. Atom ids are LOCAL (0-indexed).
const tbsExpansion: ShorthandExpansion = {
  atoms: [
    { element: 'Si' },
    { element: 'C', drawn_H: 3 },
    { element: 'C', drawn_H: 3 },
    { element: 'C' },
    { element: 'C', drawn_H: 3 },
    { element: 'C', drawn_H: 3 },
    { element: 'C', drawn_H: 3 },
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
};

// Build a one-bond GraphIntent: a carbon (id 0) bonded to a glyph atom (id 1).
// `atomOverrides` patches atom 1 (the glyph carrier) so each test sets exactly
// the shorthand / shorthand_resolution combination under test.
const graphWithGlyphAtom = (atomOverrides: Record<string, unknown>) => ({
  version: 1 as const,
  atoms: [
    { id: 0, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
    {
      id: 1,
      element: 'C',
      drawn_H: null,
      charge: 0,
      radical: 0,
      ring: null,
      ...atomOverrides,
    },
  ],
  bonds: [{ a: 0, b: 1, order: 1, wedge: null, wedge_from: null }],
  rings: [],
  // The glyph node is opaque → heteroatoms {} as the agent SEES it.
  counts: { heavy: 2, rings: 0, heteroatoms: {} },
});

describe('shorthand_resolution schema (ADR-0002 W1)', () => {
  it('table-only graph with no shorthand_resolution still parses (back-compat)', () => {
    const g = graphWithGlyphAtom({ shorthand: 'OMe' });
    expect(graphIntentSchema.safeParse(g).success).toBe(true);

    // A graph with neither shorthand nor resolution parses identically.
    const plain = graphWithGlyphAtom({});
    expect(graphIntentSchema.safeParse(plain).success).toBe(true);
  });

  it('well-formed agent_inference resolution (expansion, no legend_ref) parses', () => {
    const g = graphWithGlyphAtom({
      shorthand: 'TBS',
      shorthand_resolution: {
        source: 'agent_inference',
        expansion: tbsExpansion,
        note: 'silyl protecting group from chemistry knowledge',
      },
    });
    const r = graphIntentSchema.safeParse(g);
    expect(r.success).toBe(true);
  });

  it('well-formed paper_legend resolution (with legend_ref) parses', () => {
    const g = graphWithGlyphAtom({
      shorthand: 'OPP',
      shorthand_resolution: {
        source: 'paper_legend',
        expansion: tbsExpansion, // shape-only; identity irrelevant to schema
        legend_ref: 'dict#3',
      },
    });
    const r = graphIntentSchema.safeParse(g);
    expect(r.success).toBe(true);
  });

  it('rejects paper_legend WITHOUT legend_ref', () => {
    const g = graphWithGlyphAtom({
      shorthand: 'OPP',
      shorthand_resolution: {
        source: 'paper_legend',
        expansion: tbsExpansion,
      },
    });
    const r = graphIntentSchema.safeParse(g);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /legend_ref is required/.test(i.message)),
      ).toBe(true);
    }
  });

  it('rejects agent_inference WITH legend_ref', () => {
    const g = graphWithGlyphAtom({
      shorthand: 'TBS',
      shorthand_resolution: {
        source: 'agent_inference',
        expansion: tbsExpansion,
        legend_ref: 'dict#3',
      },
    });
    const r = graphIntentSchema.safeParse(g);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /legend_ref is forbidden/.test(i.message)),
      ).toBe(true);
    }
  });

  it('rejects shorthand_resolution on an atom with no shorthand', () => {
    const g = graphWithGlyphAtom({
      // no `shorthand` field set on the glyph carrier
      shorthand_resolution: {
        source: 'agent_inference',
        expansion: tbsExpansion,
      },
    });
    const r = graphIntentSchema.safeParse(g);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /requires `shorthand`/.test(i.message)),
      ).toBe(true);
    }
  });

  it('rejects an unknown source value (strict union)', () => {
    const g = graphWithGlyphAtom({
      shorthand: 'TBS',
      shorthand_resolution: {
        source: 'memory',
        expansion: tbsExpansion,
      },
    });
    expect(graphIntentSchema.safeParse(g).success).toBe(false);
  });

  it('rejects an extra/unknown field on shorthand_resolution (strict)', () => {
    const g = graphWithGlyphAtom({
      shorthand: 'TBS',
      shorthand_resolution: {
        source: 'agent_inference',
        expansion: tbsExpansion,
        bogus: true,
      },
    });
    expect(graphIntentSchema.safeParse(g).success).toBe(false);
  });

  it('shorthandResolutionSchema itself accepts a minimal agent_inference entry', () => {
    const r = shorthandResolutionSchema.safeParse({
      source: 'agent_inference',
      expansion: { atoms: [{ element: 'C', drawn_H: 3 }], bonds: [], attachment_atom_offset: 0 },
    });
    expect(r.success).toBe(true);
  });
});
