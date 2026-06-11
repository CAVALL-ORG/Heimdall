import { describe, expect, it } from 'vitest';
import { isMassSkip } from '../../src/adapter/graph-intent/translator';

describe('isMassSkip (W5 ratio gate)', () => {
  it('all 12 centers unknown -> mass skip', () => {
    expect(isMassSkip({ assignedCount: 0, unknownCount: 12 })).toBe(true);
  });
  it('a normal dense build (11 wedged, 0 unknown) -> not a mass skip', () => {
    expect(isMassSkip({ assignedCount: 11, unknownCount: 0 })).toBe(false);
  });
  it('below K_min (4 centers, all unknown) -> not gated', () => {
    expect(isMassSkip({ assignedCount: 0, unknownCount: 4 })).toBe(false);
  });
  it('a legit partial skip (8 wedged, 1 unknown, K=9) -> allowed', () => {
    expect(isMassSkip({ assignedCount: 8, unknownCount: 1 })).toBe(false);
  });
  it('half-skipped at K>=5 (3 wedged, 3 unknown) -> gated', () => {
    expect(isMassSkip({ assignedCount: 3, unknownCount: 3 })).toBe(true);
  });
});
