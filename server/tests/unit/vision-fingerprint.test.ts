import { describe, it, expect } from 'vitest';
import {
  computeVisionCheckCandidate,
  type FingerprintAtom,
  type FingerprintBond,
} from '../../src/adapter/graph-intent/vision-fingerprint';

// Hand-constructed annotated-state fixtures. Each test verifies that the
// pure fingerprint function produces the expected structured output for a
// known molecule. The fixtures emulate what Ketcher's getAnnotatedState
// returns (atoms with label+charge, bonds with order/stereo/aromatic/inRing).
//
// Coverage targets the handoff §4 acceptance set: benzene / acetate /
// alanine / glucose / cholesterol-shape — plus the A004-class small
// heteroatom-ring case (oxetane) and a fused-ring case (naphthalene) that
// exercise the SSSR + ring-connectivity branches.

function atom(id: number, label: string, charge = 0): FingerprintAtom {
  return { id, label, charge };
}

function bond(
  id: number,
  begin: number,
  end: number,
  order: number,
  opts: { aromatic?: boolean; inRing?: boolean; stereo?: number } = {},
): FingerprintBond {
  return {
    id,
    beginAtomId: begin,
    endAtomId: end,
    order,
    stereo: opts.stereo ?? 0,
    aromatic: opts.aromatic ?? false,
    inRing: opts.inRing ?? false,
  };
}

describe('computeVisionCheckCandidate', () => {
  it('benzene (c1ccccc1)', () => {
    const atoms = [0, 1, 2, 3, 4, 5].map((i) => atom(i, 'C'));
    const bonds = [
      bond(10, 0, 1, 4, { aromatic: true, inRing: true }),
      bond(11, 1, 2, 4, { aromatic: true, inRing: true }),
      bond(12, 2, 3, 4, { aromatic: true, inRing: true }),
      bond(13, 3, 4, 4, { aromatic: true, inRing: true }),
      bond(14, 4, 5, 4, { aromatic: true, inRing: true }),
      bond(15, 5, 0, 4, { aromatic: true, inRing: true }),
    ];

    const out = computeVisionCheckCandidate({
      atoms,
      bonds,
      drawnHAtomIds: [],
      canonicalSmiles: 'c1ccccc1',
    });

    expect(out.heavy).toBe(6);
    expect(out.rings).toEqual([{ id: 'r0', size: 6, aromatic: true }]);
    expect(out.ring_connectivity).toEqual([]);
    expect(out.drawn_H_atoms).toEqual([]);
    expect(out.wedges).toEqual([]);
    expect(out.cis_trans_count).toBe(0);
    expect(out.charges).toEqual([]);
    expect(out.arene_substitution_pattern).toEqual([{ ring: 'r0', positions: [] }]);
    expect(out.ring_heteroatom_positions).toEqual([]);
    // Element walk is the structural invariant; specific atom-id sequence
    // is unconstrained for fully-symmetric rings (canonicalization ties
    // arbitrarily, both forward and reverse rotations producing identical
    // element walks).
    expect(out.ring_atom_walks).toHaveLength(1);
    expect(out.ring_atom_walks[0].ring).toBe('r0');
    expect(out.ring_atom_walks[0].atoms.map((a) => a.element)).toEqual([
      'C',
      'C',
      'C',
      'C',
      'C',
      'C',
    ]);
    expect(out.ring_atom_walks[0].atoms.map((a) => a.position)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
    ]);
  });

  it('sodium acetate (CC(=O)[O-].[Na+]) — two fragments, two charges', () => {
    // Atoms: 0 C-methyl, 1 C-carboxylate, 2 O (=O), 3 O-, 4 Na+
    const atoms = [
      atom(0, 'C'),
      atom(1, 'C'),
      atom(2, 'O'),
      atom(3, 'O', -1),
      atom(4, 'Na', 1),
    ];
    const bonds = [
      bond(10, 0, 1, 1),
      bond(11, 1, 2, 2),
      bond(12, 1, 3, 1),
    ];

    const out = computeVisionCheckCandidate({
      atoms,
      bonds,
      drawnHAtomIds: [],
      canonicalSmiles: 'CC(=O)[O-].[Na+]',
    });

    expect(out.heavy).toBe(5);
    expect(out.rings).toEqual([]);
    expect(out.ring_connectivity).toEqual([]);
    expect(out.charges).toEqual([
      { id: 3, charge: -1 },
      { id: 4, charge: 1 },
    ]);
    expect(out.ring_atom_walks).toEqual([]);
  });

  it('L-alanine wedge — heavy=6, one solid wedge, no rings', () => {
    // Atoms: 0 N, 1 Cα, 2 C(=O), 3 O (=), 4 O (OH), 5 C-methyl
    const atoms = [
      atom(0, 'N'),
      atom(1, 'C'),
      atom(2, 'C'),
      atom(3, 'O'),
      atom(4, 'O'),
      atom(5, 'C'),
    ];
    // Wedge from Cα (1) to methyl (5): solid (stereo=1).
    const bonds = [
      bond(10, 0, 1, 1),
      bond(11, 1, 2, 1),
      bond(12, 2, 3, 2),
      bond(13, 2, 4, 1),
      bond(14, 1, 5, 1, { stereo: 1 }),
    ];

    const out = computeVisionCheckCandidate({
      atoms,
      bonds,
      drawnHAtomIds: [],
      canonicalSmiles: 'C[C@@H](N)C(=O)O',
    });

    expect(out.heavy).toBe(6);
    expect(out.rings).toEqual([]);
    expect(out.wedges).toEqual([{ a: 1, b: 5, kind: 'solid' }]);
    expect(out.charges).toEqual([]);
    expect(out.cis_trans_count).toBe(0);
  });

  it('oxetane (O1CCC1) — small heteroatom ring; A004-class hot spot', () => {
    // Atoms: 0 O, 1 C, 2 C, 3 C. Ring 0-1-2-3-0.
    const atoms = [atom(0, 'O'), atom(1, 'C'), atom(2, 'C'), atom(3, 'C')];
    const bonds = [
      bond(10, 0, 1, 1, { inRing: true }),
      bond(11, 1, 2, 1, { inRing: true }),
      bond(12, 2, 3, 1, { inRing: true }),
      bond(13, 3, 0, 1, { inRing: true }),
    ];

    const out = computeVisionCheckCandidate({
      atoms,
      bonds,
      drawnHAtomIds: [],
      canonicalSmiles: 'C1COC1',
    });

    expect(out.heavy).toBe(4);
    expect(out.rings).toEqual([{ id: 'r0', size: 4, aromatic: false }]);
    expect(out.ring_heteroatom_positions).toEqual([
      { ring: 'r0', entries: [{ element: 'O', position: 1 }] },
    ]);
    // Atom-by-atom walk — Step D fill-in-blank reference.
    expect(out.ring_atom_walks[0].atoms.map((a) => a.element)).toEqual([
      'O',
      'C',
      'C',
      'C',
    ]);
  });

  it('oxetane with O at a different atom-id — same canonical walk', () => {
    // Same molecule (oxetane), but the O sits at id=2 instead of id=0.
    // Locant-min canonicalization must produce the SAME ring walk
    // [O,C,C,C] regardless of atom-id space. This is the atom-id
    // independence property: the grader's RDKit fingerprint (different
    // atom-id space) must converge on the same canonical walk as the
    // translator's JS fingerprint.
    const atoms = [atom(0, 'C'), atom(1, 'C'), atom(2, 'O'), atom(3, 'C')];
    const bonds = [
      bond(10, 0, 1, 1, { inRing: true }),
      bond(11, 1, 2, 1, { inRing: true }),
      bond(12, 2, 3, 1, { inRing: true }),
      bond(13, 3, 0, 1, { inRing: true }),
    ];

    const out = computeVisionCheckCandidate({
      atoms,
      bonds,
      drawnHAtomIds: [],
      canonicalSmiles: 'C1COC1',
    });

    expect(out.ring_heteroatom_positions).toEqual([
      { ring: 'r0', entries: [{ element: 'O', position: 1 }] },
    ]);
    expect(out.ring_atom_walks[0].atoms.map((a) => a.element)).toEqual([
      'O',
      'C',
      'C',
      'C',
    ]);
  });

  it('pyridine (n1ccccc1) — aromatic ring with one ring N', () => {
    const atoms = [
      atom(0, 'N'),
      atom(1, 'C'),
      atom(2, 'C'),
      atom(3, 'C'),
      atom(4, 'C'),
      atom(5, 'C'),
    ];
    const bonds = [
      bond(10, 0, 1, 4, { aromatic: true, inRing: true }),
      bond(11, 1, 2, 4, { aromatic: true, inRing: true }),
      bond(12, 2, 3, 4, { aromatic: true, inRing: true }),
      bond(13, 3, 4, 4, { aromatic: true, inRing: true }),
      bond(14, 4, 5, 4, { aromatic: true, inRing: true }),
      bond(15, 5, 0, 4, { aromatic: true, inRing: true }),
    ];

    const out = computeVisionCheckCandidate({
      atoms,
      bonds,
      drawnHAtomIds: [],
      canonicalSmiles: 'c1ccncc1',
    });

    expect(out.rings).toEqual([{ id: 'r0', size: 6, aromatic: true }]);
    expect(out.ring_heteroatom_positions).toEqual([
      { ring: 'r0', entries: [{ element: 'N', position: 1 }] },
    ]);
  });

  it('toluene — arene_substitution_pattern position 1', () => {
    // Atoms 0-5 = ring (C); 6 = methyl C attached to ring atom 0.
    const atoms = [
      atom(0, 'C'),
      atom(1, 'C'),
      atom(2, 'C'),
      atom(3, 'C'),
      atom(4, 'C'),
      atom(5, 'C'),
      atom(6, 'C'),
    ];
    const bonds = [
      bond(10, 0, 1, 4, { aromatic: true, inRing: true }),
      bond(11, 1, 2, 4, { aromatic: true, inRing: true }),
      bond(12, 2, 3, 4, { aromatic: true, inRing: true }),
      bond(13, 3, 4, 4, { aromatic: true, inRing: true }),
      bond(14, 4, 5, 4, { aromatic: true, inRing: true }),
      bond(15, 5, 0, 4, { aromatic: true, inRing: true }),
      bond(16, 0, 6, 1),
    ];

    const out = computeVisionCheckCandidate({
      atoms,
      bonds,
      drawnHAtomIds: [],
      canonicalSmiles: 'Cc1ccccc1',
    });

    expect(out.arene_substitution_pattern).toEqual([{ ring: 'r0', positions: [1] }]);
  });

  it('1,2-disubstituted benzene (o-xylene) — positions [1,2]', () => {
    const atoms = [
      atom(0, 'C'),
      atom(1, 'C'),
      atom(2, 'C'),
      atom(3, 'C'),
      atom(4, 'C'),
      atom(5, 'C'),
      atom(6, 'C'),
      atom(7, 'C'),
    ];
    const bonds = [
      bond(10, 0, 1, 4, { aromatic: true, inRing: true }),
      bond(11, 1, 2, 4, { aromatic: true, inRing: true }),
      bond(12, 2, 3, 4, { aromatic: true, inRing: true }),
      bond(13, 3, 4, 4, { aromatic: true, inRing: true }),
      bond(14, 4, 5, 4, { aromatic: true, inRing: true }),
      bond(15, 5, 0, 4, { aromatic: true, inRing: true }),
      bond(16, 0, 6, 1),
      bond(17, 1, 7, 1),
    ];

    const out = computeVisionCheckCandidate({
      atoms,
      bonds,
      drawnHAtomIds: [],
      canonicalSmiles: 'Cc1ccccc1C',
    });

    expect(out.arene_substitution_pattern).toEqual([{ ring: 'r0', positions: [1, 2] }]);
  });

  it('naphthalene — two fused aromatic rings', () => {
    // 10 atoms, 11 ring bonds. Two 6-rings sharing the 0-1 edge.
    const atoms = Array.from({ length: 10 }, (_, i) => atom(i, 'C'));
    const bonds = [
      // Ring A: 0-1-2-3-4-5-0
      bond(10, 0, 1, 4, { aromatic: true, inRing: true }),
      bond(11, 1, 2, 4, { aromatic: true, inRing: true }),
      bond(12, 2, 3, 4, { aromatic: true, inRing: true }),
      bond(13, 3, 4, 4, { aromatic: true, inRing: true }),
      bond(14, 4, 5, 4, { aromatic: true, inRing: true }),
      bond(15, 5, 0, 4, { aromatic: true, inRing: true }),
      // Ring B: 1-6-7-8-9-2 (shares bond 1-2 with ring A — wait that's not right).
      // Standard naphthalene shares an edge. Use atoms 0-1 as the shared edge.
      // Ring A = 0-1-2-3-4-5-0; Ring B = 0-1-6-7-8-9-0.
      bond(16, 1, 6, 4, { aromatic: true, inRing: true }),
      bond(17, 6, 7, 4, { aromatic: true, inRing: true }),
      bond(18, 7, 8, 4, { aromatic: true, inRing: true }),
      bond(19, 8, 9, 4, { aromatic: true, inRing: true }),
      bond(20, 9, 0, 4, { aromatic: true, inRing: true }),
    ];

    const out = computeVisionCheckCandidate({
      atoms,
      bonds,
      drawnHAtomIds: [],
      canonicalSmiles: 'c1ccc2ccccc2c1',
    });

    expect(out.rings.length).toBe(2);
    expect(out.rings.every((r) => r.size === 6 && r.aromatic)).toBe(true);
    expect(out.ring_connectivity).toEqual([
      { ring_a: 'r0', ring_b: 'r1', kind: 'fused' },
    ]);
  });

  it('spiro[5.5]undecane — two 6-rings sharing one atom', () => {
    // Atoms 0-5 = ring A (carbocycle), atom 0 also belongs to ring B.
    // Ring B = 0-6-7-8-9-10-0.
    const atoms = Array.from({ length: 11 }, (_, i) => atom(i, 'C'));
    const bonds = [
      // Ring A: 0-1-2-3-4-5-0
      bond(10, 0, 1, 1, { inRing: true }),
      bond(11, 1, 2, 1, { inRing: true }),
      bond(12, 2, 3, 1, { inRing: true }),
      bond(13, 3, 4, 1, { inRing: true }),
      bond(14, 4, 5, 1, { inRing: true }),
      bond(15, 5, 0, 1, { inRing: true }),
      // Ring B: 0-6-7-8-9-10-0
      bond(16, 0, 6, 1, { inRing: true }),
      bond(17, 6, 7, 1, { inRing: true }),
      bond(18, 7, 8, 1, { inRing: true }),
      bond(19, 8, 9, 1, { inRing: true }),
      bond(20, 9, 10, 1, { inRing: true }),
      bond(21, 10, 0, 1, { inRing: true }),
    ];

    const out = computeVisionCheckCandidate({
      atoms,
      bonds,
      drawnHAtomIds: [],
      canonicalSmiles: 'C1CCC2(CC1)CCCCC2',
    });

    expect(out.rings.length).toBe(2);
    expect(out.ring_connectivity).toEqual([
      { ring_a: 'r0', ring_b: 'r1', kind: 'spiro' },
    ]);
  });

  it('cis-stilbene — cis/trans count from canonical SMILES slashes', () => {
    // Just check the cis/trans slash-count path. Connectivity is irrelevant
    // for this assertion.
    const out = computeVisionCheckCandidate({
      atoms: [],
      bonds: [],
      drawnHAtomIds: [],
      canonicalSmiles: 'c1ccc(/C=C\\c2ccccc2)cc1',
    });
    expect(out.cis_trans_count).toBe(1);
  });

  it('drawn_H_atoms passes through canvas-id list, sorted + deduped', () => {
    const atoms = [atom(0, 'N'), atom(1, 'C')];
    const out = computeVisionCheckCandidate({
      atoms,
      bonds: [],
      drawnHAtomIds: [5, 2, 5, 2, 9],
      canonicalSmiles: null,
    });
    expect(out.drawn_H_atoms).toEqual([2, 5, 9]);
  });
});
