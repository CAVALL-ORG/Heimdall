import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffState } from '../../src/adapter/diff';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { fixtureSmiles } from '../fixtures/smiles';

const runE2E = process.env.RUN_KETCHER_E2E === '1';
const describeE2E = runE2E ? describe : describe.skip;

describeE2E('Ketcher runtime e2e', () => {
  const runtime = new KetcherRuntime();

  beforeAll(async () => {
    await runtime.start();
  }, 180000);

  afterAll(async () => {
    await runtime.stop();
  });

  it('loads smiles and exports state', async () => {
    const result = await runtime.applyMutation(
      'load_smiles',
      { smiles: fixtureSmiles.aromatic },
      async () => {
        await runtime.callBridge('loadSmiles', fixtureSmiles.aromatic);
      },
    );
    expect(result.after.smiles).toBeTruthy();
    expect(result.after.ket).toBeTruthy();
    expect(result.after.bonds.length).toBeGreaterThan(0);
  });

  it('updates bond order, atom charge, and atom radical', async () => {
    await runtime.callBridge('loadSmiles', fixtureSmiles.simple);
    const initial = await runtime.getState(false);
    const bondId = initial.bonds[0]?.id;
    const atomId = initial.atoms[0]?.id;
    expect(typeof bondId).toBe('number');
    expect(typeof atomId).toBe('number');

    const bondMutation = await runtime.applyMutation(
      'set_bond_order',
      { bondId, order: 2 },
      async () => {
        await runtime.callBridge('setBondOrder', bondId, 2);
      },
    );
    expect(bondMutation.diff.smilesChanged).toBe(true);

    const chargeMutation = await runtime.applyMutation(
      'set_atom_charge',
      { atomId, charge: 1 },
      async () => {
        await runtime.callBridge('setAtomCharge', atomId, 1);
      },
    );
    expect(chargeMutation.diff.updatedAtoms.some((item) => item.id === atomId)).toBe(true);

    const radicalMutation = await runtime.applyMutation(
      'set_atom_radical',
      { atomId, radical: 2 },
      async () => {
        await runtime.callBridge('setAtomRadical', atomId, 2);
      },
    );
    expect(radicalMutation.diff.updatedAtoms.some((item) => item.id === atomId)).toBe(true);
  });

  it('resets to a previous snapshot and computes diff', async () => {
    await runtime.callBridge('loadSmiles', fixtureSmiles.charged);
    const before = await runtime.getState(false);
    const mutation = await runtime.applyMutation(
      'layout',
      {},
      async () => {
        await runtime.callBridge('layout');
      },
    );
    const restored = await runtime.applyMutation(
      'reset_to_snapshot',
      { snapshotId: mutation.beforeSnapshotId },
      async () => {
        await runtime.callBridge('resetToSnapshot', mutation.before.ket);
      },
    );
    const diff = diffState(before, restored.after);
    expect(diff.atomCountDelta).toBe(0);
  });

});
