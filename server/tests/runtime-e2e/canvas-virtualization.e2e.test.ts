import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KetcherRuntime } from '../../src/mcp/runtime';

const runE2E = process.env.RUN_KETCHER_E2E === '1';
const describeE2E = runE2E ? describe : describe.skip;

// L-alanine vs D-alanine differ only by @ / @@ — a stereo flip is visible
// in the isomeric SMILES Ketcher emits.
const L_ALANINE = 'C[C@@H](N)C(=O)O';
const D_ALANINE = 'C[C@H](N)C(=O)O';

describeE2E('canvas virtualization', () => {
  const runtime = new KetcherRuntime();

  beforeAll(async () => {
    await runtime.start();
  }, 180000);

  afterAll(async () => {
    await runtime.stop();
  });

  it('GATE: KET export→reload roundtrip preserves isomeric stereo', async () => {
    await runtime.callBridge('loadSmiles', L_ALANINE);
    const s1 = await runtime.exportSmiles();
    // Guard: confirm stereo is actually present to be preserved. If this
    // fails, standalone Ketcher is not emitting isomeric SMILES — re-run the
    // suite against remote mode (runtime.start({ mode: 'remote',
    // remoteApiPath: 'http://127.0.0.1:8002/v2/' }) + a live Indigo) before
    // trusting the gate.
    expect(s1).toMatch(/@/);

    const ket = await runtime.exportKet();
    expect(ket).toBeTruthy();

    await runtime.callBridge('clearCanvas');
    const cleared = await runtime.exportSmiles();
    expect(cleared === null || cleared === '').toBe(true);

    await runtime.callBridge('resetToSnapshot', ket as string);
    const s2 = await runtime.exportSmiles();

    expect(s2).toBe(s1); // FIDELITY GATE
  });

  it('bindCanvas roundtrip preserves isomeric stereo', async () => {
    await runtime.bindCanvas('A', { explicit: true, strict: false });
    await runtime.callBridge('loadSmiles', L_ALANINE);
    const s1 = await runtime.exportSmiles();
    expect(s1).toMatch(/@/);

    // Switch away (evicts + snapshots A) then back (restores A).
    await runtime.bindCanvas('B', { explicit: true, strict: false });
    await runtime.bindCanvas('A', { explicit: true, strict: false });

    const s2 = await runtime.exportSmiles();
    expect(s2).toBe(s1);
  });

  it('two keys never see each other\'s molecule', async () => {
    await runtime.bindCanvas('row-L', { explicit: true, strict: false });
    await runtime.callBridge('loadSmiles', L_ALANINE);

    await runtime.bindCanvas('row-D', { explicit: true, strict: false });
    await runtime.callBridge('loadSmiles', D_ALANINE);

    // Interleave the exports: read L after D was built on the shared page.
    await runtime.bindCanvas('row-L', { explicit: true, strict: false });
    const sL = await runtime.exportSmiles();

    await runtime.bindCanvas('row-D', { explicit: true, strict: false });
    const sD = await runtime.exportSmiles();

    expect(sL).not.toBe(sD); // isolation: D's build did not corrupt L
    expect(sL).toMatch(/@/);
    expect(sD).toMatch(/@/);
  });

  it('strict mode rejects an anchorless bind', async () => {
    await runtime.bindCanvas('row-x', { explicit: true, strict: false });
    await expect(
      runtime.bindCanvas(null, { explicit: false, strict: true }),
    ).rejects.toThrow(/explicit rowId anchor/);
  });
});
