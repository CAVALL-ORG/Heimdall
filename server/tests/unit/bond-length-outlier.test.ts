/**
 * TDD tests for checkBondLengthOutliers (bond-length-outlier.ts).
 *
 * Connectivity analog of ring-coherence's ring_incoherent: flags a bond whose
 * drawn length (from agent seed coords) is a large outlier vs the in-frame
 * median — the "merged path" mis-wire (a 3-vertex path collapsed into one bond
 * skips junctions, so that bond is drawn much longer than its neighbors).
 *
 * ADVISORY only: the helper just returns findings; the validate.ts wiring
 * pushes them as WARNINGs that never flip ok.
 *
 * Threshold = len > 2.5 × median(in-frame bond lengths). FP=0 gate: the worst
 * correct committed fixture max-ratio is 2.08× (coord-cw-A004H), so 2.5× is
 * FP=0 with margin on every fixture (case 2 locks this in).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  checkBondLengthOutliers,
  type BondLengthFinding,
} from '../../src/adapter/graph-intent/bond-length-outlier';
import { validateTools } from '../../src/mcp/tools/validate';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers ──────────────────────────────────────────────────────────────────

function atom(id: number, x?: number, y?: number) {
  return { id, x, y };
}

function bond(a: number, b: number) {
  return { a, b };
}

// ── Case 1: positive (merged path) ────────────────────────────────────────

describe('positive — merged path bond is a length outlier', () => {
  it('fires exactly one finding naming the long bond', () => {
    // A 5-bond chain at ~100px spacing (horizontal), plus ONE bond ~300px (3×).
    //   atoms 1..6 laid out horizontally 100px apart -> 5 unit bonds of 100px
    //   PLUS a long bond 1->6 spanning 500px? no — make a dedicated outlier.
    // Build: chain 1-2-3-4-5 (4 bonds, 100px each) + atom 6 placed 300px from 5,
    //        bonded 5-6. Median over {100,100,100,100,300} = 100; ratio 3.0×.
    const atoms = [
      atom(1, 0, 0),
      atom(2, 100, 0),
      atom(3, 200, 0),
      atom(4, 300, 0),
      atom(5, 400, 0),
      atom(6, 700, 0), // 300px from atom 5 -> the merged-path outlier
    ];
    const bonds = [
      bond(1, 2),
      bond(2, 3),
      bond(3, 4),
      bond(4, 5),
      bond(5, 6), // 300px -> 3.0× the 100px median
    ];
    const findings = checkBondLengthOutliers({ atoms, bonds });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('bond_length_outlier');
    // names bond (5,6)
    expect(findings[0].note).toMatch(/\(5,6\)/);
    // surfaces the ratio + skip-atoms hint
    expect(findings[0].note).toMatch(/skip atoms/i);
    expect(findings[0].note).toMatch(/3\.0×/);
  });

  it('is silent when every bond is the same length (no outlier)', () => {
    const atoms = [atom(1, 0, 0), atom(2, 100, 0), atom(3, 200, 0), atom(4, 300, 0), atom(5, 400, 0)];
    const bonds = [bond(1, 2), bond(2, 3), bond(3, 4), bond(4, 5)];
    expect(checkBondLengthOutliers({ atoms, bonds })).toEqual([]);
  });
});

// ── Case 2: FP=0 over committed fixtures (THE GATE) ───────────────────────

describe('FP=0 sweep — committed fixtures return []', () => {
  const fixtureFiles = [
    '../fixtures/ez/A011H.graph.json',
    '../fixtures/relayout/A004pass.graph.json',
    '../fixtures/relayout/coord-cw-A004H.graph.json',
    '../fixtures/relayout/sparse-wedge-alanine.graph.json',
  ];

  for (const relPath of fixtureFiles) {
    it(`returns [] for ${relPath}`, () => {
      const raw = JSON.parse(readFileSync(join(__dirname, relPath), 'utf8')) as {
        atoms?: Array<{ id: number; x?: number; y?: number }>;
        bonds?: Array<{ a: number; b: number }>;
      };
      const findings = checkBondLengthOutliers({
        atoms: (raw.atoms ?? []).map((a) => ({ id: a.id, x: a.x, y: a.y })),
        bonds: (raw.bonds ?? []).map((b) => ({ a: b.a, b: b.b })),
      });
      expect(findings).toEqual([]);
    });
  }
});

// ── Case 3: coordless skip ────────────────────────────────────────────────

describe('coordless bonds are not flagged', () => {
  it('skips a long bond whose endpoints lack x/y', () => {
    // 4 normal coord bonds (100px) establish the median; the would-be outlier
    // bond 5-6 has coordless endpoints -> excluded from the sample AND not flagged.
    const atoms = [
      atom(1, 0, 0),
      atom(2, 100, 0),
      atom(3, 200, 0),
      atom(4, 300, 0),
      atom(5, 400, 0),
      atom(6), // no coords
      atom(7), // no coords
    ];
    const bonds = [
      bond(1, 2),
      bond(2, 3),
      bond(3, 4),
      bond(4, 5),
      bond(6, 7), // coordless -> not measured, not flagged
    ];
    expect(checkBondLengthOutliers({ atoms, bonds })).toEqual([]);
  });

  it('skips a bond with only ONE endpoint coordful', () => {
    const atoms = [
      atom(1, 0, 0),
      atom(2, 100, 0),
      atom(3, 200, 0),
      atom(4, 300, 0),
      atom(5, 400, 0),
      atom(6), // no coords
    ];
    const bonds = [bond(1, 2), bond(2, 3), bond(3, 4), bond(4, 5), bond(5, 6)];
    expect(checkBondLengthOutliers({ atoms, bonds })).toEqual([]);
  });
});

// ── Case 4: below floor (insufficient sample) ─────────────────────────────

describe('below MIN_BONDS_FOR_MEDIAN floor', () => {
  it('returns [] for a 2-bond graph even with a 5× length spread', () => {
    // Only 2 coord-bearing bonds -> median unstable -> [] regardless of ratio.
    const atoms = [atom(1, 0, 0), atom(2, 100, 0), atom(3, 600, 0)];
    const bonds = [
      bond(1, 2), // 100px
      bond(2, 3), // 500px -> 5× the other, but sample too small
    ];
    expect(checkBondLengthOutliers({ atoms, bonds })).toEqual([]);
  });

  it('returns [] for an empty graph', () => {
    expect(checkBondLengthOutliers({ atoms: [], bonds: [] })).toEqual([]);
  });
});

// ── Case 5: integration — validate.ts wiring pushes an advisory warning ───

describe('validate.ts wiring — bond_length_outlier is an advisory WARNING', () => {
  const validateTool = validateTools[0];

  // A 5-bond coord-bearing chain + one 3× outlier, in validate_graph shape.
  function outlierGraph() {
    const coords: Record<number, { x: number; y: number }> = {
      1: { x: 0, y: 0 },
      2: { x: 100, y: 0 },
      3: { x: 200, y: 0 },
      4: { x: 300, y: 0 },
      5: { x: 400, y: 0 },
      6: { x: 700, y: 0 }, // 300px from 5 -> outlier
    };
    const atoms = [1, 2, 3, 4, 5, 6].map((id) => ({
      id,
      element: 'C',
      drawn_H: null as number | null,
      charge: 0,
      radical: 0 as 0 | 1 | 2,
      ring: null as string | null,
      x: coords[id].x,
      y: coords[id].y,
    }));
    const bonds = [
      { a: 1, b: 2 },
      { a: 2, b: 3 },
      { a: 3, b: 4 },
      { a: 4, b: 5 },
      { a: 5, b: 6 },
    ].map((b) => ({ ...b, order: 1 as const, wedge: null, wedge_from: null }));
    return {
      version: 1 as const,
      atoms,
      bonds,
      rings: [] as Array<{ id: string; atoms: number[]; kind: 'kekule' | 'aromatic' | 'aliphatic' }>,
      counts: { heavy: 6, rings: 0, heteroatoms: {} as Record<string, number> },
    };
  }

  it('pushes a bond_length_outlier warning and does NOT itself force ok:false', async () => {
    const ret = await validateTool.run({} as never, { graph: outlierGraph() });
    const data = (ret as {
      ok: boolean;
      data: {
        ok: boolean;
        diagnostics: Array<{ code: string; severity: string; note: string }>;
      };
    }).data;
    const hit = data.diagnostics.find((d) => d.code === 'bond_length_outlier');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warning');
    expect(hit!.note).toMatch(/skip atoms/i);
    // The outlier check is advisory: this graph (valid 6-carbon chain) stays ok.
    // (ok is governed by other validators; a clean chain validates true, and
    //  the warning never flips it.)
    expect(data.ok).toBe(true);
  });

  it('does NOT push the warning on a clean equal-length chain', async () => {
    const g = outlierGraph();
    // Pull atom 6 back to 500px so bond 5-6 == 100px (no outlier).
    const a6 = g.atoms.find((a) => a.id === 6)!;
    a6.x = 500;
    const ret = await validateTool.run({} as never, { graph: g });
    const data = (ret as { data: { diagnostics: Array<{ code: string }> } }).data;
    expect(data.diagnostics.some((d) => d.code === 'bond_length_outlier')).toBe(false);
  });
});

// Type-only assertion that the exported finding shape is what we expect.
const _typeCheck: BondLengthFinding = { kind: 'bond_length_outlier', note: '' };
void _typeCheck;
