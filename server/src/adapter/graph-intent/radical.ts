/**
 * Map unpaired-electron count → Ketcher's radical category code.
 *
 * GraphIntent encodes `radical` as a physical electron count (0/1/2);
 * Ketcher's `setAtomRadical` takes a category code (0=NONE, 1=SINGLET,
 * 2=DOUBLET, 3=TRIPLET). The translator owns this mapping so callers
 * never confront the "doublet = 2 not 1" footgun.
 */
export function radicalCodeFromCount(count: 0 | 1 | 2): number {
  switch (count) {
    case 0:
      return 0; // NONE
    case 1:
      return 2; // DOUBLET — one unpaired electron
    case 2:
      return 3; // TRIPLET — two unpaired electrons of the same spin
  }
}

export type RadicalReconcileAtom = {
  id: number;
  radical: 0 | 1 | 2;
  drawn_H: number | null;
};

export type RadicalReconcileAction = {
  intentId: number;
  /**
   * Clearing a parser-introduced radical reroutes the atom's unmet natural
   * valence into implicit H (lone Na: `|^1:0|` cleared → `[NaH]`), so when
   * the agent declared no drawn_H the implicit-H count must be pinned to 0
   * alongside the clear. When a drawn_H WAS declared, the drawn_H pass
   * already set the count and must not be overwritten.
   */
  pinImplicitHZero: boolean;
};

/**
 * Plan the parser-radical reconcile that runs after the declared-radical
 * pass. `singleAtomSmiles` seeds lone non-organic atoms via bracket SMILES
 * (`[Na]`, `[K]`, …), and Indigo's parser encodes their unmet natural
 * valence as an unpaired electron — the canvas atom arrives with radical
 * DOUBLET even though the agent declared `radical: 0`, and exports carry a
 * spurious `|^1:0|` CXSMILES extension (the sodium-acetate finding).
 *
 * An action is emitted only for atoms that declared `radical: 0` but whose
 * canvas atom carries a nonzero radical. Declared radicals are owned by the
 * set pass; atoms without a canvas mapping (e.g. expanded-away shorthand
 * placeholders) are skipped.
 */
export function planRadicalReconciliation(
  atoms: ReadonlyArray<RadicalReconcileAtom>,
  canvasRadicalByIntentId: ReadonlyMap<number, number | null>,
): RadicalReconcileAction[] {
  const actions: RadicalReconcileAction[] = [];
  for (const atom of atoms) {
    if (atom.radical !== 0) continue; // declared radical — the set pass owns it
    const canvasRadical = canvasRadicalByIntentId.get(atom.id);
    if (canvasRadical === undefined || canvasRadical === null || canvasRadical === 0) continue;
    actions.push({ intentId: atom.id, pinImplicitHZero: atom.drawn_H === null });
  }
  return actions;
}
