import type { AgentState } from '../../ui/bridge';
import { HALOGEN_ELEMENTS, readCountValue, type IntentCounts } from '../../types/graph-intent';
import { computeBondInRingFlags } from '../graph';

export type CountDiff = { field: string; expected: number; observed: number };

export function computeCounts(state: Pick<AgentState, 'atoms' | 'bonds'>): IntentCounts {
  const atoms = state.atoms;
  const bonds = state.bonds;
  // Heavy excludes explicit H atoms; wedge_to_implicit_h materializes H
  // as a wedge-target atom that must not be counted as heavy.
  const heavy = atoms.filter((a) => a.label !== 'H').length;

  // SSSR-style ring count via Euler-characteristic on each connected
  // component: rings = bonds - atoms + components (a.k.a. cyclomatic
  // number / circuit rank). Matches SSSR for chemically reasonable
  // structures (no multigraph artifacts).
  const adjacency = new Map<number, number[]>();
  for (const atom of atoms) adjacency.set(atom.id, []);
  for (const bond of bonds) {
    adjacency.get(bond.beginAtomId)?.push(bond.endAtomId);
    adjacency.get(bond.endAtomId)?.push(bond.beginAtomId);
  }
  const visited = new Set<number>();
  let components = 0;
  for (const atom of atoms) {
    if (visited.has(atom.id)) continue;
    components++;
    const stack = [atom.id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const n of adjacency.get(cur) ?? []) {
        if (!visited.has(n)) stack.push(n);
      }
    }
  }
  // Ensure ring count is computed via in-ring bond flags as a sanity
  // pair: rings counted via Euler equals bond inring count when no
  // bridged systems exist. Use Euler for ring count.
  void computeBondInRingFlags;
  const rings = Math.max(0, bonds.length - atoms.length + components);

  const heteroatoms: Record<string, number> = {};
  for (const atom of atoms) {
    if (atom.label === 'C' || atom.label === 'H') continue;
    if (HALOGEN_ELEMENTS.has(atom.label)) {
      heteroatoms.halogens = (heteroatoms.halogens ?? 0) + 1;
    } else {
      heteroatoms[atom.label] = (heteroatoms[atom.label] ?? 0) + 1;
    }
  }
  return { heavy, rings, heteroatoms };
}

export function diffCounts(expected: IntentCounts, observed: IntentCounts): CountDiff[] {
  const diffs: CountDiff[] = [];
  // heavy / rings are CountWithConfidence (number | { value, confidence }).
  // readCountValue collapses both forms to the numeric value, so the
  // comparison is value-based (a bare `!==` on the needs_zoom object form
  // compares references and always reports a spurious diff).
  const expHeavy = readCountValue(expected.heavy).value;
  const obsHeavy = readCountValue(observed.heavy).value;
  if (expHeavy !== obsHeavy) {
    diffs.push({ field: 'heavy', expected: expHeavy, observed: obsHeavy });
  }
  const expRings = readCountValue(expected.rings).value;
  const obsRings = readCountValue(observed.rings).value;
  if (expRings !== obsRings) {
    diffs.push({ field: 'rings', expected: expRings, observed: obsRings });
  }
  const keys = new Set<string>([
    ...Object.keys(expected.heteroatoms),
    ...Object.keys(observed.heteroatoms),
  ]);
  for (const key of keys) {
    const e = expected.heteroatoms[key] ?? 0;
    const o = observed.heteroatoms[key] ?? 0;
    if (e !== o) diffs.push({ field: `heteroatoms.${key}`, expected: e, observed: o });
  }
  return diffs;
}
