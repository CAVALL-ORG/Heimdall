type Atom = {
  id: number;
  label: string;
  charge: number | null;
  radical: number | null;
};

type Bond = {
  id: number;
  beginAtomId: number;
  endAtomId: number;
  order: number;
  stereo: number;
};

export type AgentState = {
  smiles: string | null;
  ket: string | null;
  isEmpty: boolean;
  isReaction: boolean;
  atoms: Atom[];
  bonds: Bond[];
};

export type DiffSummary = {
  atomCountDelta: number;
  bondCountDelta: number;
  createdAtomIds: number[];
  deletedAtomIds: number[];
  updatedAtoms: Array<{
    id: number;
    fields: Array<'label' | 'charge' | 'radical'>;
  }>;
  createdBondIds: number[];
  deletedBondIds: number[];
  updatedBonds: Array<{
    id: number;
    fields: Array<'beginAtomId' | 'endAtomId' | 'order' | 'stereo'>;
  }>;
  beforeFragmentCount: number;
  afterFragmentCount: number;
  fragmentCountDelta: number;
  smilesChanged: boolean;
};

function mapById<T extends { id: number }>(items: T[]) {
  return new Map(items.map((item) => [item.id, item]));
}

function countFragments(state: AgentState): number {
  if (!state.atoms.length) return 0;
  const adjacency = new Map<number, Set<number>>();
  for (const atom of state.atoms) {
    adjacency.set(atom.id, new Set());
  }
  for (const bond of state.bonds) {
    adjacency.get(bond.beginAtomId)?.add(bond.endAtomId);
    adjacency.get(bond.endAtomId)?.add(bond.beginAtomId);
  }

  const visited = new Set<number>();
  let fragments = 0;
  for (const atom of state.atoms) {
    if (visited.has(atom.id)) continue;
    fragments += 1;
    const queue = [atom.id];
    visited.add(atom.id);
    while (queue.length) {
      const current = queue.shift();
      if (typeof current !== 'number') continue;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return fragments;
}

export function diffState(before: AgentState, after: AgentState): DiffSummary {
  const beforeAtoms = mapById(before.atoms);
  const afterAtoms = mapById(after.atoms);
  const beforeBonds = mapById(before.bonds);
  const afterBonds = mapById(after.bonds);

  const createdAtomIds = [...afterAtoms.keys()].filter((id) => !beforeAtoms.has(id));
  const deletedAtomIds = [...beforeAtoms.keys()].filter((id) => !afterAtoms.has(id));
  const createdBondIds = [...afterBonds.keys()].filter((id) => !beforeBonds.has(id));
  const deletedBondIds = [...beforeBonds.keys()].filter((id) => !afterBonds.has(id));

  const updatedAtoms: DiffSummary['updatedAtoms'] = [];
  for (const [id, beforeAtom] of beforeAtoms.entries()) {
    const afterAtom = afterAtoms.get(id);
    if (!afterAtom) continue;
    const fields: Array<'label' | 'charge' | 'radical'> = [];
    if (beforeAtom.label !== afterAtom.label) fields.push('label');
    if (beforeAtom.charge !== afterAtom.charge) fields.push('charge');
    if (beforeAtom.radical !== afterAtom.radical) fields.push('radical');
    if (fields.length) updatedAtoms.push({ id, fields });
  }

  const updatedBonds: DiffSummary['updatedBonds'] = [];
  for (const [id, beforeBond] of beforeBonds.entries()) {
    const afterBond = afterBonds.get(id);
    if (!afterBond) continue;
    const fields: Array<'beginAtomId' | 'endAtomId' | 'order' | 'stereo'> = [];
    if (beforeBond.beginAtomId !== afterBond.beginAtomId) fields.push('beginAtomId');
    if (beforeBond.endAtomId !== afterBond.endAtomId) fields.push('endAtomId');
    if (beforeBond.order !== afterBond.order) fields.push('order');
    if (beforeBond.stereo !== afterBond.stereo) fields.push('stereo');
    if (fields.length) updatedBonds.push({ id, fields });
  }

  const beforeFragmentCount = countFragments(before);
  const afterFragmentCount = countFragments(after);

  return {
    atomCountDelta: after.atoms.length - before.atoms.length,
    bondCountDelta: after.bonds.length - before.bonds.length,
    createdAtomIds,
    deletedAtomIds,
    updatedAtoms,
    createdBondIds,
    deletedBondIds,
    updatedBonds,
    beforeFragmentCount,
    afterFragmentCount,
    fragmentCountDelta: afterFragmentCount - beforeFragmentCount,
    smilesChanged: before.smiles !== after.smiles,
  };
}
