/**
 * Task 5A — FEATURE-PARITY GATE: `unsure_regions` survives the build path.
 *
 * The unit test (tests/unit/unsure-regions.test.ts) proves the field parses
 * and that validate_graph surfaces each box as an advisory crop target. This
 * e2e closes the "round-trips direct-shape → build" half of the gate: a graph
 * carrying `unsure_regions` builds through real Ketcher and exports exactly
 * the same SMILES as the same graph WITHOUT the field — i.e. the coarse escape
 * is pure transcription metadata that the translator ignores cleanly (never
 * chokes, never mutates the graph).
 *
 * RUN_KETCHER_E2E=1 gated.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import type { GraphIntent } from '../../src/types/graph-intent';

const runE2E = process.env.RUN_KETCHER_E2E === '1';
const describeE2E = runE2E ? describe : describe.skip;

function ethanol(withUnsure: boolean): GraphIntent {
  const base: GraphIntent = {
    version: 1,
    label: 'ethanol',
    atoms: [
      { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 3, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
    ],
    bonds: [
      { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 3, rings: 0, heteroatoms: { O: 1 } },
  };
  if (withUnsure) {
    base.unsure_regions = [
      { x: 50, y: 60, radius: 20, note: 'faint stroke near terminal vertex' },
    ];
  }
  return base;
}

describeE2E('Task 5A unsure_regions survives build (direct → export)', () => {
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

  it('builds + exports identically with and without unsure_regions', async () => {
    const without = await buildAndExport(ethanol(false));
    const withRegions = await buildAndExport(ethanol(true));
    expect(without).toBeTruthy();
    expect(without.toUpperCase()).toContain('CCO');
    // The coarse escape is metadata only — it must not perturb the built graph.
    expect(withRegions).toEqual(without);
  }, 120000);
});
