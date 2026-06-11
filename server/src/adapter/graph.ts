import { Bond } from 'ketcher-core';

export type BondListEntry = {
  id: number;
  begin: number;
  end: number;
  type: number;
};

export type Adjacency = {
  atomBonds: Map<number, number[]>;
  atomNeighbors: Map<number, number[]>;
  bondList: BondListEntry[];
};

export function buildAdjacency(struct: any): Adjacency {
  const atomBonds = new Map<number, number[]>();
  const atomNeighbors = new Map<number, number[]>();
  const bondList: BondListEntry[] = [];

  struct.atoms.forEach((_atom: any, atomId: number) => {
    atomBonds.set(atomId, []);
    atomNeighbors.set(atomId, []);
  });

  struct.bonds.forEach((bond: any, bondId: number) => {
    bondList.push({ id: bondId, begin: bond.begin, end: bond.end, type: bond.type });
    atomBonds.get(bond.begin)?.push(bondId);
    atomBonds.get(bond.end)?.push(bondId);
    atomNeighbors.get(bond.begin)?.push(bond.end);
    atomNeighbors.get(bond.end)?.push(bond.begin);
  });

  return { atomBonds, atomNeighbors, bondList };
}

export function componentCount(struct: any): number {
  const atomIds: number[] = [];
  struct.atoms.forEach((_atom: any, atomId: number) => {
    atomIds.push(atomId);
  });
  if (!atomIds.length) return 0;

  const adjacency = new Map<number, Set<number>>();
  for (const atomId of atomIds) {
    adjacency.set(atomId, new Set());
  }

  struct.bonds.forEach((bond: any) => {
    adjacency.get(bond.begin)?.add(bond.end);
    adjacency.get(bond.end)?.add(bond.begin);
  });

  const visited = new Set<number>();
  let count = 0;
  for (const atomId of atomIds) {
    if (visited.has(atomId)) continue;
    count += 1;
    const queue = [atomId];
    visited.add(atomId);
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
  return count;
}

export function computeBondInRingFlags(bondList: BondListEntry[]): Map<number, boolean> {
  // A bond is in a ring iff after removing it the endpoints are still connected.
  const inRing = new Map<number, boolean>();
  if (bondList.length === 0) return inRing;

  for (const target of bondList) {
    const adjacency = new Map<number, Set<number>>();
    for (const bond of bondList) {
      if (bond.id === target.id) continue;
      if (!adjacency.has(bond.begin)) adjacency.set(bond.begin, new Set());
      if (!adjacency.has(bond.end)) adjacency.set(bond.end, new Set());
      adjacency.get(bond.begin)!.add(bond.end);
      adjacency.get(bond.end)!.add(bond.begin);
    }
    const visited = new Set<number>([target.begin]);
    const queue: number[] = [target.begin];
    let connected = false;
    while (queue.length) {
      const current = queue.shift();
      if (current === undefined) continue;
      if (current === target.end) {
        connected = true;
        break;
      }
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    inRing.set(target.id, connected);
  }
  return inRing;
}

// Bond-order weight for conjugation / valence math. Aromatic bonds count as 1
// σ; the π electrons are shared ring-wide and not double-counted per bond.
export function bondOrderWeight(type: number): number {
  if (type === Bond.PATTERN.TYPE.SINGLE) return 1;
  if (type === Bond.PATTERN.TYPE.DOUBLE) return 2;
  if (type === Bond.PATTERN.TYPE.TRIPLE) return 3;
  if (type === Bond.PATTERN.TYPE.AROMATIC) return 1;
  return 1;
}
