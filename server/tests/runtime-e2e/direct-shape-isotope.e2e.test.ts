/**
 * Task 5A — FEATURE-PARITY GATE: isotope round-trip (ADDED honoring).
 *
 * `atom.isotope` was already in the direct GraphIntent schema (LOCK 23) but
 * the translator never applied it — it walked element / drawn_H / charge /
 * radical and silently dropped the mass number. This proves the added
 * translator pass: a direct GraphIntent carrying `isotope` round-trips
 * through real Ketcher to an isotope-labelled SMILES.
 *
 * Gated RUN_KETCHER_E2E=1 (real Playwright runtime), like the rest of
 * runtime-e2e. No Indigo dependency — isotope is a pure MDL atom attribute
 * Ketcher's own SMILES writer emits.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import type { GraphIntent } from '../../src/types/graph-intent';

const runE2E = process.env.RUN_KETCHER_E2E === '1';
const describeE2E = runE2E ? describe : describe.skip;

describeE2E('Task 5A isotope round-trip (direct → export)', () => {
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

  // ¹³C-methanol: the carbon is mass-13, the oxygen natural-abundance. The
  // exported SMILES must carry the `[13C...]` isotope token; the O stays
  // bare. Verifies the isotope value is applied (not dropped) AND that it
  // lands on the right atom.
  it('13C-labelled methanol round-trips a [13C] token', async () => {
    const c13Methanol: GraphIntent = {
      version: 1,
      label: '13C-methanol',
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, isotope: 13 },
        { id: 2, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
      ],
      bonds: [{ a: 1, b: 2, order: 1, wedge: null, wedge_from: null }],
      rings: [],
      counts: { heavy: 2, rings: 0, heteroatoms: { O: 1 } },
    };
    const smiles = await buildAndExport(c13Methanol);
    expect(/\[13C/.test(smiles)).toBe(true);
    // The oxygen must NOT pick up a stray isotope label.
    expect(/\[\d+O/.test(smiles)).toBe(false);
  }, 120000);

  // Deuterium (²H) on an explicit ring atom — exercises a non-carbon
  // isotope. Build a heavy-water-style fragment: a single O with two drawn
  // H is too ambiguous for the SMILES writer, so use a deuterated methanol
  // carbon-bound D is not expressible without an explicit H atom; instead
  // assert the simplest robust non-12C non-13C case: 15N-ammonia analogue.
  it('15N label round-trips a [15N] token', async () => {
    const n15: GraphIntent = {
      version: 1,
      label: '15N-methylamine',
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 2, element: 'N', drawn_H: 2, charge: 0, radical: 0, ring: null, isotope: 15 },
      ],
      bonds: [{ a: 1, b: 2, order: 1, wedge: null, wedge_from: null }],
      rings: [],
      counts: { heavy: 2, rings: 0, heteroatoms: { N: 1 } },
    };
    const smiles = await buildAndExport(n15);
    expect(/\[15N/.test(smiles)).toBe(true);
  }, 120000);
});
