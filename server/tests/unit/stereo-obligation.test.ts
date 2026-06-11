import { describe, expect, it } from 'vitest';
import { isCarbonStereoObligation } from '../../src/adapter/graph-intent/stereo-obligation';

describe('isCarbonStereoObligation', () => {
  it('carbon is a genuine drawn-stereo obligation', () => {
    expect(isCarbonStereoObligation('C')).toBe(true);
  });
  it('planar / inverting nitrogen is not (Indigo over-perception)', () => {
    expect(isCarbonStereoObligation('N')).toBe(false);
  });
  it('resonance-symmetric phosphate phosphorus is not', () => {
    expect(isCarbonStereoObligation('P')).toBe(false);
  });
  it('sulfur (sulfone/sulfoxide) is not auto-demanded', () => {
    expect(isCarbonStereoObligation('S')).toBe(false);
  });
  it('oxygen is not', () => {
    expect(isCarbonStereoObligation('O')).toBe(false);
  });
});
