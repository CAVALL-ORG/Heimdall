import { KetcherRuntime } from '../src/mcp/runtime';

async function main() {
  const runtime = new KetcherRuntime();
  await runtime.start();

  try {
    const loaded = await runtime.applyMutation(
      'load_smiles',
      { smiles: 'CCO' },
      async () => {
        await runtime.callBridge('loadSmiles', 'CCO');
      },
    );

    const bondId = loaded.after.bonds[0]?.id;
    if (typeof bondId !== 'number') {
      throw new Error('Expected at least one bond after loading ethanol');
    }

    const changedBond = await runtime.applyMutation(
      'set_bond_order',
      { bondId, order: 2 },
      async () => {
        await runtime.callBridge('setBondOrder', bondId, 2);
      },
    );

    const atomId = changedBond.after.atoms[0]?.id;
    if (typeof atomId !== 'number') {
      throw new Error('Expected at least one atom for charge update');
    }

    const charged = await runtime.applyMutation(
      'set_atom_charge',
      { atomId, charge: 1 },
      async () => {
        await runtime.callBridge('setAtomCharge', atomId, 1);
      },
    );

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          loadSmiles: loaded.after.smiles,
          afterBondUpdateSmiles: changedBond.after.smiles,
          afterChargeUpdateSmiles: charged.after.smiles,
          diff: charged.diff,
        },
        null,
        2,
      ),
    );
  } finally {
    await runtime.stop();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
