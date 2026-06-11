import { KetcherRuntime } from '../src/mcp/runtime';

const runtime = new KetcherRuntime();
await runtime.start();

console.log('--- load benzene aromatic SMILES');
await runtime.applyMutation('load_smiles', { smiles: 'c1ccccc1' }, async () => {
  await runtime.callBridge('loadSmiles', 'c1ccccc1');
});

const annotated1 = (await runtime.getAnnotatedState()) as any;
console.log('atoms[0] aromatic =', annotated1.atoms[0].aromatic, 'implicitH =', annotated1.atoms[0].implicitH);
console.log('bonds[0] aromatic =', annotated1.bonds[0].aromatic, 'order =', annotated1.bonds[0].order);
console.log('conjugationGroups =', JSON.stringify(annotated1.conjugationGroups));

console.log('\n--- dearomatize');
await runtime.applyMutation('dearomatize', {}, async () => {
  await runtime.callBridge('dearomatize');
});
const annotated2 = (await runtime.getAnnotatedState()) as any;
console.log('atoms[0] aromatic =', annotated2.atoms[0].aromatic);
console.log('bond orders =', annotated2.bonds.map((b: any) => b.order).join(','));

console.log('\n--- aromatize back');
await runtime.applyMutation('aromatize', {}, async () => {
  await runtime.callBridge('aromatize');
});
const annotated3 = (await runtime.getAnnotatedState()) as any;
console.log('atoms[0] aromatic =', annotated3.atoms[0].aromatic);

console.log('\n--- toluene H• abstraction (set implicit H = 2 + radical = 1 on benzylic C)');
await runtime.applyMutation('load_smiles', { smiles: 'Cc1ccccc1' }, async () => {
  await runtime.callBridge('loadSmiles', 'Cc1ccccc1');
});
const tol = (await runtime.getAnnotatedState()) as any;
const benzylicAtom = tol.atoms.find(
  (a: any) =>
    a.label === 'C' &&
    !a.aromatic &&
    a.neighborAtomIds.some((nid: number) => tol.atoms.find((x: any) => x.id === nid)?.aromatic),
);
console.log('benzylic atom id =', benzylicAtom?.id, 'implicitH =', benzylicAtom?.implicitH);

await runtime.applyMutation(
  'set_atom_implicit_h_count',
  { atomId: benzylicAtom.id, count: 2 },
  async () => {
    await runtime.callBridge('setAtomImplicitHCount', benzylicAtom.id, 2);
  },
);
await runtime.applyMutation(
  'set_atom_radical',
  { atomId: benzylicAtom.id, radical: 2 },
  async () => {
    await runtime.callBridge('setAtomRadical', benzylicAtom.id, 2);
  },
);

const result = await runtime.exportSmiles();
console.log('benzyl radical SMILES =', result);

const molfile = await runtime.exportMolfile();
console.log('molfile lines:', molfile?.split('\n').length);

await runtime.stop();
console.log('\nDONE');
