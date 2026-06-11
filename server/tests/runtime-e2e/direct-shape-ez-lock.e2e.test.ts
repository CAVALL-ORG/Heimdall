/**
 * P1.1 regression — declared `bond.geom` (cis/trans) must round-trip on the
 * DEFAULT dense build path (`layoutPolicy: 'ketcher_clean_locked'`), not only on
 * the coord-pinned non-locked path.
 *
 * The clean_locked path runs a global `layout()` that redraws every double bond
 * blind to the agent's drawn geometry; before the fix the declared cis/trans was
 * silently lost (the geom verifier only *advised*). `planEZCoordinateLock`
 * reflects a stereocenter-free half across the bond axis post-layout so Indigo
 * perceives the drawn E/Z.
 *
 * The assertion is the per-bond `geomVerification` record's `match` flag (Indigo
 * perceived E/Z === declared cis→Z / trans→E). Asserting match===true for BOTH
 * cis AND trans is a deterministic regression: `layout()` produces ONE geometry,
 * so at most one of the two could ever accidentally match — the buggy path fails
 * one of them every time. Indigo + remote gated (skip-closed) like the other
 * stereo e2e blocks.
 *
 * Fixture: HO-C*(NH2)-CH2-CH=CH-CH3, a chiral amino-pentenol. C1 is a real
 * tetrahedral stereocenter resolved via an R/S-label entry (forces clean_locked;
 * the E/Z reflection must not disturb it). C5=C6 is an acyclic 1,2-disubstituted
 * double bond; its heavy reference neighbors are the spacer CH2 (C4, a-side,
 * which leads back to the stereocenter) and the terminal methyl (C7, b-side,
 * stereocenter-free → the reflected half). The geom cluster atoms carry coords
 * (the V4 validator requires them) that layout() then discards — exactly the
 * production shape that loses drawn E/Z.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import type { GraphIntent } from '../../src/types/graph-intent';
import {
  RUN_STEREO_E2E,
  startStereoGate,
  type StereoGate,
} from '../fixtures/stereo-e2e-gate';

function aminoPentenol(geom: 'cis' | 'trans'): GraphIntent {
  // ids: 1=C* (chiral), 2=O (hydroxyl), 3=N (amino), 4=C (CH2 spacer),
  //      5=C (=CH start), 6=C (=CH end), 7=C (terminal methyl).
  // Geom cluster {4,5,6,7} carries coords (V4); stereocenter is only atom 1.
  return {
    version: 1,
    label: `amino-pentenol-${geom}`,
    atoms: [
      { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 2, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
      { id: 3, element: 'N', drawn_H: 2, charge: 0, radical: 0, ring: null },
      { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 0, y: 0 },
      { id: 5, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 1, y: 0 },
      { id: 6, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 1.8, y: 0.6 },
      { id: 7, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 2.8, y: 0.6 },
    ],
    bonds: [
      { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
      { a: 1, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 1, b: 4, order: 1, wedge: null, wedge_from: null },
      { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
      { a: 5, b: 6, order: 2, wedge: null, wedge_from: null, geom },
      { a: 6, b: 7, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 7, rings: 0, heteroatoms: { O: 1, N: 1 } },
    layoutPolicy: 'ketcher_clean_locked',
    stereoTransfer: [{ center: 1, stereo_label: 'S' } as never],
  };
}

const describeE2E = RUN_STEREO_E2E ? describe : describe.skip;

describeE2E('clean_locked E/Z coordinate lock (P1.1, Indigo + remote gated)', () => {
  const runtime = new KetcherRuntime();
  let gate: StereoGate;

  beforeAll(async () => {
    gate = await startStereoGate(runtime);
  }, 180000);

  afterAll(async () => {
    await gate?.stop();
  });

  async function geomMatch(geom: 'cis' | 'trans'): Promise<boolean> {
    await runtime.callBridge('clearCanvas');
    const result = await translateGraphIntent(runtime, aminoPentenol(geom), {
      validate_counts: true,
      layout: 'auto',
    });
    const rec = (result.geomVerification ?? []).find(
      (r) =>
        (r.intentA === 5 && r.intentB === 6) ||
        (r.intentA === 6 && r.intentB === 5),
    );
    // Indigo must have described the bond (non-stereogenic → undefined would be
    // a fixture bug, not a pass).
    expect(rec, 'geomVerification record for bond 5=6 missing').toBeTruthy();
    expect(rec!.perceivedEZ, 'Indigo perceived no E/Z for bond 5=6').not.toBeNull();
    // Non-interference: reflecting the E/Z half must not drop the resolved
    // tetrahedral stereocenter (C1, stereo_label 'S').
    expect(result.state.smiles ?? '', 'chiral marker lost after E/Z reflection').toMatch(
      /@/,
    );
    return rec!.match;
  }

  it('declared cis round-trips as Z on the clean_locked path', async (ctx) => {
    ctx.skip(!gate.ready, gate.skipReason);
    expect(await geomMatch('cis')).toBe(true);
  }, 120000);

  it('declared trans round-trips as E on the clean_locked path', async (ctx) => {
    ctx.skip(!gate.ready, gate.skipReason);
    expect(await geomMatch('trans')).toBe(true);
  }, 120000);
});
