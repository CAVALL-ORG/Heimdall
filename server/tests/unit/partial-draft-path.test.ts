// Phase 2 — Task E acceptance tests for the partial-draft path.
//
// Schema change: counts.heavy / counts.rings accept either a bare number
// (legacy) or { value, confidence: 'high' | 'needs_zoom' }. The validate
// path emits a soft count_uncertain advisory + surfaces an
// unresolved_remaining entry when confidence === 'needs_zoom', so the
// agent can advance rounds while still iterating. Build remains
// fail-closed: any residual needs_zoom on counts refuses compile
// (validateGraphIntent surfaces a counts.heavy issue).
//
// Plan: protocol-scaling-for-dense-rows.

import { describe, expect, it } from 'vitest';
import { validateGraphPure } from '../../src/mcp/tools/validate';
import { validateGraphIntent } from '../../src/adapter/graph-intent/validator';

const baseAtom = (
  id: number,
  element: string = 'C',
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

// A bare scaffold: 10 placed carbons in a chain, no rings. Used in cases
// 1–4 to exercise counts.heavy independent of the actual graph.
function tenAtomChain() {
  const atoms = Array.from({ length: 10 }, (_, i) => baseAtom(i + 1));
  const bonds = Array.from({ length: 9 }, (_, i) => ({
    a: i + 1,
    b: i + 2,
    order: 1 as const,
    wedge: null,
    wedge_from: null,
  }));
  return { atoms, bonds };
}

function buildGraph(counts: unknown, atoms = tenAtomChain().atoms, bonds = tenAtomChain().bonds) {
  return {
    version: 1 as const,
    atoms,
    bonds,
    rings: [] as Array<{ id: string; atoms: number[]; kind: 'kekule' | 'aromatic' | 'aliphatic' }>,
    counts,
  };
}

describe('Task E — partial-draft path (counts.heavy / counts.rings needs_zoom)', () => {
  describe('Case 1 — counts.heavy needs_zoom emits soft advisory, not hard error', () => {
    it('declared 25 / placed 10 with confidence=needs_zoom → ok:false but no count_mismatch error', () => {
      const graph = buildGraph({
        heavy: { value: 25, confidence: 'needs_zoom' },
        rings: 0,
        heteroatoms: {},
      });
      const result = validateGraphPure({ graph });

      // No hard count_mismatch error from counts.heavy.
      const heavyErrors = result.diagnostics.filter(
        (d) => d.field === 'counts.heavy' && d.code === 'count_mismatch' && d.severity === 'error',
      );
      expect(heavyErrors).toHaveLength(0);

      // No delta-1 minor warning either (would be noise when needs_zoom).
      const minorWarn = result.diagnostics.filter(
        (d) => d.field === 'counts.heavy' && d.code === 'count_mismatch_minor',
      );
      expect(minorWarn).toHaveLength(0);

      // Soft advisory IS emitted.
      const advisory = result.diagnostics.find(
        (d) => d.record_id === 'counts.heavy' && d.code === 'count_uncertain',
      );
      expect(advisory).toBeDefined();
      expect(advisory?.severity).toBe('warning');

      // The count is surfaced as an unresolved_remaining entry so the
      // validate loop knows it's still pending.
      const pending = result.unresolved_remaining.find(
        (u) => u.record_id === 'counts.heavy' && u.field === 'value',
      );
      expect(pending).toBeDefined();
      expect(pending?.state).toBe('needs_zoom');

      // Overall ok:false so the agent knows to iterate, not commit.
      expect(result.ok).toBe(false);
    });
  });

  describe('Case 2 — counts.heavy confidence:high behaves normally', () => {
    it('declared 10 / placed 10 with confidence=high → ok:true', () => {
      const graph = buildGraph({
        heavy: { value: 10, confidence: 'high' },
        rings: 0,
        heteroatoms: {},
      });
      const result = validateGraphPure({ graph });
      expect(result.ok).toBe(true);
      const advisory = result.diagnostics.find((d) => d.code === 'count_uncertain');
      expect(advisory).toBeUndefined();
    });

    it('declared 25 / placed 10 with confidence=high still hard-errors with count_mismatch', () => {
      const graph = buildGraph({
        heavy: { value: 25, confidence: 'high' },
        rings: 0,
        heteroatoms: {},
      });
      const result = validateGraphPure({ graph });
      const err = result.diagnostics.find(
        (d) => d.field === 'counts.heavy' && d.code === 'count_mismatch' && d.severity === 'error',
      );
      expect(err).toBeDefined();
    });
  });

  describe('Case 3 — bare-number counts.heavy back-compat', () => {
    it('declared 10 / placed 10 as bare number → ok:true (legacy path unchanged)', () => {
      const graph = buildGraph({ heavy: 10, rings: 0, heteroatoms: {} });
      const result = validateGraphPure({ graph });
      expect(result.ok).toBe(true);
    });

    it('declared 25 / placed 10 as bare number still hard-errors (no escape hatch)', () => {
      const graph = buildGraph({ heavy: 25, rings: 0, heteroatoms: {} });
      const result = validateGraphPure({ graph });
      const err = result.diagnostics.find(
        (d) => d.field === 'counts.heavy' && d.code === 'count_mismatch' && d.severity === 'error',
      );
      expect(err).toBeDefined();
    });
  });

  describe('Case 4 — build refuses when counts.heavy is needs_zoom', () => {
    it('validateGraphIntent surfaces an issue with path counts.heavy when value is needs_zoom', () => {
      const { atoms, bonds } = tenAtomChain();
      const graph = {
        version: 1 as const,
        atoms,
        bonds,
        rings: [],
        counts: {
          heavy: { value: 25, confidence: 'needs_zoom' as const },
          rings: 0,
          heteroatoms: {},
        },
      };
      const result = validateGraphIntent(graph);
      // Build-time refusal: needs_zoom on counts is not allowed.
      expect(result.valid).toBe(false);
      if (!result.valid) {
        const issue = result.errors.find((e) => e.path.startsWith('counts.heavy'));
        expect(issue).toBeDefined();
        expect(issue?.message).toMatch(/needs_zoom/);
      }
    });

    it('validateGraphIntent accepts counts.heavy={value, confidence:high} matching atoms', () => {
      const { atoms, bonds } = tenAtomChain();
      const graph = {
        version: 1 as const,
        atoms,
        bonds,
        rings: [],
        counts: {
          heavy: { value: 10, confidence: 'high' as const },
          rings: 0,
          heteroatoms: {},
        },
      };
      const result = validateGraphIntent(graph);
      expect(result.valid).toBe(true);
    });
  });

});
