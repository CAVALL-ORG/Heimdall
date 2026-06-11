import { describe, expect, it } from 'vitest';
import { findUnderValentAtoms, type ValenceAtom } from '../../src/adapter/graph-intent/valence-sanity';

const A = (o: Partial<ValenceAtom> & { id: number; label: string; computedValence: number }): ValenceAtom => ({
  charge: 0, radical: 0, aromatic: false, ...o,
});

describe('findUnderValentAtoms', () => {
  it('flags an under-valent neutral carbon (3-valent, no charge/radical)', () => {
    expect(findUnderValentAtoms([A({ id: 1, label: 'C', computedValence: 3 })])).toEqual([1]);
  });
  it('passes a saturated carbon (computedValence 4)', () => {
    expect(findUnderValentAtoms([A({ id: 1, label: 'C', computedValence: 4 })])).toEqual([]);
  });
  it('does NOT flag a carbanion (under-valent but charge explains it)', () => {
    expect(findUnderValentAtoms([A({ id: 1, label: 'C', computedValence: 3, charge: -1 })])).toEqual([]);
  });
  it('does NOT flag a declared radical carbon', () => {
    expect(findUnderValentAtoms([A({ id: 1, label: 'C', computedValence: 3, radical: 1 })])).toEqual([]);
  });
  it('does NOT flag an aromatic carbon (ring satisfies valence)', () => {
    expect(findUnderValentAtoms([A({ id: 1, label: 'C', computedValence: 3, aromatic: true })])).toEqual([]);
  });
  it('flags an under-valent neutral nitrogen (2-valent)', () => {
    expect(findUnderValentAtoms([A({ id: 9, label: 'N', computedValence: 2 })])).toEqual([9]);
  });
  it('ignores variable-valence atoms (S/P) and non-organic (no false positives)', () => {
    expect(findUnderValentAtoms([
      A({ id: 1, label: 'S', computedValence: 2 }),
      A({ id: 2, label: 'P', computedValence: 3 }),
      A({ id: 3, label: 'Na', computedValence: 0 }),
    ])).toEqual([]);
  });
});
