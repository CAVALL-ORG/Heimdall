/**
 * C6/B2 — post-build valence-sanity gate. A committed heavy atom whose filled
 * valence (Ketcher's computedValence = bond orders + implicit H) falls below the
 * element's standard valence, with NO declared charge or radical to explain the
 * open valence, exports as a bare bracket atom (`[C]`) that reloads as a spurious
 * radical (pdf-extract handoff B2). Scoped to the FIXED-valence organic core
 * (C/N/O) and to non-aromatic, charge-0, radical-0 atoms — so carbanions,
 * declared radicals, aromatic ring atoms, and variable-valence S/P never trip it.
 */
export type ValenceAtom = {
  id: number;
  label: string;
  /** Ketcher's annotated state may return null for a zero-charge atom. */
  charge: number | null;
  radical: number;
  aromatic: boolean;
  computedValence: number;
};

const STANDARD_VALENCE: Record<string, number> = { C: 4, N: 3, O: 2 };

export function findUnderValentAtoms(atoms: ReadonlyArray<ValenceAtom>): number[] {
  const flagged: number[] = [];
  for (const a of atoms) {
    const std = STANDARD_VALENCE[a.label];
    if (std === undefined) continue;
    // null charge means zero (Ketcher omits the field when charge is 0)
    const charge = a.charge ?? 0;
    if (charge !== 0 || a.radical !== 0) continue;
    if (a.aromatic) continue;
    if (a.computedValence < std) flagged.push(a.id);
  }
  return flagged;
}
