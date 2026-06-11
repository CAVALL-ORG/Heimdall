import { describe, expect, it } from 'vitest';
import { diffState, type AgentState } from '../../src/adapter/diff';

const baseState: AgentState = {
  smiles: 'CC',
  ket: '{}',
  isEmpty: false,
  isReaction: false,
  atoms: [
    { id: 1, label: 'C', charge: 0, radical: 0 },
    { id: 2, label: 'C', charge: 0, radical: 0 },
  ],
  bonds: [{ id: 10, beginAtomId: 1, endAtomId: 2, order: 1, stereo: 0 }],
};

describe('diffState', () => {
  it('captures changed atom and bond fields', () => {
    const after: AgentState = {
      ...baseState,
      smiles: 'C=C',
      atoms: [
        { id: 1, label: 'C', charge: 1, radical: 0 },
        { id: 2, label: 'C', charge: 0, radical: 0 },
      ],
      bonds: [{ id: 10, beginAtomId: 1, endAtomId: 2, order: 2, stereo: 0 }],
    };

    const diff = diffState(baseState, after);
    expect(diff.smilesChanged).toBe(true);
    expect(diff.updatedAtoms).toEqual([{ id: 1, fields: ['charge'] }]);
    expect(diff.updatedBonds).toEqual([{ id: 10, fields: ['order'] }]);
  });
});
