/**
 * Phase 6 Task 6B — adjacent-chiral fused-ring stereo e2e (committed build).
 *
 * Proves that TWO adjacent stereocenters that SHARE a ring-fusion bond BOTH
 * resolve correctly, built from WEDGE PRIMITIVES (per-bond `wedge` /
 * `wedge_from` + atom `stereo: 'declared'` + coords on each chiral cluster) —
 * NOT `stereo_label` literals. This guards HISTORY row 17, where one of an
 * adjacent stereocenter pair was once silently dropped.
 *
 * Fixture: a bicyclo[4.4.0] (decalin) skeleton fused on the C1-C2 bond, with a
 * hydroxyl on each ring-fusion carbon — a fused bicyclic DIOL sharing the
 * fusion bond. Each fusion carbon (ids 1, 2) therefore has four heavy
 * neighbors {OH, the other fusion C, a ring-A C, a ring-B C}, no implicit H to
 * count, and carries a wedge to its OH. The two fusion carbons are genuinely
 * independent stereocenters: flipping one OH's wedge from solid to hashed
 * yields a topologically distinct diastereomer.
 *
 * Assertions:
 *   (a) BOTH ring-fusion stereocenters appear stereo-defined in the exported
 *       isomeric SMILES — exactly TWO tetrahedral stereo descriptors, neither
 *       dropped.
 *   (b) The cis variant (both OH wedged toward the viewer) and the trans
 *       variant (one toward, one away) export DIFFERENT isomeric SMILES,
 *       proving the two adjacent centers are independently resolved, NOT
 *       collapsed onto a single shared descriptor.
 *
 * The "neither dropped" guarantee is also enforced structurally by the build:
 * the translator's post-build `assertNoUndefinedStereoPostBuild` (the silent-
 * achiral guard) rejects the build if either fusion carbon is left
 * topologically stereogenic-but-undefined. Dropping ONE of the two wedges
 * therefore fails the build (`stereo_transfer_failed`) — a negative-control
 * `it` pins that, so a future regression that drops one center surfaces as a
 * test failure rather than a silent wrong answer.
 *
 * Indigo + remote gated (Task 6C) via the shared `startStereoGate` helper:
 * cis/trans perception is an Indigo CIP call on the post-build canvas, and the
 * silent-achiral guard is an Indigo `/check` call — both no-op under
 * standalone / unreachable Indigo, so the gate skip-closes rather than risk a
 * false green (or, worse here, a false-RED where a correctly-built molecule
 * looks achiral). See tests/fixtures/stereo-e2e-gate.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import {
  RUN_STEREO_E2E,
  startStereoGate,
  type StereoGate,
} from '../fixtures/stereo-e2e-gate';
import type { GraphIntent } from '../../src/types/graph-intent';

/**
 * Decalin-fusion DIOL. Ring A = atoms 1-2-3-4-5-6; ring B = atoms
 * 1-2-7-8-9-10; the two rings share the C1-C2 fusion bond. OH on each fusion
 * carbon: O id 11 on C1, O id 12 on C2. Coords are image-y-down skeletal
 * positions for the two cyclohexanes mirrored across the vertical fusion bond,
 * with each OH placed on the opposite side of the ring plane from its carbon
 * so the wedge has an unambiguous in-plane reference frame.
 *
 * `faceA` / `faceB` are the wedge polarities on the C1-OH and C2-OH bonds.
 * `'solid'` = OH toward the viewer; `'hashed'` = OH away. The cis diastereomer
 * uses solid/solid (both OH on the same face); the trans uses solid/hashed
 * (opposite faces). Both fusion carbons carry `stereo: 'declared'` (LOCK 24).
 */
function decalinFusionDiol(
  faceA: 'solid' | 'hashed',
  faceB: 'solid' | 'hashed',
  tag: string,
): GraphIntent {
  return {
    version: 1,
    label: `decalin-fusion-diol-${tag}`,
    atoms: [
      // Ring-fusion carbons (the adjacent stereocenter pair), sharing bond 1-2.
      { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'rA', x: 0, y: 0, stereo: 'declared' },
      { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'rA', x: 0, y: 1, stereo: 'declared' },
      // Ring A remainder.
      { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'rA', x: 1, y: 1.5 },
      { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'rA', x: 2, y: 1 },
      { id: 5, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'rA', x: 2, y: 0 },
      { id: 6, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'rA', x: 1, y: -0.5 },
      // Ring B remainder.
      { id: 7, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'rB', x: -1, y: 1.5 },
      { id: 8, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'rB', x: -2, y: 1 },
      { id: 9, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'rB', x: -2, y: 0 },
      { id: 10, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'rB', x: -1, y: -0.5 },
      // Hydroxyls — one per fusion carbon. drawn_H: 1 → the O carries its H.
      { id: 11, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null, x: 0.6, y: -0.6 },
      { id: 12, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null, x: -0.6, y: 1.6 },
    ],
    bonds: [
      { a: 1, b: 2, order: 1, wedge: null, wedge_from: null }, // shared fusion bond
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 3, b: 4, order: 1, wedge: null, wedge_from: null },
      { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
      { a: 5, b: 6, order: 1, wedge: null, wedge_from: null },
      { a: 6, b: 1, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 7, order: 1, wedge: null, wedge_from: null },
      { a: 7, b: 8, order: 1, wedge: null, wedge_from: null },
      { a: 8, b: 9, order: 1, wedge: null, wedge_from: null },
      { a: 9, b: 10, order: 1, wedge: null, wedge_from: null },
      { a: 10, b: 1, order: 1, wedge: null, wedge_from: null },
      // One wedge per fusion carbon → its OH. wedge_from names the chiral center.
      { a: 1, b: 11, order: 1, wedge: faceA, wedge_from: 1 },
      { a: 2, b: 12, order: 1, wedge: faceB, wedge_from: 2 },
    ],
    rings: [
      { id: 'rA', atoms: [1, 2, 3, 4, 5, 6], kind: 'aliphatic' },
      { id: 'rB', atoms: [1, 2, 7, 8, 9, 10], kind: 'aliphatic' },
    ],
    counts: { heavy: 12, rings: 2, heteroatoms: { O: 2 } },
  };
}

/**
 * Single-wedge negative control: a wedge on C1's OH only, C2's OH bond flat.
 * C2 remains a topological stereocenter with undefined config, so the build
 * MUST be rejected (the "neither dropped" guarantee, enforced structurally).
 */
function decalinFusionDiolOneWedge(): GraphIntent {
  const g = decalinFusionDiol('solid', 'solid', 'one-wedge');
  return {
    ...g,
    bonds: g.bonds.map((b) =>
      b.a === 2 && b.b === 12
        ? { ...b, wedge: null, wedge_from: null }
        : b,
    ),
  };
}

/**
 * Count tetrahedral stereo descriptors (`@` / `@@`) in an isomeric SMILES.
 * Each defined tetrahedral center contributes exactly one `@` or `@@` token;
 * `@@` is a single descriptor (the writer never emits `@@@`). Counting `@`
 * runs would double-count `@@`, so collapse `@@` → one match first.
 */
function tetrahedralStereoCount(smiles: string): number {
  return (smiles.replace(/@@/g, '@').match(/@/g) ?? []).length;
}

const describeE2E = RUN_STEREO_E2E ? describe : describe.skip;

describeE2E('adjacent-chiral fused-ring stereo (shared-bond pair, Indigo + remote gated)', () => {
  const runtime = new KetcherRuntime();
  let gate: StereoGate;

  beforeAll(async () => {
    // Skip-closed: starts the runtime in REMOTE mode iff Indigo is reachable.
    gate = await startStereoGate(runtime);
  }, 180000);

  afterAll(async () => {
    await gate?.stop();
  });

  async function buildSmiles(graph: GraphIntent): Promise<string> {
    await runtime.callBridge('clearCanvas');
    // layout: 'preserve' keeps the pinned coords that the wedge perceiver
    // reads (same posture as the L-alanine / stilbene coord-pinned e2e cases).
    await translateGraphIntent(runtime, graph, {
      validate_counts: true,
      layout: 'preserve',
    });
    const smiles = await runtime.exportSmiles();
    expect(smiles).toBeTruthy();
    return smiles ?? '';
  }

  it('cis fusion-diol: BOTH shared-bond centers resolve (two stereo descriptors, neither dropped)', async (ctx) => {
    ctx.skip(!gate.ready, gate.skipReason);

    const smiles = await buildSmiles(decalinFusionDiol('solid', 'solid', 'cis'));

    // (a) Exactly two tetrahedral stereocenters — both fusion carbons defined,
    //     neither silently dropped (HISTORY row 17 guard).
    expect(tetrahedralStereoCount(smiles)).toBe(2);
  }, 120000);

  it('trans fusion-diol: BOTH shared-bond centers resolve (two stereo descriptors, neither dropped)', async (ctx) => {
    ctx.skip(!gate.ready, gate.skipReason);

    const smiles = await buildSmiles(decalinFusionDiol('solid', 'hashed', 'trans'));

    expect(tetrahedralStereoCount(smiles)).toBe(2);
  }, 120000);

  it('cis and trans export DIFFERENT isomeric SMILES (two adjacent centers independently resolved)', async (ctx) => {
    ctx.skip(!gate.ready, gate.skipReason);

    // Build both diastereomers on the SAME fresh runtime, back to back.
    const cis = await buildSmiles(decalinFusionDiol('solid', 'solid', 'cis'));
    const trans = await buildSmiles(decalinFusionDiol('solid', 'hashed', 'trans'));

    // Both carry two defined centers...
    expect(tetrahedralStereoCount(cis)).toBe(2);
    expect(tetrahedralStereoCount(trans)).toBe(2);

    // ...and they are NOT the same molecule. If the two adjacent centers were
    // collapsed onto a single descriptor, flipping one wedge could not change
    // the export — distinct isomeric SMILES proves independent resolution.
    // (Ketcher authors both strings; we never hand-write the @/@@.)
    expect(cis).not.toBe(trans);
  }, 120000);

  it('negative control: dropping ONE fusion wedge fails the build (neither-dropped is structurally enforced)', async (ctx) => {
    ctx.skip(!gate.ready, gate.skipReason);

    await runtime.callBridge('clearCanvas');
    // C2's OH is left flat → C2 is a topological stereocenter with undefined
    // config → the silent-achiral guard rejects the build. This is what makes
    // "neither dropped" a guarantee, not a hope.
    await expect(
      translateGraphIntent(runtime, decalinFusionDiolOneWedge(), {
        validate_counts: true,
        layout: 'preserve',
      }),
    ).rejects.toThrow(/stereo_transfer_failed/);
  }, 120000);
});
