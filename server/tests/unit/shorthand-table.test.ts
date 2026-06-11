import { describe, expect, it } from 'vitest';
import {
  decomposeShorthand,
  knownShorthandNames,
} from '../../src/adapter/visual-graph/shorthand-table';

describe('shorthand-table (LOCK 11)', () => {
  it('decomposes common alkyl groups', () => {
    const me = decomposeShorthand('Me');
    expect(me.unknown).toBe(false);
    if (!me.unknown) {
      expect(me.atoms).toHaveLength(1);
      expect(me.atoms[0].element).toBe('C');
      expect(me.atoms[0].drawn_H).toBe(3);
      expect(me.attachment_atom_offset).toBe(0);
    }

    const tBu = decomposeShorthand('tBu');
    expect(tBu.unknown).toBe(false);
    if (!tBu.unknown) {
      expect(tBu.atoms).toHaveLength(4);
      expect(tBu.atoms.every((a) => a.element === 'C')).toBe(true);
    }
  });

  it('decomposes oxy groups with O at attachment offset 0', () => {
    const ome = decomposeShorthand('OMe');
    expect(ome.unknown).toBe(false);
    if (!ome.unknown) {
      expect(ome.atoms[0].element).toBe('O');
      expect(ome.atoms[1].element).toBe('C');
      expect(ome.atoms[1].drawn_H).toBe(3);
      expect(ome.attachment_atom_offset).toBe(0);
    }
  });

  it('decomposes Ph into a 6-ring of C with Kekulé bonds', () => {
    const ph = decomposeShorthand('Ph');
    expect(ph.unknown).toBe(false);
    if (!ph.unknown) {
      expect(ph.atoms).toHaveLength(6);
      expect(ph.bonds).toHaveLength(6);
      const orderTotal = ph.bonds.reduce((s, b) => s + b.order, 0);
      expect(orderTotal).toBe(9); // 3 singles + 3 doubles
    }
  });

  it('returns unknown for tokens not in the table', () => {
    expect(decomposeShorthand('Xx').unknown).toBe(true);
    expect(decomposeShorthand('R1').unknown).toBe(true);
    expect(decomposeShorthand('').unknown).toBe(true);
  });

  it('handles isotope patterns (LOCK 23) and sets isotope field', () => {
    const c13 = decomposeShorthand('13C');
    expect(c13.unknown).toBe(false);
    if (!c13.unknown) {
      expect(c13.atoms).toHaveLength(1);
      expect(c13.atoms[0].element).toBe('C');
      expect(c13.atoms[0].isotope).toBe(13);
    }
    const h2 = decomposeShorthand('2H');
    expect(h2.unknown).toBe(false);
    if (!h2.unknown) {
      expect(h2.atoms[0].element).toBe('H');
      expect(h2.atoms[0].isotope).toBe(2);
    }
    const n15 = decomposeShorthand('15N');
    expect(n15.unknown).toBe(false);
    if (!n15.unknown) {
      expect(n15.atoms[0].isotope).toBe(15);
    }
  });

  it('includes SO2, SO3H, OTs (full plan catalog)', () => {
    expect(decomposeShorthand('SO2').unknown).toBe(false);
    expect(decomposeShorthand('SO3H').unknown).toBe(false);
    expect(decomposeShorthand('OTs').unknown).toBe(false);
  });

  it('every entry in knownShorthandNames round-trips', () => {
    for (const name of knownShorthandNames()) {
      const result = decomposeShorthand(name);
      expect(result.unknown).toBe(false);
      if (!result.unknown) {
        expect(result.atoms.length).toBeGreaterThan(0);
      }
    }
  });

  it('trims whitespace', () => {
    expect(decomposeShorthand('  Me  ').unknown).toBe(false);
  });

  // ── Task 2A.2: next-tier alkyl shorthand ─────────────────────────────────
  //
  // Et, iPr, nPr, tBu, iBu, sBu (and Pr/Bu aliases) are unambiguous alkyls.
  // Each entry carries the correct heavy-atom count and attachment_atom_offset:0.
  // We choose option (a): add entries to the TABLE with round-trip tests.
  //
  //   Et   = ethyl       CH2-CH3          2 C, linear
  //   nPr  = n-propyl    CH2-CH2-CH3      3 C, linear (Pr = alias)
  //   iPr  = isopropyl   CH(CH3)2         3 C, branched
  //   nBu  = n-butyl     (CH2)3-CH3       4 C, linear (Bu = alias)
  //   sBu  = sec-butyl   CH(CH3)-CH2-CH3  4 C, one branch
  //   iBu  = isobutyl    CH2-CH(CH3)2     4 C, one branch
  //   tBu  = tert-butyl  C(CH3)3          4 C, three branches (already tested above)
  //
  // Rationale for option (a): all expansions are IUPAC-unambiguous, the Table
  // already contains Et/iPr/nPr/tBu/sBu/nBu/Pr/Bu. iBu is missing — added
  // in this commit.  No ambiguity risk: each symbol has exactly one
  // constitutional isomer by IUPAC convention.

  describe('next-tier alkyl decomposition (Task 2A.2)', () => {
    it('Et decomposes to 2 C atoms (ethyl)', () => {
      const r = decomposeShorthand('Et');
      expect(r.unknown).toBe(false);
      if (!r.unknown) {
        expect(r.atoms).toHaveLength(2);
        expect(r.atoms.every((a) => a.element === 'C')).toBe(true);
        expect(r.atoms[0].drawn_H).toBe(2);
        expect(r.atoms[1].drawn_H).toBe(3);
        expect(r.bonds).toHaveLength(1);
        expect(r.attachment_atom_offset).toBe(0);
      }
    });

    it('nPr decomposes to 3 C atoms (n-propyl), attachment at 0', () => {
      const r = decomposeShorthand('nPr');
      expect(r.unknown).toBe(false);
      if (!r.unknown) {
        expect(r.atoms).toHaveLength(3);
        expect(r.atoms.every((a) => a.element === 'C')).toBe(true);
        expect(r.bonds).toHaveLength(2);
        expect(r.attachment_atom_offset).toBe(0);
      }
    });

    it('Pr (alias) decomposes identically to nPr', () => {
      const pr = decomposeShorthand('Pr');
      const npr = decomposeShorthand('nPr');
      expect(pr.unknown).toBe(false);
      expect(npr.unknown).toBe(false);
      if (!pr.unknown && !npr.unknown) {
        expect(pr.atoms).toEqual(npr.atoms);
        expect(pr.bonds).toEqual(npr.bonds);
      }
    });

    it('iPr decomposes to 3 C atoms (isopropyl) with branched topology', () => {
      const r = decomposeShorthand('iPr');
      expect(r.unknown).toBe(false);
      if (!r.unknown) {
        expect(r.atoms).toHaveLength(3);
        expect(r.atoms.every((a) => a.element === 'C')).toBe(true);
        // CH at attachment, two CH3 branches
        expect(r.atoms[0].drawn_H).toBe(1); // CH
        expect(r.atoms[1].drawn_H).toBe(3); // CH3
        expect(r.atoms[2].drawn_H).toBe(3); // CH3
        expect(r.bonds).toHaveLength(2);
        expect(r.attachment_atom_offset).toBe(0);
      }
    });

    it('iBu decomposes to 4 C atoms (isobutyl): CH2-CH(CH3)2', () => {
      // iBu = isobutyl = -CH2-CH(CH3)2
      // atoms: [CH2 (attachment), CH, CH3, CH3]
      // bonds: 0-1, 1-2, 1-3
      const r = decomposeShorthand('iBu');
      expect(r.unknown).toBe(false);
      if (!r.unknown) {
        expect(r.atoms).toHaveLength(4);
        expect(r.atoms.every((a) => a.element === 'C')).toBe(true);
        expect(r.atoms[0].drawn_H).toBe(2); // CH2, attachment
        expect(r.atoms[1].drawn_H).toBe(1); // CH
        expect(r.atoms[2].drawn_H).toBe(3); // CH3
        expect(r.atoms[3].drawn_H).toBe(3); // CH3
        expect(r.bonds).toHaveLength(3);
        expect(r.attachment_atom_offset).toBe(0);
      }
    });

    it('sBu decomposes to 4 C atoms (sec-butyl)', () => {
      const r = decomposeShorthand('sBu');
      expect(r.unknown).toBe(false);
      if (!r.unknown) {
        expect(r.atoms).toHaveLength(4);
        expect(r.atoms.every((a) => a.element === 'C')).toBe(true);
        expect(r.bonds).toHaveLength(3);
        expect(r.attachment_atom_offset).toBe(0);
      }
    });

    it('nBu decomposes to 4 C atoms (n-butyl), linear', () => {
      const r = decomposeShorthand('nBu');
      expect(r.unknown).toBe(false);
      if (!r.unknown) {
        expect(r.atoms).toHaveLength(4);
        expect(r.atoms.every((a) => a.element === 'C')).toBe(true);
        expect(r.bonds).toHaveLength(3);
        expect(r.attachment_atom_offset).toBe(0);
      }
    });

    it('Bu (alias) decomposes identically to nBu', () => {
      const bu = decomposeShorthand('Bu');
      const nbu = decomposeShorthand('nBu');
      expect(bu.unknown).toBe(false);
      expect(nbu.unknown).toBe(false);
      if (!bu.unknown && !nbu.unknown) {
        expect(bu.atoms).toEqual(nbu.atoms);
        expect(bu.bonds).toEqual(nbu.bonds);
      }
    });

    it('tBu decomposes to 4 C atoms (tert-butyl): C(CH3)3', () => {
      const r = decomposeShorthand('tBu');
      expect(r.unknown).toBe(false);
      if (!r.unknown) {
        expect(r.atoms).toHaveLength(4);
        expect(r.atoms.every((a) => a.element === 'C')).toBe(true);
        expect(r.atoms[0].drawn_H).toBe(0); // quaternary C
        expect(r.atoms[1].drawn_H).toBe(3);
        expect(r.atoms[2].drawn_H).toBe(3);
        expect(r.atoms[3].drawn_H).toBe(3);
        expect(r.bonds).toHaveLength(3);
        expect(r.attachment_atom_offset).toBe(0);
      }
    });
  });
});
