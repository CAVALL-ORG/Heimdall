/**
 * planRadicalReconciliation — the pure decision table behind the translator's
 * parser-radical reconcile (lone `[Na]` `|^1:0|` artifact, 2026-06-06
 * sodium-acetate finding). End-to-end behavior is covered by
 * tests/runtime-e2e/lone-metal-radical.e2e.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { planRadicalReconciliation } from '../../src/adapter/graph-intent/radical';

const atom = (
  id: number,
  radical: 0 | 1 | 2 = 0,
  drawn_H: number | null = null,
) => ({ id, radical, drawn_H });

describe('planRadicalReconciliation', () => {
  it('clears a parser radical on a declared-0 atom and pins implicit H when drawn_H is null', () => {
    expect(planRadicalReconciliation([atom(0)], new Map([[0, 2]]))).toEqual([
      { intentId: 0, pinImplicitHZero: true },
    ]);
  });

  it('does not pin implicit H when the agent declared a drawn_H (that pass already set it)', () => {
    expect(planRadicalReconciliation([atom(0, 0, 1)], new Map([[0, 2]]))).toEqual([
      { intentId: 0, pinImplicitHZero: false },
    ]);
  });

  it('emits nothing when the canvas radical is already clean', () => {
    expect(planRadicalReconciliation([atom(0)], new Map([[0, 0]]))).toEqual([]);
  });

  it('leaves declared radicals to the set pass', () => {
    expect(planRadicalReconciliation([atom(0, 1)], new Map([[0, 2]]))).toEqual([]);
    expect(planRadicalReconciliation([atom(0, 2)], new Map([[0, 3]]))).toEqual([]);
  });

  it('skips atoms with no canvas mapping (expanded-away shorthand placeholders)', () => {
    expect(planRadicalReconciliation([atom(7)], new Map())).toEqual([]);
    expect(planRadicalReconciliation([atom(7)], new Map([[7, null]]))).toEqual([]);
  });

  it('filters a mixed atom list down to the spurious-radical carriers only', () => {
    const atoms = [atom(0), atom(1, 1), atom(2), atom(3, 0, 2)];
    const canvas = new Map<number, number | null>([
      [0, 2], // parser artifact → action
      [1, 2], // declared radical → set pass owns
      [2, 0], // clean → no action
      [3, 2], // artifact but drawn_H declared → action without pin
    ]);
    expect(planRadicalReconciliation(atoms, canvas)).toEqual([
      { intentId: 0, pinImplicitHZero: true },
      { intentId: 3, pinImplicitHZero: false },
    ]);
  });
});
