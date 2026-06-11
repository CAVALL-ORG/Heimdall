import { describe, expect, it } from 'vitest';
import { parseCIPSGroups } from '../../src/adapter/graph-intent/indigo-stereo';

const V3000_TWO_CHIRAL = `
  -INDIGO-05212619102D

  0  0  0  0  0  0  0  0  0  0  0 V3000
M  V30 BEGIN CTAB
M  V30 COUNTS 8 7 2 0 0
M  V30 BEGIN ATOM
M  V30 1 O 0.0 0.0 0.0 0
M  V30 2 C 0.0 0.0 0.0 0 CFG=2
M  V30 3 C 0.0 0.0 0.0 0
M  V30 4 C 0.0 0.0 0.0 0 CFG=1
M  V30 5 N 0.0 0.0 0.0 0
M  V30 6 C 0.0 0.0 0.0 0
M  V30 7 O 0.0 0.0 0.0 0
M  V30 8 O 0.0 0.0 0.0 0
M  V30 END ATOM
M  V30 BEGIN SGROUP
M  V30 1 DAT 1 ATOMS=(1 2) FIELDNAME=INDIGO_CIP_DESC FIELDDISP="    0.0000   -
M  V30  0.0000    DR    ALL  1       1  " FIELDDATA="(R)"
M  V30 2 DAT 2 ATOMS=(1 4) FIELDNAME=INDIGO_CIP_DESC FIELDDISP="    0.0000   -
M  V30  0.0000    DR    ALL  1       1  " FIELDDATA="(S)"
M  V30 END SGROUP
M  V30 END CTAB
M  END
`;

describe('indigo-stereo — parseCIPSGroups', () => {
  it('parses per-atom CIP descriptors from V3000 SGROUPs', () => {
    const cip = parseCIPSGroups(V3000_TWO_CHIRAL);
    expect(cip.size).toBe(2);
    expect(cip.get(2)).toBe('R');
    expect(cip.get(4)).toBe('S');
  });

  it('returns an empty map when no CIP_DESC records are present', () => {
    const cip = parseCIPSGroups('M  V30 END CTAB\nM  END\n');
    expect(cip.size).toBe(0);
  });

  it('handles single-line FIELDDATA without the line-continuation backslash', () => {
    const oneLine = `
M  V30 BEGIN SGROUP
M  V30 1 DAT 1 ATOMS=(1 7) FIELDNAME=INDIGO_CIP_DESC FIELDDISP="x" FIELDDATA="(R)"
M  V30 END SGROUP
`;
    const cip = parseCIPSGroups(oneLine);
    expect(cip.get(7)).toBe('R');
  });
});
