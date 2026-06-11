/**
 * Task 5A — FEATURE-PARITY GATE: stereo_group round-trip (ADDED honoring).
 *
 * `atom.stereo_group` ({ kind: abs|rel|or|and, id }) — MDL enhanced/relative
 * stereo — was in the direct GraphIntent schema (LOCK 23) but had NO consumer
 * anywhere (translator/compiler/build all dropped it). This proves the added
 * translator pass: a direct GraphIntent carrying a defined stereocenter PLUS a
 * stereo_group round-trips the enhanced-stereo group through real Ketcher.
 *
 * Surface choice (verified empirically, see report): the V2000 molfile export
 * this repo uses does NOT carry an enhanced-stereo collection (collections are
 * a V3000 feature and Indigo's convert strips Ketcher's stereoLabel). The
 * surface that DOES carry it is Ketcher's extended-SMILES group block:
 *   C[C@](Br)(Cl)F |&1:1,r|     (AND group on atom index 1)
 *   ...                |o1:1,r|  / |&1:...| etc.
 * So the round-trip assertion reads exportSmiles and checks for the |&n:…| /
 * |o…| extended block.
 *
 * Ordering is load-bearing: the group MUST be applied AFTER the parity pass —
 * the layout-locked solver writes the committed center's stereoLabel to "abs",
 * which would clobber an enhanced group applied earlier (the bug this test
 * pins). RUN_KETCHER_E2E=1 gated.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import type { GraphIntent } from '../../src/types/graph-intent';

const runE2E = process.env.RUN_KETCHER_E2E === '1';
const describeE2E = runE2E ? describe : describe.skip;

// CC(F)(Cl)Br with a defined center (id 2) via a wedge primitive, plus an
// enhanced-stereo group on that center. `kind` drives the collection type.
function chbrclfWithGroup(
  kind: 'and' | 'or' | 'abs',
  id: number,
): GraphIntent {
  return {
    version: 1,
    label: `CC(F)(Cl)Br ${kind}${id}`,
    layoutPolicy: 'ketcher_clean_locked',
    atoms: [
      { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      {
        id: 2,
        element: 'C',
        drawn_H: null,
        charge: 0,
        radical: 0,
        ring: null,
        stereo_group: { kind, id },
      },
      { id: 3, element: 'F', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 4, element: 'Cl', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 5, element: 'Br', drawn_H: null, charge: 0, radical: 0, ring: null },
    ],
    bonds: [
      { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 4, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 5, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 5, rings: 0, heteroatoms: { halogens: 3 } },
    stereoTransfer: [
      {
        center: 2,
        drawnNeighborsCW: [5, 4, 3, 1],
        outOfPlaneNeighbor: 5,
        facing: 'toward',
        projection: 'wedge',
        confidence: 1,
      },
    ],
  };
}

describeE2E('Task 5A stereo_group round-trip (direct → extended SMILES)', () => {
  const runtime = new KetcherRuntime();

  beforeAll(async () => {
    await runtime.start();
  }, 180000);

  afterAll(async () => {
    await runtime.stop();
  });

  async function buildAndExport(graph: GraphIntent): Promise<string> {
    await runtime.callBridge('clearCanvas');
    await runtime.applyMutation(
      'build_from_graph',
      { validate_counts: true, layout: 'auto' },
      async () => {
        await translateGraphIntent(runtime, graph, {
          validate_counts: true,
          layout: 'auto',
        });
      },
    );
    return (await runtime.getState(false)).smiles ?? '';
  }

  // AND group → extended-SMILES `|&1:…|` block. The defined parity (@/@@) is
  // also present; the load-bearing assertion is that the AND group rides on
  // top of it, proving the stereoLabel was applied and not dropped/clobbered.
  it('and1 stereo group emits a |&1:…| extended-SMILES block', async () => {
    const smiles = await buildAndExport(chbrclfWithGroup('and', 1));
    expect(/@/.test(smiles)).toBe(true); // parity survives
    expect(/\|&1:/.test(smiles)).toBe(true); // AND group rides on it
  }, 120000);

  // OR group → `|o1:…|` block (Ketcher serializes OR as `o<n>` in the SMILES
  // group block).
  it('or1 stereo group emits a |o1:…| (OR) extended-SMILES block', async () => {
    const smiles = await buildAndExport(chbrclfWithGroup('or', 1));
    expect(/@/.test(smiles)).toBe(true);
    expect(/\|o1:|\|or1:/.test(smiles)).toBe(true);
  }, 120000);

  // abs vs and1 must produce DIFFERENT exports — the group label is what
  // distinguishes them (same parity, different group), so this proves the
  // group is load-bearing and not silently collapsed to the default abs.
  it('and1 and abs produce different exported SMILES (group is load-bearing)', async () => {
    const andSmiles = await buildAndExport(chbrclfWithGroup('and', 1));
    const absSmiles = await buildAndExport(chbrclfWithGroup('abs', 1));
    expect(andSmiles).not.toEqual(absSmiles);
    // The AND export carries the explicit group; abs does not.
    expect(/\|&1:/.test(andSmiles)).toBe(true);
    expect(/\|&1:/.test(absSmiles)).toBe(false);
  }, 120000);
});
