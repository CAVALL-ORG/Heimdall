import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';

const runE2E = process.env.RUN_KETCHER_E2E === '1';
const d = runE2E ? describe : describe.skip;

// but-2-ene: C0-C1=C2-C3, geom cis, but C0/C3 placed on OPPOSITE sides (trans).
const TRANS_COORDS_CIS_LABEL = {
  version: 1,
  atoms: [
    { id: 0, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null, x: 0,   y: 0 },
    { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 50,  y: 30 },
    { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 100, y: 0 },
    { id: 3, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null, x: 150, y: 30 },
  ],
  bonds: [
    { a: 0, b: 1, order: 1, wedge: null, wedge_from: null },
    { a: 1, b: 2, order: 2, wedge: null, wedge_from: null, geom: 'cis' },
    { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
  ],
  rings: [],
  counts: { heavy: 4, rings: 0, heteroatoms: {} },
};
const NO_COORDS_CIS_LABEL = {
  ...TRANS_COORDS_CIS_LABEL,
  atoms: TRANS_COORDS_CIS_LABEL.atoms.map(({ x, y, ...rest }) => rest),
};

d('E/Z label-authoritative (non-locked path)', () => {
  const rt = new KetcherRuntime();
  beforeAll(async () => { await rt.start(); }, 180000);
  afterAll(async () => { await rt.stop(); });

  it('honors geom:cis even when coords are drawn trans', async () => {
    await rt.callBridge('clearCanvas');
    const out = await translateGraphIntent(rt, TRANS_COORDS_CIS_LABEL, { validate_counts: true, layout: 'auto' });
    expect(out.state.smiles).toMatch(/C=C\\/);          // cis: /C=C\
    expect(out.geomMismatchDiagnostics ?? []).toHaveLength(0);
  });

  it('honors geom:cis with no agent coords at all', async () => {
    await rt.callBridge('clearCanvas');
    const out = await translateGraphIntent(rt, NO_COORDS_CIS_LABEL, { validate_counts: true, layout: 'auto' });
    expect(out.state.smiles).toMatch(/C=C\\/);
    expect(out.geomMismatchDiagnostics ?? []).toHaveLength(0);
  });

  it('A011H: real submitted graph exports diene cis (was E)', async () => {
    const graph = JSON.parse(
      readFileSync(join(__dirname, '../fixtures/ez/A011H.graph.json'), 'utf8'),
    );
    await rt.callBridge('clearCanvas');
    const out = await translateGraphIntent(rt, graph, { validate_counts: true, layout: 'auto' });
    // diene flips E -> Z; the ring [C@@H]/[C@H] descriptors are unchanged.
    expect(out.state.smiles).toMatch(/CC\/C=C\\C=C/);     // ...CC/C=C\C=C  (cis)
    expect(out.state.smiles).not.toMatch(/CC\/C=C\/C=C/); // not the old E
    expect(out.geomMismatchDiagnostics ?? []).toHaveLength(0);
  }, 180000); // dense+wedge fixture now routes through the relayout clean() (2026-06-02), ~7s — exceeds the 5s default
});
