/**
 * Lone-metal radical artifact — regression for the lone-metal finding:
 * a lone `[Na]` built from a GraphIntent exported a spurious `|^1:0|`
 * doublet-radical CXSMILES artifact, and `radical: 0` could not clear it.
 *
 * Mechanism: `singleAtomSmiles` seeds lone non-organic atoms via bracket
 * SMILES (`addFragment('[Na]')`); Indigo's parser encodes the unmet natural
 * valence (Na = 1) as an unpaired electron → canvas atom arrives with
 * radical DOUBLET. The translator's radical pass only fired for declared
 * radical !== 0, so the parser's radical survived to export. Clearing the
 * radical alone is NOT enough — Indigo then reroutes the unmet valence into
 * implicit H and exports `[NaH]` (sodium hydride, an atom the image never
 * drew). The fix clears the radical AND pins implicit H to 0 when the agent
 * declared no drawn_H.
 *
 * Image-truth contract under test: a bare "Na" glyph (radical 0, drawn_H
 * null) exports `[Na]` — no radical extension, no hydride.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import type { GraphIntent } from '../../src/types/graph-intent';

const runE2E = process.env.RUN_KETCHER_E2E === '1';
const describeE2E = runE2E ? describe : describe.skip;

function loneNa(overrides: Partial<{ charge: number; radical: 0 | 1 | 2 }> = {}): GraphIntent {
  return {
    version: 1,
    atoms: [
      {
        id: 0,
        element: 'Na',
        drawn_H: null,
        charge: overrides.charge ?? 0,
        radical: overrides.radical ?? 0,
        ring: null,
      },
    ],
    bonds: [],
    rings: [],
    counts: { heavy: 1, rings: 0, heteroatoms: { Na: 1 } },
  } as GraphIntent;
}

/** Sodium acetate as drawn: CH3-C(=O)-O⁻ plus a separate Na⁺ fragment. */
function sodiumAcetate(): GraphIntent {
  return {
    version: 1,
    atoms: [
      { id: 0, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 2, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 3, element: 'O', drawn_H: null, charge: -1, radical: 0, ring: null },
      { id: 4, element: 'Na', drawn_H: null, charge: 1, radical: 0, ring: null },
    ],
    bonds: [
      { a: 0, b: 1, order: 1, wedge: null, wedge_from: null },
      { a: 1, b: 2, order: 2, wedge: null, wedge_from: null },
      { a: 1, b: 3, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 5, rings: 0, components: 2, heteroatoms: { O: 2, Na: 1 } },
  } as GraphIntent;
}

async function buildAndExport(
  runtime: KetcherRuntime,
  graph: GraphIntent,
): Promise<{ smiles: string | null; radicals: number[] }> {
  await runtime.callBridge('clearCanvas');
  await runtime.applyMutation('build_from_graph', { validate_counts: true }, async () => {
    await translateGraphIntent(runtime, graph, { validate_counts: true, layout: 'auto' });
  });
  const st = (await runtime.getState(false)) as { atoms: Array<{ radical: number }> };
  return { smiles: await runtime.exportSmiles(), radicals: st.atoms.map((a) => a.radical) };
}

describeE2E('lone-metal radical artifact', () => {
  const runtime = new KetcherRuntime();

  beforeAll(async () => {
    await runtime.start();
  }, 180000);

  afterAll(async () => {
    await runtime.stop();
  });

  it('bare Na (radical 0, drawn_H null) exports [Na] — no |^1:0|, no hydride', async () => {
    const r = await buildAndExport(runtime, loneNa());
    expect(r.smiles).toBe('[Na]');
    expect(r.radicals).toEqual([0]);
  }, 60000);

  it('Na+ (charge declared) exports [Na+] without a radical extension', async () => {
    const r = await buildAndExport(runtime, loneNa({ charge: 1 }));
    expect(r.smiles).toBe('[Na+]');
    expect(r.radicals).toEqual([0]);
  }, 60000);

  it('declared radical 1 is preserved — [Na] keeps its drawn radical dot', async () => {
    const r = await buildAndExport(runtime, loneNa({ radical: 1 }));
    expect(r.smiles).toMatch(/^\[Na\]/);
    expect(r.smiles).toContain('|^1:0|');
  }, 60000);

  it('sodium acetate (salt, 2 components) exports [Na+] with no radical artifact', async () => {
    const r = await buildAndExport(runtime, sodiumAcetate());
    expect(r.smiles).toContain('[Na+]');
    expect(r.smiles).not.toContain('^1');
  }, 60000);

  it('lone organic atom is untouched by the reconcile (O still exports as water)', async () => {
    const graph: GraphIntent = {
      version: 1,
      atoms: [{ id: 0, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null }],
      bonds: [],
      rings: [],
      counts: { heavy: 1, rings: 0, heteroatoms: { O: 1 } },
    } as GraphIntent;
    const r = await buildAndExport(runtime, graph);
    expect(r.smiles).toBe('O');
    expect(r.radicals).toEqual([0]);
  }, 60000);
});
