import { describe, expect, it } from 'vitest';
import {
  findBondIndex,
  heavyNeighbors,
  parseV2000,
  setWedge,
  stripWedges,
  writeV2000,
} from '../../src/adapter/graph-intent/molfile-stereo';

const ALANINE_FLAT = `test
  -INDIGO-test
test
  6  5  0  0  0  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.8660    0.5000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.8660    1.5000    0.0000 N   0  0  0  0  0  0  0  0  0  0  0  0
    1.7320    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.5980    0.5000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
    1.7320   -1.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
  2  3  1  0  0  0  0
  2  4  1  0  0  0  0
  4  5  2  0  0  0  0
  4  6  1  0  0  0  0
M  END`;

describe('molfile-stereo — parseV2000 / writeV2000', () => {
  it('parses atom and bond counts from the V2000 header', () => {
    const parsed = parseV2000(ALANINE_FLAT);
    expect(parsed.nAtoms).toBe(6);
    expect(parsed.nBonds).toBe(5);
    expect(parsed.atomLines).toHaveLength(6);
    expect(parsed.bondRecords).toHaveLength(5);
  });

  it('parses bond endpoint + order + stereo per record', () => {
    const parsed = parseV2000(ALANINE_FLAT);
    const b0 = parsed.bondRecords[0];
    expect(b0.a1).toBe(1);
    expect(b0.a2).toBe(2);
    expect(b0.order).toBe(1);
    expect(b0.stereo).toBe(0);
  });

  it('round-trips parse → write losslessly for a flat molfile', () => {
    const parsed = parseV2000(ALANINE_FLAT);
    const reconstructed = writeV2000(parsed);
    // Bond columns must be re-formatted exactly; whole-file equality
    // depends on the input not having trailing whitespace differences.
    const reparsed = parseV2000(reconstructed);
    expect(reparsed.nAtoms).toBe(parsed.nAtoms);
    expect(reparsed.nBonds).toBe(parsed.nBonds);
    expect(reparsed.bondRecords).toEqual(parsed.bondRecords);
  });
});

describe('molfile-stereo — setWedge / stripWedges', () => {
  it('sets stereo=1 for solid wedge and normalizes chiral to a1', () => {
    const parsed = parseV2000(ALANINE_FLAT);
    const ok = setWedge(parsed, 2, 3, 'solid');
    expect(ok).toBe(true);
    const b = parsed.bondRecords[findBondIndex(parsed, 2, 3)!];
    expect(b.a1).toBe(2);
    expect(b.a2).toBe(3);
    expect(b.stereo).toBe(1);
  });

  it('sets stereo=6 for hashed wedge', () => {
    const parsed = parseV2000(ALANINE_FLAT);
    setWedge(parsed, 2, 4, 'hashed');
    const b = parsed.bondRecords[findBondIndex(parsed, 2, 4)!];
    expect(b.stereo).toBe(6);
  });

  it('swaps endpoints when chiral is the second atom in the bond record', () => {
    const parsed = parseV2000(ALANINE_FLAT);
    // bond record 0 is (1, 2): nominally a1=1, a2=2. Setting chiral=2,
    // nbr=1 should swap so a1=2.
    setWedge(parsed, 2, 1, 'solid');
    const b = parsed.bondRecords[0];
    expect(b.a1).toBe(2);
    expect(b.a2).toBe(1);
    expect(b.stereo).toBe(1);
  });

  it('returns false when bond does not exist', () => {
    const parsed = parseV2000(ALANINE_FLAT);
    expect(setWedge(parsed, 1, 99, 'solid')).toBe(false);
  });

  it('stripWedges resets all UP/DOWN stereo to 0 but leaves order intact', () => {
    const parsed = parseV2000(ALANINE_FLAT);
    setWedge(parsed, 2, 3, 'solid');
    setWedge(parsed, 4, 5, 'hashed');
    stripWedges(parsed);
    for (const b of parsed.bondRecords) {
      expect(b.stereo).toBe(0);
    }
    expect(parsed.bondRecords.find((b) => b.a1 === 4 && b.a2 === 5)?.order).toBe(2);
  });
});

describe('molfile-stereo — heavyNeighbors', () => {
  it('lists neighboring 1-based atom ids that are not H', () => {
    const parsed = parseV2000(ALANINE_FLAT);
    // atom 2 (the alpha carbon) is bonded to 1, 3, 4 — all heavy
    const nbrs = heavyNeighbors(parsed, 2).sort();
    expect(nbrs).toEqual([1, 3, 4]);
  });

  it('excludes H neighbors when they appear in the bond table', () => {
    const withH = ALANINE_FLAT.replace(
      '  6  5  0  0  0  0  0  0  0  0999 V2000',
      '  7  6  0  0  0  0  0  0  0  0999 V2000',
    )
      .replace(
        '  4  6  1  0  0  0  0\nM  END',
        '  4  6  1  0  0  0  0\n  2  7  1  0  0  0  0\nM  END',
      )
      .replace(
        '    1.7320   -1.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0\n',
        '    1.7320   -1.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0\n    0.8660    1.5000    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0\n',
      );
    const parsed = parseV2000(withH);
    expect(heavyNeighbors(parsed, 2).sort()).toEqual([1, 3, 4]);
  });
});
