/**
 * Task 5A — FEATURE-PARITY GATE: coarse `unsure_regions` (ADDED field).
 *
 * `unsure_regions?: { x, y, radius, note }[]` is the coarse escape that won
 * the transcription probe — a replacement for the worksheet's fine-grained
 * per-record `unresolved[]`/`needs_zoom` machinery. The agent boxes a region
 * it cannot confidently read; validate_graph surfaces each box as an advisory
 * crop target (coverage_regions) so the agent can zoom it.
 *
 * Scope (per Task 5A): the field must PARSE on the direct GraphIntent and
 * SURVIVE through validate; the validate→crop-target emission is the minimal
 * wiring (each box → one coverage_regions entry). It is advisory — never
 * blocks build, never flips `ok` (same posture as coverage_regions / the
 * bidirectional pixel pass).
 */

import { describe, expect, it } from 'vitest';
import { validateGraphPure } from '../../src/mcp/tools/validate';
import { graphIntentSchema } from '../../src/types/graph-intent';

const baseAtom = (id: number, element: string) => ({
  id,
  element,
  drawn_H: null as number | null,
  charge: 0,
  radical: 0 as 0 | 1 | 2,
  ring: null as string | null,
});

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

const graphWith = (unsure_regions?: unknown) => ({
  version: 1 as const,
  atoms: [baseAtom(1, 'C'), baseAtom(2, 'O')],
  bonds: [{ a: 1, b: 2, order: 1 as const, wedge: null, wedge_from: null }],
  rings: [] as Array<{
    id: string;
    atoms: number[];
    kind: 'kekule' | 'aromatic' | 'aliphatic';
  }>,
  counts: {
    heavy: 2,
    rings: 0,
    heteroatoms: heteroFromAtoms([baseAtom(1, 'C'), baseAtom(2, 'O')]),
  },
  ...(unsure_regions !== undefined ? { unsure_regions } : {}),
});

describe('unsure_regions — schema parse', () => {
  it('parses a GraphIntent carrying unsure_regions', () => {
    const parsed = graphIntentSchema.safeParse(
      graphWith([{ x: 120, y: 80, radius: 25, note: 'crowded junction cluster' }]),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.unsure_regions).toHaveLength(1);
      expect(parsed.data.unsure_regions?.[0]).toEqual({
        x: 120,
        y: 80,
        radius: 25,
        note: 'crowded junction cluster',
      });
    }
  });

  it('omitting unsure_regions is valid (optional field)', () => {
    expect(graphIntentSchema.safeParse(graphWith()).success).toBe(true);
  });

  it('rejects a malformed region (missing note)', () => {
    const parsed = graphIntentSchema.safeParse(
      graphWith([{ x: 1, y: 2, radius: 3 }]),
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects a negative radius', () => {
    const parsed = graphIntentSchema.safeParse(
      graphWith([{ x: 1, y: 2, radius: -3, note: 'x' }]),
    );
    expect(parsed.success).toBe(false);
  });
});

describe('unsure_regions — validate_graph surfacing', () => {
  it('surfaces each unsure_region as an advisory crop target (coverage_regions)', () => {
    const result = validateGraphPure({
      graph: graphWith([
        { x: 120, y: 80, radius: 25, note: 'crowded junction cluster' },
        { x: 300, y: 210, radius: 40, note: 'glyph illegible' },
      ]),
    });
    expect(result.coverage_regions).toBeDefined();
    expect(result.coverage_regions).toHaveLength(2);
    expect(result.coverage_regions?.[0]).toMatchObject({
      x_center: 120,
      y_center: 80,
      bbox_radius: 25,
    });
    expect(result.coverage_regions?.[1]).toMatchObject({
      x_center: 300,
      y_center: 210,
      bbox_radius: 40,
    });
  });

  it('is advisory: unsure_regions on an otherwise-clean draft does NOT flip ok', () => {
    const result = validateGraphPure({
      graph: graphWith([{ x: 10, y: 10, radius: 5, note: 'maybe a methyl' }]),
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });
});
