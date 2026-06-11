// Chemistry-flavored derivations over Ketcher graph state. The algorithm
// contracts (lone-pair formula, conjugation-group folding rule) live in
// .claude/skills/chem/_shared/motif-catalog.md and .claude/skills/chem/_shared/
// annotated-state-schema.md — this file is the TypeScript implementation of
// those documented rules, runnable inside the headless Playwright page.

import { Bond } from 'ketcher-core';

import type { BondListEntry } from './graph';

export const GROUP_VALENCE_ELECTRONS: Record<string, number> = {
  H: 1, B: 3, C: 4, N: 5, O: 6, F: 7,
  Si: 4, P: 5, S: 6, Cl: 7, Br: 7, I: 7, Se: 6, As: 5,
};

export function computeLonePairs(label: string, computedValence: number, charge: number): number {
  const ve = GROUP_VALENCE_ELECTRONS[label];
  if (ve === undefined) return 0;
  const remaining = ve - computedValence - charge;
  if (remaining <= 0) return 0;
  return Math.floor(remaining / 2);
}

export function isLonePairDonor(label: string, charge: number, lonePairs: number): boolean {
  // Heteroatom with at least one lone pair.
  if (lonePairs >= 1 && label !== 'C' && label !== 'H') return true;
  // Anionic carbon (carbanion) acts as a lone-pair donor in resonance.
  if (label === 'C' && charge < 0 && lonePairs >= 1) return true;
  return false;
}

export type AtomInfo = { label: string; computedValence: number; charge: number };

export type ConjugationGroup = {
  id: number;
  atomIds: number[];
  bondIds: number[];
};

export type ConjugationResult = {
  bondGroup: Map<number, number>;
  groups: ConjugationGroup[];
};

export function computeConjugationGroups(
  bondList: BondListEntry[],
  atomInfo: Map<number, AtomInfo>,
): ConjugationResult {
  const bondGroup = new Map<number, number>();
  const groups: ConjugationGroup[] = [];

  // A bond *seeds* a conjugated component if its order is > 1 (double, triple, aromatic).
  // Lone-pair-donor atoms attached via single bonds are then folded in as part of the
  // same component (anion / lone-pair-into-π cases such as carboxylate, phenoxide,
  // anisole-type radical cations).
  const seedBonds = bondList.filter(
    (bond) =>
      bond.type === Bond.PATTERN.TYPE.DOUBLE ||
      bond.type === Bond.PATTERN.TYPE.TRIPLE ||
      bond.type === Bond.PATTERN.TYPE.AROMATIC,
  );

  const atomToSeedBonds = new Map<number, number[]>();
  for (const bond of seedBonds) {
    if (!atomToSeedBonds.has(bond.begin)) atomToSeedBonds.set(bond.begin, []);
    if (!atomToSeedBonds.has(bond.end)) atomToSeedBonds.set(bond.end, []);
    atomToSeedBonds.get(bond.begin)!.push(bond.id);
    atomToSeedBonds.get(bond.end)!.push(bond.id);
  }

  const visitedBonds = new Set<number>();
  const bondById = new Map<number, BondListEntry>();
  for (const bond of bondList) bondById.set(bond.id, bond);

  let nextGroupId = 0;
  const atomGroup = new Map<number, number>();

  // Pass 1: connected components over seed bonds (multi-order edges).
  for (const seed of seedBonds) {
    if (visitedBonds.has(seed.id)) continue;
    const groupId = nextGroupId++;
    const groupAtomIds = new Set<number>();
    const groupBondIds = new Set<number>();
    const queue: number[] = [seed.id];
    visitedBonds.add(seed.id);
    while (queue.length) {
      const bondId = queue.shift();
      if (bondId === undefined) continue;
      const bond = bondById.get(bondId);
      if (!bond) continue;
      groupBondIds.add(bondId);
      bondGroup.set(bondId, groupId);
      for (const atomId of [bond.begin, bond.end]) {
        groupAtomIds.add(atomId);
        atomGroup.set(atomId, groupId);
        for (const neighborBondId of atomToSeedBonds.get(atomId) ?? []) {
          if (visitedBonds.has(neighborBondId)) continue;
          visitedBonds.add(neighborBondId);
          queue.push(neighborBondId);
        }
      }
    }
    groups.push({
      id: groupId,
      atomIds: [...groupAtomIds],
      bondIds: [...groupBondIds],
    });
  }

  // Pass 2: fold in lone-pair donors attached via single bonds. A single bond joins
  // the existing group iff one endpoint is already in a group AND the other endpoint
  // is a lone-pair donor relative to that bond (heteroatom with lone pairs, or
  // carbanion). Iterate to fixed point so that chains like C(=O)–O–H eventually
  // sweep in donors that themselves enable further attachments.
  let changed = true;
  while (changed) {
    changed = false;
    for (const bond of bondList) {
      if (bond.type !== Bond.PATTERN.TYPE.SINGLE) continue;
      if (bondGroup.has(bond.id)) continue;
      const beginGroup = atomGroup.get(bond.begin);
      const endGroup = atomGroup.get(bond.end);
      let targetGroup: number | undefined;
      let donorAtom: number | undefined;
      if (beginGroup !== undefined && endGroup === undefined) {
        targetGroup = beginGroup;
        donorAtom = bond.end;
      } else if (endGroup !== undefined && beginGroup === undefined) {
        targetGroup = endGroup;
        donorAtom = bond.begin;
      } else {
        continue; // both in groups (would merge groups — not Phase-1) or neither
      }
      const donorInfo = atomInfo.get(donorAtom);
      if (!donorInfo) continue;
      const donorLP = computeLonePairs(
        donorInfo.label,
        donorInfo.computedValence,
        donorInfo.charge,
      );
      if (!isLonePairDonor(donorInfo.label, donorInfo.charge, donorLP)) continue;
      bondGroup.set(bond.id, targetGroup);
      atomGroup.set(donorAtom, targetGroup);
      const group = groups[targetGroup];
      if (!group.atomIds.includes(donorAtom)) group.atomIds.push(donorAtom);
      group.bondIds.push(bond.id);
      changed = true;
    }
  }

  // Sort each group's atom and bond ID lists for stable output.
  for (const group of groups) {
    group.atomIds.sort((a, b) => a - b);
    group.bondIds.sort((a, b) => a - b);
  }

  return { bondGroup, groups };
}
