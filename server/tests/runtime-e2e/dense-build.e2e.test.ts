/**
 * Phase 5 ratchet — verify the simplified build path can construct the
 * A004/A009/A011 dense molecules.
 *
 * Before 2026-05-26 the translator threw `tier_routing_gate_violation`
 * for any GraphIntent with >= 9 declared stereocenters on the direct
 * path (assertDenseRoutingConsistency). Removing that gate is part of
 * the dense-state-machine teardown; this test guards against latent
 * indigo-stereo bugs the gate was masking.
 *
 * Strategy: round-trip — load expected SMILES, extract atom/bond state,
 * derive an achiral skeleton GraphIntent, clear canvas, build via the
 * direct path, confirm the canvas has the same heavy-atom count. We
 * intentionally do NOT round-trip stereo (that's a separate problem;
 * the manifest-driven agent harness covers it). What we DO ratchet is
 * the architectural property: dense skeletons compile through the
 * simplified pipeline without being rejected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import type { GraphIntent } from '../../src/types/graph-intent';

const runE2E = process.env.RUN_KETCHER_E2E === '1';
const describeE2E = runE2E ? describe : describe.skip;

type DenseFixture = {
  id: string;
  label: string;
  smiles: string;
};

const DENSE_FIXTURES: DenseFixture[] = [
  {
    id: 'A004',
    label: 'paclitaxel',
    smiles:
      'CC(=O)O[C@H]1C(=O)[C@@]2(C)[C@H]([C@H](OC(=O)c3ccccc3)[C@]3(O)C[C@H](OC(=O)[C@H](O)[C@@H](NC(=O)c4ccccc4)c4ccccc4)C(C)=C1C3(C)C)[C@]1(OC(C)=O)CO[C@@H]1C[C@@H]2O',
  },
  {
    id: 'A009',
    label: 'vinblastine',
    smiles:
      'CC[C@@]1(O)CN2C[C@H](C[C@](C(OC)=O)(C3C=C4[C@@]56[C@@H](N(C)C4=CC=3OC)[C@@](O)(C(OC)=O)[C@H](OC(C)=O)[C@]3(CC)C=CCN([C@H]53)CC6)C3NC4C(=CC=CC=4)C=3CC2)C1',
  },
  {
    id: 'A011',
    label: 'hemibrevetoxin_b',
    smiles:
      'C[C@]12O[C@H]3[C@@H](O)C[C@@H](CC(C=O)=C)O[C@@H]3C[C@@H]1O[C@@H]1CC[C@@](O)(C)[C@@H](CC/C=C\\C=C)O[C@H]1CC2',
  },
];

function findAromaticRings(
  atomIds: number[],
  aromaticEdges: Array<{ a: number; b: number }>,
): number[][] {
  // Build adjacency limited to aromatic edges only, then enumerate the
  // shortest cycles each aromatic atom participates in. Ketcher loads
  // benzene-class rings as 6-cycles of order-4 bonds; this is enough to
  // recover them.
  const adj = new Map<number, Set<number>>();
  for (const id of atomIds) adj.set(id, new Set());
  for (const e of aromaticEdges) {
    adj.get(e.a)?.add(e.b);
    adj.get(e.b)?.add(e.a);
  }
  const rings: number[][] = [];
  const seen = new Set<string>();
  for (const start of atomIds) {
    const nbrs = adj.get(start);
    if (!nbrs || nbrs.size === 0) continue;
    // BFS from start back to start through aromatic edges only, length 5-7
    const queue: Array<{ node: number; path: number[] }> = [
      { node: start, path: [start] },
    ];
    while (queue.length) {
      const { node, path } = queue.shift()!;
      if (path.length > 7) continue;
      for (const n of adj.get(node) ?? []) {
        if (n === start && path.length >= 5) {
          const sorted = [...path].sort((x, y) => x - y);
          const key = sorted.join('-');
          if (!seen.has(key)) {
            seen.add(key);
            rings.push(path);
          }
          continue;
        }
        if (path.includes(n)) continue;
        queue.push({ node: n, path: [...path, n] });
      }
    }
  }
  return rings;
}

async function skeletonFromCanvas(runtime: KetcherRuntime, label: string): Promise<GraphIntent> {
  const state = await runtime.getState(false);
  const atoms = state.atoms.map((a) => ({
    id: a.id,
    element: a.label,
    drawn_H: null,
    // Ketcher returns charge as null for neutral atoms; the schema requires
    // an int -4..4. Coerce.
    charge: a.charge ?? 0,
    radical: (a.radical ?? 0) as 0 | 1 | 2,
    ring: null,
    // Skeleton fixture has no stereo declaration. Indigo's
    // assertNoUndefinedStereoPostBuild will perceive the molecule's
    // stereocenters and demand each be addressed (entry or explicit
    // skip). Mark every atom as `stereo_unknown` — W5's all-unknown
    // cheat blocker was removed in Phase 2c, so this is now legal
    // build-time; the grader's chemistry_gate catches the all-
    // unspecified cheat at result time.
    stereo_unknown: true as const,
  }));
  // Ketcher encodes aromatic bonds with order=4. The translator's bond
  // schema only accepts 1/2/3; declare aromatic rings explicitly and
  // demote the aromatic edges to order=1 (translator's aromatize pass
  // promotes them back to 4 via setBondOrder).
  const aromaticEdges = state.bonds
    .filter((b) => b.order === 4)
    .map((b) => ({ a: b.beginAtomId, b: b.endAtomId }));
  const aromaticAtomIds = new Set<number>();
  for (const e of aromaticEdges) {
    aromaticAtomIds.add(e.a);
    aromaticAtomIds.add(e.b);
  }
  const aromaticRings = findAromaticRings([...aromaticAtomIds], aromaticEdges);
  const bonds = state.bonds.map((b) => ({
    a: b.beginAtomId,
    b: b.endAtomId,
    order: (b.order === 4 ? 1 : b.order) as 1 | 2 | 3,
    wedge: null,
    wedge_from: null,
  }));
  const heteroatoms: Record<string, number> = {};
  for (const a of atoms) {
    if (a.element !== 'C' && a.element !== 'H') {
      heteroatoms[a.element] = (heteroatoms[a.element] ?? 0) + 1;
    }
  }
  return {
    version: 1 as const,
    label,
    atoms,
    bonds,
    rings: aromaticRings.map((atomIds, i) => ({
      id: `ar${i + 1}`,
      atoms: atomIds,
      kind: 'aromatic' as const,
    })),
    counts: {
      heavy: atoms.length,
      rings: aromaticRings.length,
      heteroatoms,
    },
  };
}

describeE2E('build_from_graph dense skeleton ratchet', () => {
  const runtime = new KetcherRuntime();

  beforeAll(async () => {
    await runtime.start();
  }, 180000);

  afterAll(async () => {
    await runtime.stop();
  });

  for (const fixture of DENSE_FIXTURES) {
    it(`builds ${fixture.id} (${fixture.label}) achiral skeleton via simplified path`, async () => {
      await runtime.callBridge('clearCanvas');
      await runtime.callBridge('loadSmiles', fixture.smiles);
      const skeleton = await skeletonFromCanvas(runtime, fixture.label);

      // Sanity — fixture must be dense enough to have exercised the
      // deleted dense-routing gate (>= 9 stereocenters in the expected
      // SMILES). A004 has 62+ heavy atoms; A009 has 59; A011 has 35.
      expect(skeleton.atoms.length).toBeGreaterThanOrEqual(30);

      await runtime.callBridge('clearCanvas');
      const buildResult = await runtime.applyMutation(
        'build_from_graph',
        { validate_counts: false, layout: 'auto' },
        async () => {
          // validate_counts off — the skeleton fixture intentionally drops
          // ring/stereo metadata so observed SSSR counts won't match
          // declared. The ratchet asserts the build PATH executes through
          // a 60-atom + 9-stereocenter case, not that counts roundtrip.
          await translateGraphIntent(runtime, skeleton, {
            validate_counts: false,
            layout: 'auto',
          });
        },
      );

      expect(buildResult.after.smiles).toBeTruthy();
      expect(buildResult.after.atoms.length).toBe(skeleton.atoms.length);
      expect(buildResult.after.bonds.length).toBe(skeleton.bonds.length);
    }, 120000);
  }
});
