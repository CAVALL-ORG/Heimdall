import { edgeKey, type GraphIntent, type IntentBond } from '../../types/graph-intent';

export type ComponentSpec = {
  atoms: number[]; // atom ids in this component
  bonds: IntentBond[]; // bonds whose endpoints are both in this component
};

export function bfsComponents(graph: GraphIntent): ComponentSpec[] {
  const adjacency = new Map<number, number[]>();
  for (const atom of graph.atoms) adjacency.set(atom.id, []);
  for (const bond of graph.bonds) {
    adjacency.get(bond.a)?.push(bond.b);
    adjacency.get(bond.b)?.push(bond.a);
  }

  const visited = new Set<number>();
  const components: ComponentSpec[] = [];
  const atomIdsSorted = graph.atoms.map((a) => a.id).sort((x, y) => x - y);

  for (const seed of atomIdsSorted) {
    if (visited.has(seed)) continue;
    const queue = [seed];
    const memberSet = new Set<number>();
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      memberSet.add(cur);
      for (const neighbor of adjacency.get(cur) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    const members = [...memberSet].sort((x, y) => x - y);
    const bonds = graph.bonds.filter((b) => memberSet.has(b.a) && memberSet.has(b.b));
    components.push({ atoms: members, bonds });
  }
  return components;
}

export function bfsOrder(component: ComponentSpec): number[] {
  if (component.atoms.length === 0) return [];
  const adjacency = new Map<number, number[]>();
  for (const id of component.atoms) adjacency.set(id, []);
  for (const bond of component.bonds) {
    adjacency.get(bond.a)?.push(bond.b);
    adjacency.get(bond.b)?.push(bond.a);
  }
  const seed = component.atoms[0]; // already sorted ascending
  const visited = new Set<number>([seed]);
  const order: number[] = [seed];
  const queue: number[] = [seed];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const neighbors = (adjacency.get(cur) ?? []).slice().sort((x, y) => x - y);
    for (const n of neighbors) {
      if (visited.has(n)) continue;
      visited.add(n);
      order.push(n);
      queue.push(n);
    }
  }
  return order;
}

export { edgeKey };
