import { describe, expect, it } from 'vitest';
import { validateGraphPure } from '../../src/mcp/tools/validate';
import { validateGraphIntent } from '../../src/adapter/graph-intent/validator';

const baseAtom = (
  id: number,
  element: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  element,
  drawn_H: null as number | null,
  charge: 0,
  radical: 0 as 0 | 1 | 2,
  ring: null as string | null,
  ...extra,
});

// Wave-2 Task 3 — validate_graph now delegates its structural verdict to
// validateGraphIntent (the build-path enforcer, single source of truth).
// That enforcer cross-checks heteroatom totals, so the helper derives the
// heteroatoms map from the atoms instead of hard-coding `{}`. Pre-delegation
// validate_graph never checked heteroatom totals on the direct path, so it
// silently accepted intents the build path would reject; these fixtures are
// now honest about the heteroatoms their atoms imply. (Halogens bucket under
// `halogens`, matching the enforcer's HALOGEN_ELEMENTS folding.)
const HALOGENS = new Set(['F', 'Cl', 'Br', 'I']);
const heteroFromAtoms = (
  atoms: ReturnType<typeof baseAtom>[],
): Record<string, number> => {
  const hetero: Record<string, number> = {};
  for (const a of atoms) {
    if (a.element === 'C') continue;
    const key = HALOGENS.has(a.element) ? 'halogens' : a.element;
    hetero[key] = (hetero[key] ?? 0) + 1;
  }
  return hetero;
};

const baseGraphIntent = (
  atoms: ReturnType<typeof baseAtom>[],
  bonds: Array<{ a: number; b: number; order: 1 | 2 | 3; wedge?: 'solid' | 'hashed' | null; wedge_from?: number | null }> = [],
) => ({
  version: 1 as const,
  atoms,
  bonds: bonds.map((b) => ({
    a: b.a,
    b: b.b,
    order: b.order,
    wedge: b.wedge ?? null,
    wedge_from: b.wedge_from ?? null,
  })),
  rings: [] as Array<{ id: string; atoms: number[]; kind: 'kekule' | 'aromatic' | 'aliphatic' }>,
  counts: { heavy: atoms.length, rings: 0, heteroatoms: heteroFromAtoms(atoms) },
});

describe('validate_graph (LOCK 7 pure function)', () => {
  it('returns ok=true for a clean direct GraphIntent', () => {
    const graph = baseGraphIntent(
      [baseAtom(1, 'C'), baseAtom(2, 'O')],
      [{ a: 1, b: 2, order: 1 }],
    );
    const result = validateGraphPure({ graph });
    expect(result.ok).toBe(true);
    expect(result.shape).toBe('graph_intent');
    expect(result.diagnostics).toHaveLength(0);
    expect(result.topology_summary.heavy_atoms).toBe(2);
  });

  it('rejects malformed input with schema_invalid (LOCK 7 check 1)', () => {
    const result = validateGraphPure({ graph: { version: 1 } });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'schema_invalid')).toBe(true);
  });

  it('accepts wedge without stereo:declared (LOCK 24 removed — flag was build-ignored)', () => {
    // LOCK 24 removed: stereo:'declared' was a validate-only flag the build path
    // never read. A wedge with a valid endpoint and coords validates clean regardless.
    // Atoms need coords so V2 (chiral_cluster_missing_coords) does not fire.
    const graph = {
      version: 1 as const,
      atoms: [
        baseAtom(1, 'C', { x: 0, y: 0 }),
        baseAtom(2, 'C', { x: 30, y: 0 }),
        baseAtom(3, 'O', { x: -15, y: 26 }),
        baseAtom(4, 'N', { x: -15, y: -26 }),
      ],
      bonds: [
        { a: 1, b: 2, order: 1 as const, wedge: null, wedge_from: null },
        { a: 1, b: 3, order: 1 as const, wedge: null, wedge_from: null },
        { a: 1, b: 4, order: 1 as const, wedge: 'solid' as const, wedge_from: 1 },
      ],
      rings: [] as never[],
      counts: { heavy: 4, rings: 0, heteroatoms: { O: 1, N: 1 } },
    };
    const result = validateGraphPure({ graph });
    expect(result.diagnostics.find((d) => d.code === 'wedge_without_stereo_declaration')).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('accepts wedge with stereo:declared (field still accepted for back-compat)', () => {
    // stereo:'declared' is still a valid field in the schema (accepted-but-ignored).
    // Atoms need coords so V2 (chiral_cluster_missing_coords) does not fire.
    const graph = {
      version: 1 as const,
      atoms: [
        baseAtom(1, 'C', { stereo: 'declared' as const, x: 0, y: 0 }),
        baseAtom(2, 'C', { x: 30, y: 0 }),
        baseAtom(3, 'O', { x: -15, y: 26 }),
        baseAtom(4, 'N', { x: -15, y: -26 }),
      ],
      bonds: [
        { a: 1, b: 2, order: 1 as const, wedge: null, wedge_from: null },
        { a: 1, b: 3, order: 1 as const, wedge: null, wedge_from: null },
        { a: 1, b: 4, order: 1 as const, wedge: 'solid' as const, wedge_from: 1 },
      ],
      rings: [] as never[],
      counts: { heavy: 4, rings: 0, heteroatoms: { O: 1, N: 1 } },
    };
    const result = validateGraphPure({ graph });
    expect(result.diagnostics.find((d) => d.code === 'wedge_without_stereo_declaration')).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('rejects placeholder consistency violation (LOCK 5)', () => {
    const graph = {
      ...baseGraphIntent([baseAtom(1, 'C', { drawn_H_confidence: 'needs_zoom' })]),
      // No matching unresolved[] entry
    };
    const result = validateGraphPure({ graph });
    expect(result.diagnostics.some((d) => d.code === 'unresolved_consistency_violation')).toBe(true);
  });

  it('accepts placeholder with matching unresolved entry (LOCK 5)', () => {
    const graph = {
      ...baseGraphIntent([baseAtom(1, 'C', { drawn_H_confidence: 'needs_zoom' })]),
      unresolved: [
        {
          field: 'drawn_H' as const,
          record_id: 'atom:1',
          note: 'tautomer ambiguity',
          state: 'needs_zoom' as const,
        },
      ],
    };
    const result = validateGraphPure({ graph });
    expect(result.diagnostics.some((d) => d.code === 'unresolved_consistency_violation')).toBe(false);
    expect(result.unresolved_remaining).toHaveLength(1);
  });

  it('flags counts.heavy mismatch ≥±2 as error, ±1 as warning (LOCK 16)', () => {
    const graphErr = {
      ...baseGraphIntent([baseAtom(1, 'C'), baseAtom(2, 'C')]),
      counts: { heavy: 5, rings: 0, heteroatoms: {} },
    };
    const errResult = validateGraphPure({ graph: graphErr });
    expect(errResult.diagnostics.some((d) => d.code === 'count_mismatch' && d.severity === 'error')).toBe(true);

    const graphWarn = {
      ...baseGraphIntent([baseAtom(1, 'C'), baseAtom(2, 'C')]),
      counts: { heavy: 3, rings: 0, heteroatoms: {} },
    };
    const warnResult = validateGraphPure({ graph: graphWarn });
    expect(warnResult.diagnostics.some((d) => d.code === 'count_mismatch_minor' && d.severity === 'warning')).toBe(true);
  });

  it('returns prefixed record_id namespace (LOCK 6)', () => {
    const graph = baseGraphIntent(
      [baseAtom(1, 'C', { drawn_H_confidence: 'needs_zoom' })],
    );
    const result = validateGraphPure({ graph });
    const diag = result.diagnostics.find((d) => d.code === 'unresolved_consistency_violation');
    expect(diag?.record_id.startsWith('atom:')).toBe(true);
  });

  it('is pure — produces identical result on repeated calls', () => {
    const graph = baseGraphIntent([baseAtom(1, 'C'), baseAtom(2, 'C')], [{ a: 1, b: 2, order: 1 }]);
    const r1 = validateGraphPure({ graph });
    const r2 = validateGraphPure({ graph });
    expect(JSON.stringify(r1)).toEqual(JSON.stringify(r2));
  });

  it('flags components count mismatch (LOCK 14 + LOCK 16) on direct GraphIntent', () => {
    const graph = {
      ...baseGraphIntent(
        [baseAtom(1, 'C'), baseAtom(2, 'C')],
        [{ a: 1, b: 2, order: 1 }],
      ),
      counts: { heavy: 2, rings: 0, components: 2, heteroatoms: {} },
    };
    const result = validateGraphPure({ graph });
    expect(
      result.diagnostics.some(
        (d) => d.code === 'count_mismatch' && d.field === 'counts.components',
      ),
    ).toBe(true);
  });

  it('does NOT emit shape_advisory or image_heavy_count_mismatch for dense polycyclic drafts', () => {
    // Paclitaxel-like proxy: 25 heavy, 4 rings, fusion present. Pre-removal
    // this would trip shape_advisory (and image_heavy_count_mismatch when a
    // sourceImagePath was supplied). Post-removal both are gone.
    const atoms = Array.from({ length: 25 }, (_, i) => ({
      id: i,
      element: 'C',
      drawn_H: null as number | null,
      charge: 0,
      radical: 0 as 0,
      ring: 'r1',
    }));
    const bonds = Array.from({ length: 24 }, (_, i) => ({
      a: i,
      b: i + 1,
      order: 1 as 1,
      wedge: null,
      wedge_from: null,
    }));
    const graph = {
      version: 1 as const,
      atoms,
      bonds,
      // 4 fused rings sharing atoms (fusion=true)
      rings: [
        { id: 'r1', atoms: [0, 1, 2, 3, 4, 5], kind: 'aliphatic' as const },
        { id: 'r2', atoms: [4, 5, 6, 7, 8, 9], kind: 'aliphatic' as const },
        { id: 'r3', atoms: [8, 9, 10, 11, 12, 13], kind: 'aliphatic' as const },
        { id: 'r4', atoms: [12, 13, 14, 15, 16, 17], kind: 'aliphatic' as const },
      ],
      counts: { heavy: 25, rings: 4, heteroatoms: {} },
    };
    const result = validateGraphPure({ graph });
    expect(
      result.diagnostics.some((d) => d.code === 'shape_advisory'),
    ).toBe(false);
    expect(
      result.diagnostics.some((d) => d.code === 'image_heavy_count_mismatch'),
    ).toBe(false);
  });
});

// ── Task 5D — worksheet-survivor guard pins ───────────────────────────
//
// These pins lock in the direct-path behavior of two validation guards
// that were EXPRESSED differently on the (now-deleted) worksheet shape.
// Task 5E deleted the worksheet validator; the deletion must not regress
// the direct path, so each guard's direct-path contract is asserted here.
//
//  - LOCK 13 (charge_glyph anchor) was a WORKSHEET concept: a separable
//    `charge_glyph` node + `attachments[]` edge that could be orphaned or
//    drawn too far from its anchor atom. On the DIRECT GraphIntent shape
//    `charge` is an intrinsic atom property (`intentAtomSchema.charge`,
//    a `.strict()` numeric field) — there is no separable glyph node and
//    no `attachments[]` array in the schema, so the orphan / too-far
//    failure mode CANNOT be expressed. LOCK 13 is therefore MOOT on the
//    direct shape; the audit (Task 5D) found no direct-path failure mode
//    to port. The pin proves charged direct intents validate cleanly so
//    a future change can't silently start rejecting them.
//
//  - LOCK 14/16 (multi-component / salt / fragment cross-check) is
//    ALREADY on the direct path (validateDirectGraphIntent components
//    cross-check + intentCountsSchema.components). The mismatch case is
//    pinned above ('flags components count mismatch …'); this block adds
//    the happy-path pin (a fully-transcribed salt with a correct
//    declared components count validates cleanly).
describe('Task 5D — LOCK 13 is moot on the direct GraphIntent shape', () => {
  it('validates a charged [O-] acetate cleanly (charge is intrinsic, no glyph anchor)', () => {
    // CC(=O)[O-] — atoms: C(methyl) C(carbonyl) O(=O) O(−). The negative
    // charge lives on atom 4 as `charge: -1`; there is no charge_glyph
    // node to anchor, so no LOCK-13-class diagnostic can fire.
    const atoms = [
      baseAtom(1, 'C'),
      baseAtom(2, 'C'),
      baseAtom(3, 'O'),
      baseAtom(4, 'O', { charge: -1 }),
    ];
    const graph = {
      ...baseGraphIntent(atoms, [
        { a: 1, b: 2, order: 1 },
        { a: 2, b: 3, order: 2 },
        { a: 2, b: 4, order: 1 },
      ]),
      counts: { heavy: 4, rings: 0, heteroatoms: { O: 2 } },
    };
    const result = validateGraphPure({ graph });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
    // No worksheet-only charge-anchor diagnostics exist on this path.
    const chargeAnchorCodes = [
      'unanchored_charge',
      'unanchored_charge_glyph',
      'charge_glyph_too_far',
    ];
    expect(
      result.diagnostics.some((d) => chargeAnchorCodes.includes(d.code)),
    ).toBe(false);
  });

  it('validates a multi-charge cation cleanly ([NH3+]CC[NH3+] ethylenediammonium)', () => {
    // Two formally-charged nitrogens in one connected graph. Each carries
    // an intrinsic `charge: +1`; the direct shape has no charge_glyph /
    // attachment machinery to mis-anchor, so this validates clean.
    const atoms = [
      baseAtom(1, 'N', { charge: 1, drawn_H: 3 }),
      baseAtom(2, 'C'),
      baseAtom(3, 'C'),
      baseAtom(4, 'N', { charge: 1, drawn_H: 3 }),
    ];
    const graph = {
      ...baseGraphIntent(atoms, [
        { a: 1, b: 2, order: 1 },
        { a: 2, b: 3, order: 1 },
        { a: 3, b: 4, order: 1 },
      ]),
      counts: { heavy: 4, rings: 0, heteroatoms: { N: 2 } },
    };
    const result = validateGraphPure({ graph });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });
});

describe('Task 5D — LOCK 14/16 components cross-check pin (direct path, happy path)', () => {
  it('validates a fully-transcribed 2-component salt with correct declared components', () => {
    // Sodium acetate as two fragments: CC(=O)[O-] (atoms 1-4) + [Na+]
    // (atom 5). counts.components=2 matches the computed component count,
    // so the LOCK 14/16 cross-check passes (salts transcribed in FULL and
    // declared consistently are accepted).
    const atoms = [
      baseAtom(1, 'C'),
      baseAtom(2, 'C'),
      baseAtom(3, 'O'),
      baseAtom(4, 'O', { charge: -1 }),
      baseAtom(5, 'Na', { charge: 1 }),
    ];
    const graph = {
      ...baseGraphIntent(atoms, [
        { a: 1, b: 2, order: 1 },
        { a: 2, b: 3, order: 2 },
        { a: 2, b: 4, order: 1 },
      ]),
      counts: { heavy: 5, rings: 0, components: 2, heteroatoms: { O: 2, Na: 1 } },
    };
    const result = validateGraphPure({ graph });
    expect(result.topology_summary.components).toBe(2);
    expect(
      result.diagnostics.some(
        (d) => d.code === 'count_mismatch' && d.field === 'counts.components',
      ),
    ).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('still flags an under-transcribed salt (declared components > computed)', () => {
    // Agent declared a 2-component salt but only transcribed the anion —
    // the counterion is missing. components=2 vs computed=1 → mismatch.
    // This is the real failure mode LOCK 14/16 guards (a salt NOT
    // transcribed in full); it must stay on the direct path post-5E.
    const atoms = [
      baseAtom(1, 'C'),
      baseAtom(2, 'C'),
      baseAtom(3, 'O'),
      baseAtom(4, 'O', { charge: -1 }),
    ];
    const graph = {
      ...baseGraphIntent(atoms, [
        { a: 1, b: 2, order: 1 },
        { a: 2, b: 3, order: 2 },
        { a: 2, b: 4, order: 1 },
      ]),
      counts: { heavy: 4, rings: 0, components: 2, heteroatoms: { O: 2 } },
    };
    const result = validateGraphPure({ graph });
    expect(
      result.diagnostics.some(
        (d) => d.code === 'count_mismatch' && d.field === 'counts.components',
      ),
    ).toBe(true);
    expect(result.ok).toBe(false);
  });

  // ── Task 5F — shorthand-glyph preflight ─────────────────────────────────
  describe('shorthand glyph (Task 5F)', () => {
    it('accepts a known shorthand glyph clean (OMe on a carbon)', () => {
      // Shorthand atom carries placeholder element 'C'; heteroFromAtoms does
      // not count it (the O is opaque inside the glyph). The agent declares
      // counts of what it SEES: 2 visible nodes, heteroatoms {}.
      const graph = baseGraphIntent(
        [baseAtom(1, 'C', { drawn_H: 3 }), baseAtom(2, 'C', { shorthand: 'OMe' })],
        [{ a: 1, b: 2, order: 1 }],
      );
      const result = validateGraphPure({ graph });
      expect(result.diagnostics.filter((d) => d.code === 'unknown_shorthand')).toHaveLength(0);
      expect(result.ok).toBe(true);
    });

    it('flags an unknown shorthand glyph with code unknown_shorthand and blocks ok', () => {
      const graph = baseGraphIntent(
        [baseAtom(1, 'C', { drawn_H: 3 }), baseAtom(2, 'C', { shorthand: 'Xyz' })],
        [{ a: 1, b: 2, order: 1 }],
      );
      const result = validateGraphPure({ graph });
      const unknown = result.diagnostics.filter((d) => d.code === 'unknown_shorthand');
      expect(unknown).toHaveLength(1);
      expect(unknown[0].record_id).toBe('atom:2');
      expect(unknown[0].field).toBe('shorthand');
      expect(unknown[0].severity).toBe('error');
      expect(result.ok).toBe(false);
    });

    it('accepts an isotope token as shorthand (13C) without unknown_shorthand', () => {
      const graph = baseGraphIntent(
        [baseAtom(1, 'C', { drawn_H: 3 }), baseAtom(2, 'C', { shorthand: '13C' })],
        [{ a: 1, b: 2, order: 1 }],
      );
      const result = validateGraphPure({ graph });
      expect(result.diagnostics.filter((d) => d.code === 'unknown_shorthand')).toHaveLength(0);
      expect(result.ok).toBe(true);
    });

    // ── ADR-0002 (W1) — table-collision rule (semantic; validator path) ──────
    it('flags a shorthand_resolution on a TABLE glyph as shorthand_resolution_redundant and blocks ok', () => {
      // 'OMe' IS in the deterministic table → a declared resolution for it is
      // redundant (table wins, one source per glyph).
      const graph = baseGraphIntent(
        [
          baseAtom(1, 'C', { drawn_H: 3 }),
          baseAtom(2, 'C', {
            shorthand: 'OMe',
            shorthand_resolution: {
              source: 'agent_inference',
              expansion: {
                atoms: [{ element: 'O' }, { element: 'C', drawn_H: 3 }],
                bonds: [{ a: 0, b: 1, order: 1 }],
                attachment_atom_offset: 0,
              },
            },
          }),
        ],
        [{ a: 1, b: 2, order: 1 }],
      );
      const result = validateGraphPure({ graph });
      const redundant = result.diagnostics.filter(
        (d) => d.code === 'shorthand_resolution_redundant',
      );
      expect(redundant).toHaveLength(1);
      expect(redundant[0].record_id).toBe('atom:2');
      expect(redundant[0].field).toBe('shorthand_resolution');
      expect(redundant[0].severity).toBe('error');
      expect(result.ok).toBe(false);
    });

    it('does NOT flag a shorthand_resolution on an OFF-table glyph (TBS)', () => {
      // 'TBS' is NOT in the table → a declared resolution is legitimate, and as
      // of W2a the translator consumes `expansion`, so the off-table glyph is
      // resolved-by-declaration (NOT unknown). Assert neither the redundancy rule
      // nor unknown_shorthand fires when a valid resolution is present.
      const graph = baseGraphIntent(
        [
          baseAtom(1, 'C', { drawn_H: 3 }),
          baseAtom(2, 'C', {
            shorthand: 'TBS',
            shorthand_resolution: {
              source: 'paper_legend',
              legend_ref: 'dict#1',
              expansion: {
                atoms: [{ element: 'Si' }, { element: 'C', drawn_H: 3 }],
                bonds: [{ a: 0, b: 1, order: 1 }],
                attachment_atom_offset: 0,
              },
            },
          }),
        ],
        [{ a: 1, b: 2, order: 1 }],
      );
      const result = validateGraphPure({ graph });
      expect(
        result.diagnostics.filter((d) => d.code === 'shorthand_resolution_redundant'),
      ).toHaveLength(0);
      // W2a — a declared resolution makes the off-table glyph resolved-by-
      // declaration, so it no longer flags unknown_shorthand.
      expect(
        result.diagnostics.filter((d) => d.code === 'unknown_shorthand'),
      ).toHaveLength(0);
      // And a valid expansion is referential-integrity clean.
      expect(
        result.diagnostics.filter((d) => d.code === 'shorthand_expansion_invalid'),
      ).toHaveLength(0);
    });

    // ── ADR-0002 (W2a) — referential-integrity of a declared expansion ───────
    it('flags an out-of-range bond index in a declared expansion as shorthand_expansion_invalid and blocks ok', () => {
      const graph = baseGraphIntent(
        [
          baseAtom(1, 'C', { drawn_H: 3 }),
          baseAtom(2, 'C', {
            shorthand: 'ZZZ',
            shorthand_resolution: {
              source: 'agent_inference',
              expansion: {
                atoms: [{ element: 'O' }, { element: 'C', drawn_H: 3 }],
                // bond b=5 is out of range for a 2-atom expansion.
                bonds: [{ a: 0, b: 5, order: 1 }],
                attachment_atom_offset: 0,
              },
            },
          }),
        ],
        [{ a: 1, b: 2, order: 1 }],
      );
      const result = validateGraphPure({ graph });
      const invalid = result.diagnostics.filter(
        (d) => d.code === 'shorthand_expansion_invalid',
      );
      expect(invalid).toHaveLength(1);
      expect(invalid[0].record_id).toBe('atom:2');
      expect(invalid[0].field).toBe('shorthand_resolution');
      expect(invalid[0].severity).toBe('error');
      expect(result.ok).toBe(false);
      // A malformed expansion is NOT also reported as unknown_shorthand.
      expect(
        result.diagnostics.filter((d) => d.code === 'unknown_shorthand'),
      ).toHaveLength(0);
    });

    it('flags an out-of-range attachment_atom_offset in a declared expansion as shorthand_expansion_invalid', () => {
      const graph = baseGraphIntent(
        [
          baseAtom(1, 'C', { drawn_H: 3 }),
          baseAtom(2, 'C', {
            shorthand: 'ZZZ',
            shorthand_resolution: {
              source: 'agent_inference',
              expansion: {
                atoms: [{ element: 'O' }, { element: 'C', drawn_H: 3 }],
                bonds: [{ a: 0, b: 1, order: 1 }],
                // offset 9 is out of range for a 2-atom expansion.
                attachment_atom_offset: 9,
              },
            },
          }),
        ],
        [{ a: 1, b: 2, order: 1 }],
      );
      const result = validateGraphPure({ graph });
      const invalid = result.diagnostics.filter(
        (d) => d.code === 'shorthand_expansion_invalid',
      );
      expect(invalid).toHaveLength(1);
      expect(invalid[0].record_id).toBe('atom:2');
      expect(result.ok).toBe(false);
    });
  });

  // ── C6/B1 — element-glyph guard ─────────────────────────────────────────
  describe('element-glyph guard (C6/B1)', () => {
    it('flags element:"Me" with no shorthand field as element_is_shorthand_glyph and blocks ok', () => {
      const graph = baseGraphIntent(
        [baseAtom(1, 'C', { drawn_H: 3 }), baseAtom(2, 'C' /* Me will be set as element below */)],
        [{ a: 1, b: 2, order: 1 }],
      );
      // Override atom 2's element to 'Me' — valid per ELEMENT_PATTERN ^[A-Z][a-z]? but is a shorthand glyph
      (graph.atoms[1] as { element: string }).element = 'Me';
      const result = validateGraphPure({ graph });
      const flagged = result.diagnostics.filter((d) => d.code === 'element_is_shorthand_glyph');
      expect(flagged).toHaveLength(1);
      expect(flagged[0].record_id).toBe('atom:2');
      expect(flagged[0].field).toBe('element');
      expect(flagged[0].severity).toBe('error');
      expect(result.ok).toBe(false);
    });

    it('does NOT flag a normal element "C" as element_is_shorthand_glyph', () => {
      const graph = baseGraphIntent(
        [baseAtom(1, 'C', { drawn_H: 3 }), baseAtom(2, 'C')],
        [{ a: 1, b: 2, order: 1 }],
      );
      const result = validateGraphPure({ graph });
      expect(result.diagnostics.filter((d) => d.code === 'element_is_shorthand_glyph')).toHaveLength(0);
    });
  });
});

// Task A1: geom bond does not require coords (label-authoritative E/Z)
it('A1: geom bond does not require coords (label-authoritative)', () => {
  const graph = {
    version: 1,
    atoms: [
      { id: 0, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
    ],
    bonds: [
      { a: 0, b: 1, order: 1, wedge: null, wedge_from: null },
      { a: 1, b: 2, order: 2, wedge: null, wedge_from: null, geom: 'cis' },
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 4, rings: 0, heteroatoms: {} },
  };
  const res = validateGraphIntent(graph);
  expect(res.valid).toBe(true);
  // res.valid === true is sufficient — the V4 rule no longer exists, so it can never fire.
});

it('B1: wedge without stereo:declared validates (flag is build-ignored)', () => {
  const graph = {
    version: 1,
    atoms: [
      { id: 0, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 0, y: 0 },
      { id: 1, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null, x: 30, y: 0 },
      { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: -15, y: 26 },
      { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: -15, y: -26 },
    ],
    bonds: [
      { a: 0, b: 1, order: 1, wedge: 'solid', wedge_from: 0 },  // NO stereo:'declared' on atom 0
      { a: 0, b: 2, order: 1, wedge: null, wedge_from: null },
      { a: 0, b: 3, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 4, rings: 0, heteroatoms: { O: 1 } },
  };
  const res = validateGraphPure({ graph });
  expect(res.diagnostics.find((d) => d.code === 'wedge_without_stereo_declaration')).toBeUndefined();
});
