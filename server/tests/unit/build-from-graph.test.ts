import { describe, expect, it } from 'vitest';
import { validateGraphIntent } from '../../src/adapter/graph-intent/validator';
import { bfsComponents, bfsOrder } from '../../src/adapter/graph-intent/components';
import { computeCounts, diffCounts } from '../../src/adapter/graph-intent/counts';
import { radicalCodeFromCount } from '../../src/adapter/graph-intent/radical';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import { parseV2000, setV2000ChiralFlag, writeV2000 } from '../../src/adapter/graph-intent/molfile-stereo';
import {
  edgeKey,
  graphIntentSchema,
  type GraphIntent,
} from '../../src/types/graph-intent';

function benzene(): GraphIntent {
  return {
    version: 1,
    label: 'benzene',
    atoms: [1, 2, 3, 4, 5, 6].map((id) => ({
      id,
      element: 'C',
      drawn_H: null,
      charge: 0,
      radical: 0 as const,
      ring: 'r1',
    })),
    bonds: [
      { a: 1, b: 2, order: 2, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 3, b: 4, order: 2, wedge: null, wedge_from: null },
      { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
      { a: 5, b: 6, order: 2, wedge: null, wedge_from: null },
      { a: 6, b: 1, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [{ id: 'r1', atoms: [1, 2, 3, 4, 5, 6], kind: 'kekule' }],
    counts: { heavy: 6, rings: 1, heteroatoms: {} },
  };
}

function aromaticBenzeneFromSingleBonds(): GraphIntent {
  const graph = benzene();
  graph.bonds = graph.bonds.map((bond) => ({ ...bond, order: 1 as const }));
  graph.rings = [{ id: 'r1', atoms: [1, 2, 3, 4, 5, 6], kind: 'aromatic' }];
  return graph;
}

function sodiumAcetate(): GraphIntent {
  return {
    version: 1,
    label: 'sodium acetate',
    atoms: [
      { id: 1, element: 'Na', drawn_H: 0, charge: 1, radical: 0, ring: null },
      { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 4, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 5, element: 'O', drawn_H: 0, charge: -1, radical: 0, ring: null },
    ],
    bonds: [
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 3, b: 4, order: 2, wedge: null, wedge_from: null },
      { a: 3, b: 5, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 5, rings: 0, heteroatoms: { Na: 1, O: 2 } },
  };
}

describe('validateGraphIntent', () => {
  it('accepts a valid benzene intent', () => {
    const result = validateGraphIntent(benzene());
    expect(result.valid).toBe(true);
  });

  it('accepts a multi-fragment salt', () => {
    const result = validateGraphIntent(sodiumAcetate());
    expect(result.valid).toBe(true);
  });

  it('rejects a dangling bond reference', () => {
    const graph = benzene();
    graph.bonds.push({ a: 1, b: 99, order: 1, wedge: null, wedge_from: null });
    graph.counts.heavy = 6; // unchanged
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => /unknown atom id 99/.test(e.message))).toBe(true);
    }
  });

  it('rejects a missing ring atom id', () => {
    const graph = benzene();
    graph.rings[0].atoms = [1, 2, 3, 4, 5, 42];
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.path.startsWith('rings[0].atoms[5]'))).toBe(true);
    }
  });

  it('rejects wedge with null wedge_from', () => {
    const graph = benzene();
    graph.bonds[0] = { a: 1, b: 2, order: 1, wedge: 'solid', wedge_from: null };
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => /wedge_from required/.test(e.message))).toBe(true);
    }
  });

  it('rejects wedge_from that is not an endpoint', () => {
    const graph = benzene();
    graph.bonds[0] = { a: 1, b: 2, order: 1, wedge: 'solid', wedge_from: 3 };
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => /wedge_from must equal/.test(e.message))).toBe(true);
    }
  });

  it('rejects wedge on a non-single bond', () => {
    const graph = benzene();
    graph.bonds[0] = { a: 1, b: 2, order: 2, wedge: 'solid', wedge_from: 1 };
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => /wedge only valid on single/.test(e.message))).toBe(true);
    }
  });

  it('rejects mismatched counts.heavy', () => {
    const graph = benzene();
    graph.counts.heavy = 7;
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.path === 'counts.heavy')).toBe(true);
    }
  });

  it('rejects mismatched heteroatom totals', () => {
    const graph = sodiumAcetate();
    graph.counts.heteroatoms = { Na: 1, O: 3 };
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.path === 'counts.heteroatoms.O')).toBe(true);
    }
  });

  it('rejects a carbon whose explicit valence exceeds 4', () => {
    const graph: GraphIntent = {
      version: 1,
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 5, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 6, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      ],
      bonds: [
        { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
        { a: 1, b: 3, order: 1, wedge: null, wedge_from: null },
        { a: 1, b: 4, order: 1, wedge: null, wedge_from: null },
        { a: 1, b: 5, order: 1, wedge: null, wedge_from: null },
        { a: 1, b: 6, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [],
      counts: { heavy: 6, rings: 0, heteroatoms: {} },
    };
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => /supported carbon valence 4 \(V11\)/.test(e.message))).toBe(true);
    }
  });

  it('rejects unknown top-level fields (strict mode)', () => {
    const result = validateGraphIntent({ ...benzene(), surprise: 'rejected' });
    expect(result.valid).toBe(false);
  });
});

describe('bfsComponents + bfsOrder', () => {
  it('returns one component for benzene with BFS order starting at seed', () => {
    const comps = bfsComponents(benzene());
    expect(comps).toHaveLength(1);
    expect(comps[0].atoms).toEqual([1, 2, 3, 4, 5, 6]);
    expect(bfsOrder(comps[0])[0]).toBe(1);
  });

  it('returns two components for sodium acetate', () => {
    const comps = bfsComponents(sodiumAcetate());
    expect(comps).toHaveLength(2);
    const sizes = comps.map((c) => c.atoms.length).sort();
    expect(sizes).toEqual([1, 4]);
  });
});

describe('edgeKey', () => {
  it('canonicalizes edge ordering', () => {
    expect(edgeKey(3, 1)).toBe('1-3');
    expect(edgeKey(1, 3)).toBe('1-3');
  });
});

describe('computeCounts + diffCounts', () => {
  it('computes counts from a synthetic AgentState (benzene)', () => {
    const counts = computeCounts({
      atoms: [1, 2, 3, 4, 5, 6].map((id) => ({
        id,
        label: 'C',
        charge: 0,
        radical: 0,
        x: 0,
        y: 0,
      })),
      bonds: [
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 5],
        [5, 6],
        [6, 1],
      ].map(([a, b], i) => ({
        id: i,
        beginAtomId: a,
        endAtomId: b,
        order: 1,
        stereo: 0,
      })),
    });
    expect(counts.heavy).toBe(6);
    expect(counts.rings).toBe(1);
    expect(counts.heteroatoms).toEqual({});
  });

  it('buckets halogens', () => {
    const counts = computeCounts({
      atoms: [
        { id: 1, label: 'C', charge: 0, radical: 0, x: 0, y: 0 },
        { id: 2, label: 'Cl', charge: 0, radical: 0, x: 0, y: 0 },
        { id: 3, label: 'Br', charge: 0, radical: 0, x: 0, y: 0 },
        { id: 4, label: 'F', charge: 0, radical: 0, x: 0, y: 0 },
      ],
      bonds: [],
    });
    expect(counts.heteroatoms).toEqual({ halogens: 3 });
  });

  it('diffs cleanly when counts agree', () => {
    expect(
      diffCounts(
        { heavy: 6, rings: 1, heteroatoms: {} },
        { heavy: 6, rings: 1, heteroatoms: {} },
      ),
    ).toEqual([]);
  });

  it('reports diff fields when counts disagree', () => {
    const diff = diffCounts(
      { heavy: 6, rings: 1, heteroatoms: { N: 1 } },
      { heavy: 7, rings: 1, heteroatoms: {} },
    );
    expect(diff.find((d) => d.field === 'heavy')).toEqual({
      field: 'heavy',
      expected: 6,
      observed: 7,
    });
    expect(diff.find((d) => d.field === 'heteroatoms.N')).toEqual({
      field: 'heteroatoms.N',
      expected: 1,
      observed: 0,
    });
  });
});

describe('radicalCodeFromCount', () => {
  it('maps 0 → 0 (NONE)', () => {
    expect(radicalCodeFromCount(0)).toBe(0);
  });
  it('maps 1 → 2 (DOUBLET — the Ketcher footgun)', () => {
    expect(radicalCodeFromCount(1)).toBe(2);
  });
  it('maps 2 → 3 (TRIPLET)', () => {
    expect(radicalCodeFromCount(2)).toBe(3);
  });
});

describe('V2000 stereo utilities', () => {
  it('sets the counts-line chiral flag to absolute stereo', () => {
    const parsed = parseV2000([
      'test',
      '  Ketcher',
      '',
      '  2  1  0  0  0  0            999 V2000',
      '    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
      '    1.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
      '  1  2  1  0  0  0  0',
      'M  END',
    ].join('\n'));

    setV2000ChiralFlag(parsed, true);

    expect(writeV2000(parsed).split(/\r?\n/)[3].slice(12, 15)).toBe('  1');
  });
});

// --- Plan PLAN-coord-pinning.md unit tests (1-9) ---

function chiralCenterIntent(opts: {
  withAllCoords?: boolean;
  dropAtomId?: number;
}): GraphIntent {
  // Tetrahedral C (id=1) with 4 distinct heavy neighbors (ids 2..5), wedge on bond 1-2.
  const all: Array<[number, string, number, number]> = [
    [1, 'C', 0, 0],
    [2, 'N', 0, -1],
    [3, 'C', 1, 0],
    [4, 'O', 0, 1],
    [5, 'C', -1, 0],
  ];
  const atoms = all.map(([id, element, x, y]) => {
    const base = {
      id,
      element,
      drawn_H: null,
      charge: 0,
      radical: 0 as const,
      ring: null,
    };
    if (opts.withAllCoords && id !== opts.dropAtomId) {
      return { ...base, x, y };
    }
    return base;
  });
  return {
    version: 1,
    atoms,
    bonds: [
      { a: 1, b: 2, order: 1, wedge: 'solid', wedge_from: 1 },
      { a: 1, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 1, b: 4, order: 1, wedge: null, wedge_from: null },
      { a: 1, b: 5, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 5, rings: 0, heteroatoms: { N: 1, O: 1 } },
  };
}

function butene(): GraphIntent {
  // C1=C2-C3 with H on C1, methyl C4 on C2 → simplified scaffold for geom tests.
  // ids 1,2,3,4 — bond 1=2 is the double bond.
  return {
    version: 1,
    atoms: [
      { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 0, y: 0 },
      { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 1, y: 0 },
      { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: -1, y: 1 },
      { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 2, y: 1 },
    ],
    bonds: [
      { a: 1, b: 2, order: 2, wedge: null, wedge_from: null, geom: 'cis' },
      { a: 1, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 4, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 4, rings: 0, heteroatoms: {} },
  };
}

describe('plan: schema + validator extensions', () => {
  // Test 1
  it('schema accepts atom with x, y', () => {
    const parsed = graphIntentSchema.safeParse({
      version: 1,
      atoms: [{ id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 1.5, y: -2.0 }],
      bonds: [],
      rings: [],
      counts: { heavy: 1, rings: 0, heteroatoms: {} },
    });
    expect(parsed.success).toBe(true);
  });

  // Test 2: V2 chiral cluster missing one neighbor coord
  it('V2 rejects wedge cluster with one neighbor missing coords', () => {
    const graph = chiralCenterIntent({ withAllCoords: true, dropAtomId: 5 });
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => /V2/.test(e.message))).toBe(true);
    }
  });

  // Test 3: V3 bond.geom on order=1
  it('V3 rejects bond.geom on order=1', () => {
    const graph: GraphIntent = {
      version: 1,
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 0, y: 0 },
        { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 1, y: 0 },
      ],
      bonds: [{ a: 1, b: 2, order: 1, wedge: null, wedge_from: null, geom: 'cis' }],
      rings: [],
      counts: { heavy: 2, rings: 0, heteroatoms: {} },
    };
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => /V3/.test(e.message))).toBe(true);
    }
  });

  // Test 4: V4 removed — geom no longer requires coords (label-authoritative E/Z)
  it('geom bond with missing coords is now valid (V4 removed)', () => {
    const graph = butene();
    delete (graph.atoms[1] as any).x;
    delete (graph.atoms[1] as any).y;
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(true);
  });

  // Test 5: V5 wedge + geom mutually exclusive
  it('V5 rejects bond with both wedge and geom', () => {
    const graph = butene();
    graph.bonds[0] = { a: 1, b: 2, order: 1, wedge: 'solid', wedge_from: 1, geom: 'cis' };
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => /V5/.test(e.message))).toBe(true);
    }
  });

  // Test 6: V6 drawn_H_atoms claims an id whose atom has drawn_H=null
  it('V6 rejects drawn_H_atoms naming an atom with drawn_H=null', () => {
    const graph: GraphIntent = {
      version: 1,
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      ],
      bonds: [
        { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [],
      counts: { heavy: 3, rings: 0, heteroatoms: {}, drawn_H_atoms: [3] },
    };
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => /V6/.test(e.message))).toBe(true);
    }
  });

  // Test 7: V6 atom has drawn_H=1 but drawn_H_atoms is empty
  it('V6 rejects when atom has drawn_H!=null but drawn_H_atoms omits it', () => {
    const graph: GraphIntent = {
      version: 1,
      atoms: [
        { id: 1, element: 'N', drawn_H: 2, charge: 0, radical: 0, ring: null },
        { id: 5, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
      ],
      bonds: [{ a: 1, b: 5, order: 1, wedge: null, wedge_from: null }],
      rings: [],
      counts: { heavy: 2, rings: 0, heteroatoms: { N: 1, O: 1 }, drawn_H_atoms: [1] },
    };
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => /V6/.test(e.message))).toBe(true);
    }
  });

  // Test 8: V7 degree_sequence mismatch
  it('V7 rejects degree_sequence that disagrees with computed', () => {
    const graph: GraphIntent = {
      ...benzene(),
      counts: {
        heavy: 6,
        rings: 1,
        heteroatoms: {},
        // benzene actual degree: each C has degree 3 (one double + one single + one single, sum=3).
        degree_sequence: [
          ['C', 1],
          ['C', 2],
          ['C', 3],
          ['C', 3],
          ['C', 3],
          ['C', 3],
        ],
      },
    };
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => /V7/.test(e.message))).toBe(true);
    }
  });

  it('V7 accepts degree_sequence that matches computed', () => {
    const graph: GraphIntent = {
      ...benzene(),
      counts: {
        heavy: 6,
        rings: 1,
        heteroatoms: {},
        degree_sequence: [
          ['C', 3],
          ['C', 3],
          ['C', 3],
          ['C', 3],
          ['C', 3],
          ['C', 3],
        ],
      },
    };
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(true);
  });

  // Removed 2026-05-26: V10 'dense declared stereo must not use wedge-primary
  // encoding' check. Deleted alongside topologyLedger / coverageCheck /
  // stereoMode schema fields when the dense state machine was torn out.
  // Mode C selective V2000 solver re-apply (mode-c-cip.ts) handles K>=9
  // wedge-primary encoding without gating; ratchet lives in
  // mode-c-cip-selective-reapply.test.ts.
});

// Test 9: setAtomXY pass is single-shot (idempotent — translator emits one
// setAtomXY per coord-bearing atom, never twice). Uses a fake runtime that
// records every bridge call.
describe('plan: translator setAtomXY pass', () => {
  type FakeRuntime = {
    callBridge: (method: string, ...args: unknown[]) => Promise<any>;
    getState: () => Promise<any>;
    callLog: Array<{ method: string; args: unknown[] }>;
  };

  function makeFakeRuntime(): FakeRuntime {
    const callLog: Array<{ method: string; args: unknown[] }> = [];
    let nextAtomId = 100;
    let nextBondId = 200;
    const atoms: Array<{ id: number; label: string }> = [];
    const bonds: Array<{ id: number; beginAtomId: number; endAtomId: number; order: number; stereo: number }> = [];
    const rt: any = {
      callLog,
      callBridge: async (method: string, ...args: unknown[]) => {
        callLog.push({ method, args });
        if (method === 'addFragment') {
          const id = nextAtomId++;
          atoms.push({ id, label: (args[0] as string).replace(/[\[\]]/g, '') });
          return { atomId: id };
        }
        if (method === 'addAtomWithSingleBond') {
          const id = nextAtomId++;
          const bondId = nextBondId++;
          atoms.push({ id, label: args[1] as string });
          bonds.push({
            id: bondId,
            beginAtomId: args[0] as number,
            endAtomId: id,
            order: 1,
            stereo: 0,
          });
          return { beginAtomId: args[0], endAtomId: id, bondId };
        }
        if (method === 'addBond') {
          const bondId = nextBondId++;
          bonds.push({
            id: bondId,
            beginAtomId: args[0] as number,
            endAtomId: args[1] as number,
            order: args[2] as number,
            stereo: 0,
          });
          return { beginAtomId: args[0], endAtomId: args[1], bondId };
        }
        return undefined;
      },
      getState: async () => ({
        smiles: null,
        ket: null,
        molfile: null,
        isEmpty: atoms.length === 0,
        isReaction: false,
        hasExportFailure: false,
        exportErrorMessage: null,
        atoms: atoms.map((a) => ({ id: a.id, label: a.label, charge: 0, radical: 0, x: 0, y: 0 })),
        bonds,
      }),
    };
    return rt as FakeRuntime;
  }

  it('emits exactly one setAtomXY per coord-bearing atom (no duplicate calls)', async () => {
    const graph = chiralCenterIntent({ withAllCoords: true });
    const rt = makeFakeRuntime();
    await translateGraphIntent(rt as any, graph, { validate_counts: false, layout: 'preserve' });
    const xyCalls = rt.callLog.filter((c) => c.method === 'setAtomXY');
    expect(xyCalls.length).toBe(5);
    // Each canvas atom id appears exactly once.
    const seen = new Set<number>();
    for (const c of xyCalls) {
      const id = c.args[0] as number;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it('skips clean() when coords are present and layout=auto', async () => {
    const graph = chiralCenterIntent({ withAllCoords: true });
    const rt = makeFakeRuntime();
    await translateGraphIntent(rt as any, graph, { validate_counts: false, layout: 'auto' });
    expect(rt.callLog.some((c) => c.method === 'clean')).toBe(false);
  });

  it('runs clean() when no coords are present and layout=auto', async () => {
    const rt = makeFakeRuntime();
    await translateGraphIntent(rt as any, benzene(), { validate_counts: false, layout: 'auto' });
    expect(rt.callLog.some((c) => c.method === 'clean')).toBe(true);
  });

  it('applies aromatic ring intent even when ring bonds are transcribed as single', async () => {
    const rt = makeFakeRuntime();
    await translateGraphIntent(rt as any, aromaticBenzeneFromSingleBonds(), {
      validate_counts: false,
      layout: 'preserve',
    });
    const aromaticBondCalls = rt.callLog.filter(
      (c) => c.method === 'setBondOrder' && c.args[1] === 4,
    );
    expect(aromaticBondCalls).toHaveLength(6);
  });

  // Removed 2026-05-26: 'rejects wedge-primary encoding for dense declared-
  // center rows' + 'allows worksheet-backed dense stereo evidence to use
  // committed legacy wedges'. The dense-routing-gate
  // (assertDenseRoutingConsistency) was deleted along with topologyLedger /
  // coverageCheck / stereoMode schema fields. Mode C selective V2000 solver
  // re-apply (mode-c-cip.ts) handles K>=9 without build-time gating;
  // ratchet lives in mode-c-cip-selective-reapply.test.ts.
});

// --- Plan PLAN-scaffolding-upgrade.md — wedge_to_implicit_h + stereo_unknown ---

function ringJunctionWithImplicitHWedge(opts: {
  coordsOn?: Set<number>;
  wedge?: 'solid' | 'hashed' | null;
  stereoUnknown?: boolean;
}): GraphIntent {
  // Synthetic ring-junction chiral C (id=1) with three heavy neighbors (2..4)
  // and an implicit H wedge. Coord pinned cluster by default.
  const coords = opts.coordsOn ?? new Set([1, 2, 3, 4]);
  const layout: Array<[number, number, number]> = [
    [1, 0, 0],
    [2, 1, 0],
    [3, -1, 0],
    [4, 0, 1],
  ];
  const atoms = layout.map(([id, x, y]) => {
    const base: any = {
      id,
      element: 'C',
      drawn_H: null,
      charge: 0,
      radical: 0 as const,
      ring: null,
    };
    if (coords.has(id)) {
      base.x = x;
      base.y = y;
    }
    if (id === 1) {
      if (opts.wedge !== undefined) base.wedge_to_implicit_h = opts.wedge;
      if (opts.stereoUnknown) base.stereo_unknown = true;
    }
    return base;
  });
  return {
    version: 1,
    atoms,
    bonds: [
      { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
      { a: 1, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 1, b: 4, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 4, rings: 0, heteroatoms: {} },
  };
}

describe('plan: scaffolding upgrade — schema + validator', () => {
  it('schema accepts atom with wedge_to_implicit_h: "solid"', () => {
    const parsed = graphIntentSchema.safeParse({
      version: 1,
      atoms: [
        {
          id: 1,
          element: 'C',
          drawn_H: null,
          charge: 0,
          radical: 0,
          ring: null,
          wedge_to_implicit_h: 'solid',
        },
      ],
      bonds: [],
      rings: [],
      counts: { heavy: 1, rings: 0, heteroatoms: {} },
    });
    expect(parsed.success).toBe(true);
  });

  it('schema accepts atom with stereo_unknown: true', () => {
    const parsed = graphIntentSchema.safeParse({
      version: 1,
      atoms: [
        {
          id: 1,
          element: 'C',
          drawn_H: null,
          charge: 0,
          radical: 0,
          ring: null,
          stereo_unknown: true,
        },
      ],
      bonds: [],
      rings: [],
      counts: { heavy: 1, rings: 0, heteroatoms: {} },
    });
    expect(parsed.success).toBe(true);
  });

  it('V8 rejects wedge_to_implicit_h cluster missing a neighbor coord', () => {
    const graph = ringJunctionWithImplicitHWedge({
      coordsOn: new Set([1, 2, 3]), // drops atom 4's coords
      wedge: 'hashed',
    });
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => /V8/.test(e.message))).toBe(true);
    }
  });

  it('V8 accepts fully coord-pinned wedge_to_implicit_h cluster', () => {
    const graph = ringJunctionWithImplicitHWedge({ wedge: 'solid' });
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(true);
  });

  it('stereo_unknown has no V8 constraint (no coord requirement)', () => {
    const graph = ringJunctionWithImplicitHWedge({
      coordsOn: new Set(),
      stereoUnknown: true,
    });
    const result = validateGraphIntent(graph);
    expect(result.valid).toBe(true);
  });
});

describe('plan: scaffolding upgrade — translator passes', () => {
  type FakeRuntime = {
    callBridge: (method: string, ...args: unknown[]) => Promise<any>;
    getState: () => Promise<any>;
    getAnnotatedState: () => Promise<any>;
    callLog: Array<{ method: string; args: unknown[] }>;
  };

  function makeFakeRuntime(initialImplicitH = 1): FakeRuntime {
    const callLog: Array<{ method: string; args: unknown[] }> = [];
    let nextAtomId = 100;
    let nextBondId = 200;
    const atoms: Array<{ id: number; label: string; x: number; y: number; implicitH: number }> = [];
    const bonds: Array<{ id: number; beginAtomId: number; endAtomId: number; order: number; stereo: number }> = [];
    const rt: any = {
      callLog,
      callBridge: async (method: string, ...args: unknown[]) => {
        callLog.push({ method, args });
        if (method === 'addFragment') {
          const id = nextAtomId++;
          atoms.push({
            id,
            label: (args[0] as string).replace(/[\[\]]/g, ''),
            x: 0,
            y: 0,
            implicitH: initialImplicitH,
          });
          return { atomId: id };
        }
        if (method === 'addAtomWithSingleBond') {
          const id = nextAtomId++;
          const bondId = nextBondId++;
          atoms.push({
            id,
            label: args[1] as string,
            x: 0,
            y: 0,
            implicitH: 0,
          });
          bonds.push({
            id: bondId,
            beginAtomId: args[0] as number,
            endAtomId: id,
            order: 1,
            stereo: 0,
          });
          return { beginAtomId: args[0], endAtomId: id, bondId };
        }
        if (method === 'addBond') {
          const bondId = nextBondId++;
          bonds.push({
            id: bondId,
            beginAtomId: args[0] as number,
            endAtomId: args[1] as number,
            order: args[2] as number,
            stereo: 0,
          });
          return { beginAtomId: args[0], endAtomId: args[1], bondId };
        }
        if (method === 'setAtomImplicitHCount') {
          const a = atoms.find((x) => x.id === (args[0] as number));
          if (a) a.implicitH = args[1] as number;
          return undefined;
        }
        if (method === 'setAtomXY') {
          const a = atoms.find((x) => x.id === (args[0] as number));
          if (a) {
            a.x = args[1] as number;
            a.y = args[2] as number;
          }
          return undefined;
        }
        return undefined;
      },
      getState: async () => ({
        smiles: null,
        ket: null,
        molfile: null,
        isEmpty: atoms.length === 0,
        isReaction: false,
        hasExportFailure: false,
        exportErrorMessage: null,
        atoms: atoms.map((a) => ({ id: a.id, label: a.label, charge: 0, radical: 0, x: a.x, y: a.y })),
        bonds,
      }),
      getAnnotatedState: async () => ({
        atoms: atoms.map((a) => ({ id: a.id, label: a.label, x: a.x, y: a.y, implicitH: a.implicitH })),
        bonds,
      }),
    };
    return rt as FakeRuntime;
  }

  it('wedge_to_implicit_h: decrements implicit H, adds explicit H, applies wedge', async () => {
    const graph = ringJunctionWithImplicitHWedge({ wedge: 'solid' });
    const rt = makeFakeRuntime(1); // parent C has implicitH=1
    await translateGraphIntent(rt as any, graph, { validate_counts: false, layout: 'preserve' });
    const setHCalls = rt.callLog.filter((c) => c.method === 'setAtomImplicitHCount');
    expect(setHCalls.length).toBeGreaterThanOrEqual(1);
    // Look for a call that decrements parent's implicit H to 0.
    expect(setHCalls.some((c) => c.args[1] === 0)).toBe(true);
    // addAtomWithSingleBond with 'H' element exists.
    expect(rt.callLog.some((c) => c.method === 'addAtomWithSingleBond' && c.args[1] === 'H')).toBe(
      true,
    );
    // setWedgeBond invoked from parent to the new H.
    expect(rt.callLog.some((c) => c.method === 'setWedgeBond' && c.args[2] === 'solid')).toBe(true);
  });

  it('stereo_unknown is a no-op (no canvas mutation for it)', async () => {
    const graph = ringJunctionWithImplicitHWedge({
      coordsOn: new Set(),
      stereoUnknown: true,
    });
    const rt = makeFakeRuntime(0);
    await translateGraphIntent(rt as any, graph, { validate_counts: false, layout: 'preserve' });
    // No wedge / no extra H atoms / no setAtomImplicitHCount for stereo_unknown.
    expect(rt.callLog.some((c) => c.method === 'setWedgeBond')).toBe(false);
    expect(rt.callLog.some((c) => c.method === 'addAtomWithSingleBond' && c.args[1] === 'H')).toBe(
      false,
    );
  });
});
