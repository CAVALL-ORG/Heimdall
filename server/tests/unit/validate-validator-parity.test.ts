import { describe, expect, it } from 'vitest';
import { validateGraphPure } from '../../src/mcp/tools/validate';
import { validateGraphIntent } from '../../src/adapter/graph-intent/validator';
import type { GraphIntent } from '../../src/types/graph-intent';

/**
 * Parity test — Wave-2 Task 3 (unify the two structural validators).
 *
 * Two structural validators historically re-implemented the SAME
 * invariants with DIVERGENT coverage / thresholds:
 *
 *   - `validateGraphPure` (validate.ts) — the stateless `validate_graph`
 *     MCP preflight the agent calls before building.
 *   - `validateGraphIntent` (validator.ts) — the ENFORCER the translator
 *     calls inside the build path.
 *
 * After the refactor, `validateGraphIntent` is the SINGLE SOURCE OF TRUTH
 * for structural invariants and `validate_graph` delegates to it. This
 * test pins that contract: for each scenario the two validators must
 * AGREE on accept/reject AND on the error category.
 *
 * The category is matched loosely (substring on the validate-side code OR
 * the validator-side message) because the two layers expose different
 * surfaces — validate.ts emits a `code` string per diagnostic, validator.ts
 * emits a `message` string per issue. Parity is about "do they both reject
 * for the SAME reason", not "do the strings match byte-for-byte".
 */

// ── Helpers ───────────────────────────────────────────────────────────

function baseAtom(
  id: number,
  element: string,
  extra: Partial<GraphIntent['atoms'][number]> = {},
): GraphIntent['atoms'][number] {
  return {
    id,
    element,
    drawn_H: null,
    charge: 0,
    radical: 0,
    ring: null,
    ...extra,
  };
}

/** Does the validate.ts (validateGraphPure) result accept the graph? */
function validateAccepts(graph: unknown): boolean {
  return validateGraphPure({ graph }).ok;
}

/** Does the validator.ts (validateGraphIntent) result accept the graph? */
function validatorAccepts(graph: unknown): boolean {
  return validateGraphIntent(graph).valid;
}

/** Concatenate every validate.ts error diagnostic into one haystack. */
function validateText(graph: unknown): string {
  return validateGraphPure({ graph })
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => `${d.code} ${d.field} ${d.note ?? ''}`)
    .join(' | ');
}

/** Concatenate every validator.ts issue into one haystack. */
function validatorText(graph: unknown): string {
  const r = validateGraphIntent(graph);
  if (r.valid) return '';
  return r.errors.map((e) => `${e.path} ${e.message}`).join(' | ');
}

// A "category" is a list of substrings; the scenario passes parity if BOTH
// validators' error text contain at least one of the listed substrings.
type Scenario = {
  name: string;
  graph: () => unknown;
  expectAccept: boolean;
  /** Substrings either validator may use for this rejection category. */
  categoryMarkers?: string[];
};

// ── Shared fixtures ───────────────────────────────────────────────────

// A clean acyclic C-O graph (2 heavy, 1 bond) that BOTH validators accept.
function validGraph(): GraphIntent {
  return {
    version: 1,
    atoms: [baseAtom(1, 'C'), baseAtom(2, 'O')],
    bonds: [{ a: 1, b: 2, order: 1, wedge: null, wedge_from: null }],
    rings: [],
    counts: { heavy: 2, rings: 0, heteroatoms: { O: 1 } },
  };
}

// A clean 6-ring (cyclohexane) — closed cycle, all bonds present.
function validRing(): GraphIntent {
  const atoms = [1, 2, 3, 4, 5, 6].map((id) => baseAtom(id, 'C', { ring: 'r1' }));
  const bonds = [
    { a: 1, b: 2 },
    { a: 2, b: 3 },
    { a: 3, b: 4 },
    { a: 4, b: 5 },
    { a: 5, b: 6 },
    { a: 6, b: 1 },
  ].map((e) => ({ ...e, order: 1 as const, wedge: null, wedge_from: null }));
  return {
    version: 1,
    atoms,
    bonds,
    rings: [{ id: 'r1', atoms: [1, 2, 3, 4, 5, 6], kind: 'aliphatic' }],
    counts: { heavy: 6, rings: 1, heteroatoms: {} },
  };
}

// ── Scenarios (ALL required by the task) ──────────────────────────────

const scenarios: Scenario[] = [
  {
    name: '1. valid graph → both accept',
    graph: validGraph,
    expectAccept: true,
  },
  {
    name: '2. broken ring closure → both reject (closure error)',
    // 6-vertex ring declared but the 6-1 closing bond is missing. The
    // vertex walk has no closed cycle → ring_size_walk_mismatch.
    graph: () => {
      const g = validRing();
      g.bonds = g.bonds.filter(
        (b) => !((b.a === 6 && b.b === 1) || (b.a === 1 && b.b === 6)),
      );
      return g;
    },
    expectAccept: false,
    categoryMarkers: ['ring_size_walk_mismatch', 'closed cycle', 'missing bond'],
  },
  {
    name: '3. duplicate atom ids → both reject (dup-id error)',
    graph: () => {
      const g = validGraph();
      // two atoms share id=1
      g.atoms = [baseAtom(1, 'C'), baseAtom(1, 'O')];
      g.bonds = [];
      g.counts = { heavy: 2, rings: 0, heteroatoms: { O: 1 } };
      return g;
    },
    expectAccept: false,
    categoryMarkers: ['duplicate atom id', 'duplicate_atom', 'dup'],
  },
  {
    name: '4. count mismatch (declared counts ≠ actual) → both reject',
    graph: () => {
      const g = validGraph();
      // 2 heavy atoms present, declare 5 → hard mismatch on both layers
      g.counts = { heavy: 5, rings: 0, heteroatoms: { O: 1 } };
      return g;
    },
    expectAccept: false,
    categoryMarkers: ['count_mismatch', 'counts.heavy', 'atoms.length'],
  },
  {
    name: '5. bad wedge_from (not an endpoint of the wedge bond) → both reject',
    // wedge_from points at atom 3, which is NOT an endpoint of the wedge
    // bond (1-2). Both validators reject: "wedge_from must equal bond.a or
    // bond.b". (LOCK-24 stereo:'declared' requirement removed; both layers
    // now agree the endpoint check is the sole wedge_from invariant.)
    graph: () => {
      const g: GraphIntent = {
        version: 1,
        atoms: [
          baseAtom(1, 'C'),
          baseAtom(2, 'C'),
          baseAtom(3, 'O'),
          baseAtom(4, 'N'),
        ],
        bonds: [
          { a: 1, b: 2, order: 1, wedge: 'solid', wedge_from: 3 },
          { a: 1, b: 3, order: 1, wedge: null, wedge_from: null },
          { a: 1, b: 4, order: 1, wedge: null, wedge_from: null },
        ],
        rings: [],
        counts: { heavy: 4, rings: 0, heteroatoms: { O: 1, N: 1 } },
      };
      return g;
    },
    expectAccept: false,
    categoryMarkers: [
      'wedge_from',
      'must equal',
    ],
  },
  {
    name: '6. over-large ring (ring beyond what bonds support) → both reject',
    // A ring declares more vertices than the drawn bonds can close — the
    // A011 4-vertex-ring artifact class. Declared ring r1 lists 6 atoms but
    // the bonds only form an open chain (no 5-6 / 6-1 closure), so the ring
    // is "larger than legit" and the vertex walk fails to close.
    graph: () => {
      const atoms = [1, 2, 3, 4, 5, 6].map((id) =>
        baseAtom(id, 'C', { ring: 'r1' }),
      );
      const bonds = [
        { a: 1, b: 2 },
        { a: 2, b: 3 },
        { a: 3, b: 4 },
        { a: 4, b: 5 },
        // 5-6 and 6-1 both missing → walk cannot close the declared 6-ring
      ].map((e) => ({ ...e, order: 1 as const, wedge: null, wedge_from: null }));
      return {
        version: 1,
        atoms,
        bonds,
        rings: [{ id: 'r1', atoms: [1, 2, 3, 4, 5, 6], kind: 'aliphatic' }],
        counts: { heavy: 6, rings: 1, heteroatoms: {} },
      };
    },
    expectAccept: false,
    categoryMarkers: ['ring_size_walk_mismatch', 'closed cycle', 'missing bond'],
  },
  {
    name: '7. impossible valence — A009 overvalent carbon (5 single bonds) → both reject',
    // Census-gap regression target: a carbon with 5 single bonds (valence 5).
    // validator.ts rejects (V11). validate.ts must also reject post-refactor.
    graph: () => {
      const atoms = [1, 2, 3, 4, 5, 6].map((id) => baseAtom(id, 'C'));
      const bonds = [
        { a: 1, b: 2 },
        { a: 1, b: 3 },
        { a: 1, b: 4 },
        { a: 1, b: 5 },
        { a: 1, b: 6 },
      ].map((e) => ({ ...e, order: 1 as const, wedge: null, wedge_from: null }));
      return {
        version: 1,
        atoms,
        bonds,
        rings: [],
        counts: { heavy: 6, rings: 0, heteroatoms: {} },
      };
    },
    expectAccept: false,
    categoryMarkers: ['valence', 'V11', 'exceeds'],
  },
];

// ── Parity assertions ─────────────────────────────────────────────────

describe('validate_graph ↔ validateGraphIntent structural parity', () => {
  for (const sc of scenarios) {
    it(`${sc.name} — accept/reject agree`, () => {
      const graph = sc.graph();
      const vA = validateAccepts(graph);
      const vB = validatorAccepts(graph);
      // Both must equal each other AND equal the expectation.
      expect(
        { validate_graph: vA, validateGraphIntent: vB },
        `validate.ts accept=${vA} vs validator.ts accept=${vB}; ` +
          `expected both ${sc.expectAccept}.\n` +
          `validate.ts errors: ${validateText(graph) || '(none)'}\n` +
          `validator.ts errors: ${validatorText(graph) || '(none)'}`,
      ).toEqual({
        validate_graph: sc.expectAccept,
        validateGraphIntent: sc.expectAccept,
      });
    });

    if (!sc.expectAccept && sc.categoryMarkers) {
      it(`${sc.name} — reject for the same category`, () => {
        const graph = sc.graph();
        const aText = validateText(graph);
        const bText = validatorText(graph);
        const markers = sc.categoryMarkers!;
        const aHit = markers.some((m) => aText.includes(m));
        const bHit = markers.some((m) => bText.includes(m));
        expect(
          { validate_graph_marker: aHit, validateGraphIntent_marker: bHit },
          `expected BOTH validators to reject with a marker in ` +
            `[${markers.join(', ')}].\n` +
            `validate.ts errors: ${aText || '(none)'}\n` +
            `validator.ts errors: ${bText || '(none)'}`,
        ).toEqual({
          validate_graph_marker: true,
          validateGraphIntent_marker: true,
        });
      });
    }
  }
});
