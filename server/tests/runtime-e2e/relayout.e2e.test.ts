/**
 * Dense relayout lever — the backend re-idealizes the coordinate frame for
 * dense WEDGE graphs (healing the coord-CW stereo class) while leaving sparse
 * graphs and already-correct dense graphs byte-identical.
 *
 * Validation provenance: outputs/dense-stereo-replay/RELAYOUT-*.json.
 *
 * The behavioral contract (not a brittle full-SMILES match, which a Ketcher/
 * Indigo bump could shift): on dense+wedge+'auto' the build routes through
 * clean(), so its SMILES DIFFERS from the pinned-no-clean 'preserve' baseline
 * and EQUALS the explicit 'clean' build; on a correct dense graph clean is a
 * no-op (auto == preserve); on a sparse graph the dense gate is off (auto ==
 * preserve). Offline RDKit per-center CIP (relayout-cip.py) is the correctness
 * oracle for "clean heals idx60"; this e2e guards the gate ROUTING.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import type { GraphIntent } from '../../src/types/graph-intent';

const runE2E = process.env.RUN_KETCHER_E2E === '1';
const describeE2E = runE2E ? describe : describe.skip;

const FIX = join(__dirname, '../fixtures/relayout');
const load = (f: string): GraphIntent =>
  JSON.parse(readFileSync(join(FIX, f), 'utf8')) as GraphIntent;
const A004PASS = load('A004pass.graph.json');
const COORD_CW = load('coord-cw-A004H.graph.json');
const SPARSE = load('sparse-wedge-alanine.graph.json');

async function build(
  rt: KetcherRuntime,
  g: GraphIntent,
  layout: 'auto' | 'preserve' | 'clean',
): Promise<string> {
  await rt.callBridge('clearCanvas');
  await translateGraphIntent(rt, g, { validate_counts: false, layout });
  return (await rt.exportSmiles()) ?? '';
}

describeE2E('dense relayout lever (backend owns the frame)', () => {
  const rt = new KetcherRuntime();
  beforeAll(async () => {
    await rt.start();
  }, 180000);
  afterAll(async () => {
    await rt.stop();
  });

  it('HEALS coord-CW: dense+wedge+auto routes through clean (auto != preserve, auto == clean)', async () => {
    const auto = await build(rt, COORD_CW, 'auto');
    const preserve = await build(rt, COORD_CW, 'preserve');
    const clean = await build(rt, COORD_CW, 'clean');
    expect(auto).toBeTruthy();
    expect(auto).not.toBe(preserve); // dense gate fires clean -> output changes
    expect(auto).toBe(clean); // 'auto' on dense routes through the same clean
  }, 180000);

  it('NO-REGRESSION on a correct dense graph: clean is a no-op (auto == preserve)', async () => {
    const auto = await build(rt, A004PASS, 'auto');
    const preserve = await build(rt, A004PASS, 'preserve');
    expect(auto).toBeTruthy();
    expect(auto).toBe(preserve); // clean re-idealizes but moves no correct center
  }, 180000);

  it('FAST-ON-EASY: sparse wedge graph is untouched (dense gate off, no clean)', async () => {
    const auto = await build(rt, SPARSE, 'auto');
    const preserve = await build(rt, SPARSE, 'preserve');
    expect(auto).toBeTruthy();
    expect(auto).toBe(preserve); // isDenseDraft false -> runClean stays false
  }, 180000);
});
