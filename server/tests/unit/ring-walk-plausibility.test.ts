import { describe, it, expect } from 'vitest';
import { validateGraphPure } from '../../src/mcp/tools/validate';

/**
 * Phase 5 Task J — Ring-walk plausibility cross-check.
 *
 * For each ring declared by the agent (GraphIntent rings), verify that
 * the listed vertex walk forms a valid closed cycle:
 *   - Every consecutive vertex pair (including wrap-around) must be
 *     joined by a declared bond.
 *   - If any pair is not connected → emit `ring_size_walk_mismatch`
 *     error.
 *
 * Schema enforces min(3) on ring atoms, so "ring too small" is caught
 * earlier as `schema_invalid` — not testable here at the
 * validateGraphPure layer.
 *
 * This is the Layer-5 primitive that would have caught A011's
 * 4-membered-ring artifact pre-build (a 4-vertex ring listed where the
 * actual ring traversal requires 6 — the missing bonds surface as a
 * walk mismatch).
 */
describe('ring_size_walk_mismatch (Task J)', () => {
  it('GraphIntent: emits error when ring.atoms walk has a missing bond between consecutive atoms', () => {
    // 4-atom ring declared but the 4-1 closing bond is missing — exactly
    // the A011 4-membered-ring artifact failure mode pre-build.
    const graph = {
      version: 1 as const,
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0 as 0, ring: 'r1', x: 0, y: 0 },
        { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0 as 0, ring: 'r1', x: 1, y: 0 },
        { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0 as 0, ring: 'r1', x: 1, y: 1 },
        { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0 as 0, ring: 'r1', x: 0, y: 1 },
      ],
      bonds: [
        { a: 1, b: 2, order: 1 as 1, wedge: null, wedge_from: null },
        { a: 2, b: 3, order: 1 as 1, wedge: null, wedge_from: null },
        { a: 3, b: 4, order: 1 as 1, wedge: null, wedge_from: null },
        // closing bond 4-1 is MISSING.
      ],
      rings: [
        { id: 'r1', atoms: [1, 2, 3, 4], kind: 'aliphatic' as const },
      ],
      counts: { heavy: 4, rings: 1, heteroatoms: {} },
    };
    const result = validateGraphPure({ graph });
    const err = result.diagnostics.find(
      (d) => d.code === 'ring_size_walk_mismatch',
    );
    expect(err).toBeDefined();
    expect(err?.severity).toBe('error');
    expect(err?.record_id).toContain('r1');
  });

});
