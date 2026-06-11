import { describe, it, expect } from 'vitest';
import {
  clockwiseNeighborOrderFromCoords,
  comparisonTriple,
  compileWedge,
  cyclicParity,
  invertFacing,
  StereoTransferError,
  validateStereoTransferEntry,
  type FrozenCoords,
  type StereoTransferEntry,
} from '../../src/adapter/graph-intent/stereo-transfer';
import { graphIntentSchema } from '../../src/types/graph-intent';

// These tests pin `calibrationInvert` explicitly (the optional last argument)
// so they are independent of the module-global CALIBRATION_INVERT, whose value
// is resolved empirically by the Section 12 experiment.

// A 3-neighbour (implicit-H) entry whose drawn clockwise order is [3, 1, 2].
function implicitHEntry(over: Partial<StereoTransferEntry> = {}): StereoTransferEntry {
  return {
    center: 0,
    drawnNeighborsCW: [3, 1, 2],
    outOfPlaneNeighbor: 3,
    facing: 'toward',
    projection: 'wedge',
    confidence: 0.9,
    ...over,
  };
}

// Coords placing neighbors so the un-inverted Ketcher CW order == [3, 1, 2]
// (parity "same"): 3 at angle pi, 1 at pi/2, 2 at 0 -> descending atan2.
const coordsSame: FrozenCoords = {
  0: { x: 0, y: 0 },
  3: { x: -1, y: 0 },
  1: { x: 0, y: 1 },
  2: { x: 1, y: 0 },
};

// Coords placing neighbors so the un-inverted Ketcher CW order == [3, 2, 1]
// (parity "opposite" vs source [3, 1, 2]).
const coordsOpposite: FrozenCoords = {
  0: { x: 0, y: 0 },
  3: { x: -1, y: 0 },
  2: { x: 0, y: 1 },
  1: { x: 1, y: 0 },
};

describe('comparisonTriple', () => {
  it('3-neighbour center returns all 3 drawn neighbours', () => {
    expect(comparisonTriple(implicitHEntry())).toEqual([3, 1, 2]);
  });

  it('4-neighbour center drops outOfPlaneNeighbor and returns 3', () => {
    const quaternary = implicitHEntry({
      drawnNeighborsCW: [10, 11, 12, 13],
      outOfPlaneNeighbor: 12,
    });
    expect(comparisonTriple(quaternary)).toEqual([10, 11, 13]);
  });
});

describe('cyclicParity', () => {
  it('identical order -> "same"', () => {
    expect(cyclicParity([1, 2, 3], [1, 2, 3])).toBe('same');
  });

  it('rotation of order -> "same"', () => {
    expect(cyclicParity([1, 2, 3], [2, 3, 1])).toBe('same');
  });

  it('reversed order -> "opposite"', () => {
    expect(cyclicParity([1, 2, 3], [3, 2, 1])).toBe('opposite');
  });

  it('reverse-rotation of order -> "opposite"', () => {
    expect(cyclicParity([1, 2, 3], [2, 1, 3])).toBe('opposite');
  });

  it('non-3-element input -> "error"', () => {
    expect(cyclicParity([1, 2], [1, 2])).toBe('error');
    expect(cyclicParity([1, 2, 3, 4], [1, 2, 3, 4])).toBe('error');
  });

  it('mismatched id sets -> "error"', () => {
    expect(cyclicParity([1, 2, 3], [1, 2, 4])).toBe('error');
  });
});

describe('clockwiseNeighborOrderFromCoords', () => {
  it('3 neighbors, known coords -> known order', () => {
    // y-up Cartesian: visual clockwise == descending atan2.
    expect(
      clockwiseNeighborOrderFromCoords(0, [1, 2, 3], coordsSame, false),
    ).toEqual([3, 1, 2]);
  });

  it('CALIBRATION_INVERT reverses the order', () => {
    expect(
      clockwiseNeighborOrderFromCoords(0, [1, 2, 3], coordsSame, true),
    ).toEqual([2, 1, 3]);
  });
});

describe('invertFacing', () => {
  it('toward <-> away', () => {
    expect(invertFacing('toward')).toBe('away');
    expect(invertFacing('away')).toBe('toward');
  });
});

describe('compileWedge', () => {
  it('same parity + toward -> solid', () => {
    const out = compileWedge(
      implicitHEntry({ facing: 'toward' }),
      coordsSame,
      false,
    );
    expect(out.wedge).toBe('solid');
    expect(out.center).toBe(0);
    expect(out.outOfPlaneNeighbor).toBe(3);
  });

  it('same parity + away -> hashed', () => {
    const out = compileWedge(
      implicitHEntry({ facing: 'away' }),
      coordsSame,
      false,
    );
    expect(out.wedge).toBe('hashed');
  });

  it('opposite parity + toward -> hashed', () => {
    const out = compileWedge(
      implicitHEntry({ facing: 'toward' }),
      coordsOpposite,
      false,
    );
    expect(out.wedge).toBe('hashed');
  });

  it('opposite parity + away -> solid', () => {
    const out = compileWedge(
      implicitHEntry({ facing: 'away' }),
      coordsOpposite,
      false,
    );
    expect(out.wedge).toBe('solid');
  });

  it('CALIBRATION_INVERT flips the compiled wedge', () => {
    // Same inputs as "same parity + toward -> solid", but inverted calibration
    // reverses the Ketcher CW order -> parity opposite -> hashed.
    const out = compileWedge(
      implicitHEntry({ facing: 'toward' }),
      coordsSame,
      true,
    );
    expect(out.wedge).toBe('hashed');
  });

  it('3-neighbor (implicit-H) center compiles with no virtual H', () => {
    // drawnNeighborsCW has length 3; no fourth coordinate is ever required.
    const out = compileWedge(implicitHEntry(), coordsSame, false);
    expect(out).toEqual({ center: 0, outOfPlaneNeighbor: 3, wedge: 'solid' });
  });

  it('4-neighbor (quaternary) center compiles via the 3-neighbour triple', () => {
    const quaternary = implicitHEntry({
      drawnNeighborsCW: [1, 2, 3, 4],
      outOfPlaneNeighbor: 4,
      facing: 'toward',
    });
    const coords: FrozenCoords = {
      0: { x: 0, y: 0 },
      1: { x: 1, y: 0 },
      2: { x: 0, y: 1 },
      3: { x: -1, y: 0 },
      4: { x: 0, y: -1 },
    };
    const out = compileWedge(quaternary, coords, false);
    expect(out.center).toBe(0);
    expect(out.outOfPlaneNeighbor).toBe(4);
    // Ketcher triple [3,2,1] vs source [1,2,3] -> opposite -> toward inverts -> hashed.
    expect(out.wedge).toBe('hashed');
  });

  it('parity "error" / fail-closed throws the Section 9.5 diagnostic', () => {
    // The only reachable fail-closed path for structurally-valid 3-distinct
    // triples is a structural defect (cyclicParity itself cannot return
    // "error" once comparisonTriple has produced 3 distinct ids). Either way
    // compileWedge throws StereoTransferError carrying the §9.5 block.
    let thrown: unknown;
    try {
      compileWedge(
        implicitHEntry({ drawnNeighborsCW: [3, 1, 2, 2, 5] }),
        coordsSame,
        false,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StereoTransferError);
    const diag = (thrown as StereoTransferError).diagnostic;
    expect(diag).toContain('StereoTransferCompiler failure');
    expect(diag).toContain('- center:');
    expect(diag).toContain('- projection: wedge');
    expect(diag).toContain('- drawnNeighborsCW (source):');
    expect(diag).toContain('- ketcher CW order:');
    expect(diag).toContain('- parity:');
    expect(diag).toContain('- reason:');
  });
});

describe('structural checks (validateStereoTransferEntry / compileWedge)', () => {
  it('drawnNeighborsCW length 2 or 5 fails closed', () => {
    expect(
      validateStereoTransferEntry(implicitHEntry({ drawnNeighborsCW: [1, 2] })),
    ).toContainEqual(expect.stringContaining('drawnNeighborsCW length is 2'));
    expect(
      validateStereoTransferEntry(
        implicitHEntry({ drawnNeighborsCW: [1, 2, 3, 4, 5] }),
      ),
    ).toContainEqual(expect.stringContaining('drawnNeighborsCW length is 5'));
    expect(() =>
      compileWedge(
        implicitHEntry({ drawnNeighborsCW: [1, 2] }),
        coordsSame,
        false,
      ),
    ).toThrow(StereoTransferError);
  });

  it('outOfPlaneNeighbor not in drawnNeighborsCW fails closed', () => {
    const issues = validateStereoTransferEntry(
      implicitHEntry({ outOfPlaneNeighbor: 99 }),
    );
    expect(issues).toContainEqual(
      expect.stringContaining('outOfPlaneNeighbor 99 is not in drawnNeighborsCW'),
    );
  });

  it('projection "haworth" without verticalSense fails closed (W2)', () => {
    const issues = validateStereoTransferEntry(
      implicitHEntry({ projection: 'haworth' }),
    );
    expect(issues).toContainEqual(
      expect.stringContaining('projection "haworth" requires verticalSense'),
    );
  });

  it('projection "haworth" with verticalSense passes structural (W2)', () => {
    const issues = validateStereoTransferEntry(
      implicitHEntry({ projection: 'haworth', verticalSense: 'up' }),
    );
    expect(issues).toEqual([]);
  });

  it('projection "fischer" without verticalSense fails closed (W2)', () => {
    const issues = validateStereoTransferEntry(
      implicitHEntry({ projection: 'fischer' }),
    );
    expect(issues).toContainEqual(
      expect.stringContaining('projection "fischer" requires verticalSense'),
    );
  });

  it('missing frozen coords fails closed', () => {
    const issues = validateStereoTransferEntry(implicitHEntry(), {
      frozenCoords: { 0: { x: 0, y: 0 } },
    });
    expect(issues.some((i) => i.includes('missing from the frozen coordinate set'))).toBe(
      true,
    );
  });

  it('drawnNeighborsCW must be exactly the center graph neighbors (check 6)', () => {
    const ok = validateStereoTransferEntry(implicitHEntry(), {
      frozenCoords: coordsSame,
      graphNeighbors: new Set([1, 2, 3]),
    });
    expect(ok).toEqual([]);
    const bad = validateStereoTransferEntry(implicitHEntry(), {
      frozenCoords: coordsSame,
      graphNeighbors: new Set([1, 2, 7]),
    });
    expect(bad.some((i) => i.includes('not exactly the graph neighbors'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W1 — wedgeToImplicitH (ring-junction implicit-H wedge as a parity-transfer
// case). The compiled wedge polarity uses the three real drawn neighbors as
// the comparison triple; the implicit H is the dependent fourth slot exactly
// like a regular 3-neighbor implicit-H center (§3.3).
// ---------------------------------------------------------------------------

function wedgeToImplicitHEntry(
  over: Partial<StereoTransferEntry> = {},
): StereoTransferEntry {
  // The three real heavy neighbors are [3, 1, 2]; the implicit-H is
  // referenced via outOfPlaneNeighbor = 99 (an agent-chosen id that the
  // translator materializes — NOT a member of drawnNeighborsCW).
  return {
    center: 0,
    drawnNeighborsCW: [3, 1, 2],
    outOfPlaneNeighbor: 99,
    facing: 'toward',
    projection: 'wedge',
    confidence: 0.9,
    wedgeToImplicitH: true,
    ...over,
  };
}

describe('wedgeToImplicitH (W1)', () => {
  it('schema accepts wedgeToImplicitH: true with outOfPlaneNeighbor outside drawnNeighborsCW', () => {
    const intent = {
      version: 1,
      atoms: [
        { id: 0, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
      ],
      bonds: [
        { a: 0, b: 1, order: 1, wedge: null, wedge_from: null },
        { a: 0, b: 2, order: 1, wedge: null, wedge_from: null },
        { a: 0, b: 3, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [{ id: 'r1', atoms: [0, 1, 2, 3], kind: 'kekule' as const }],
      counts: { heavy: 4, rings: 1, heteroatoms: {} },
      layoutPolicy: 'ketcher_clean_locked' as const,
      stereoTransfer: [
        {
          center: 0,
          drawnNeighborsCW: [3, 1, 2],
          outOfPlaneNeighbor: 99,
          facing: 'toward' as const,
          projection: 'wedge' as const,
          confidence: 0.9,
          wedgeToImplicitH: true,
        },
      ],
    };
    const parsed = graphIntentSchema.safeParse(intent);
    expect(parsed.success).toBe(true);
  });

  it('structural: rejects wedgeToImplicitH with H id in drawnNeighborsCW', () => {
    const issues = validateStereoTransferEntry(
      wedgeToImplicitHEntry({ drawnNeighborsCW: [3, 1, 99] }),
    );
    expect(
      issues.some((i) =>
        i.includes('must NOT be a member of drawnNeighborsCW'),
      ),
    ).toBe(true);
  });

  it('structural: rejects wedgeToImplicitH with drawnNeighborsCW length 4', () => {
    const issues = validateStereoTransferEntry(
      wedgeToImplicitHEntry({ drawnNeighborsCW: [3, 1, 2, 4] }),
    );
    expect(
      issues.some((i) => i.includes('requires drawnNeighborsCW of length 3')),
    ).toBe(true);
  });

  it('coords: only center + 3 real neighbors must be present (H needs no coord)', () => {
    // frozenCoords intentionally lacks any id 99 — must not flag missing.
    const issues = validateStereoTransferEntry(wedgeToImplicitHEntry(), {
      frozenCoords: coordsSame,
    });
    expect(issues).toEqual([]);
  });

  it('compile: same parity + toward -> solid (H is dependent fourth slot)', () => {
    const out = compileWedge(
      wedgeToImplicitHEntry({ facing: 'toward' }),
      coordsSame,
      false,
    );
    expect(out.center).toBe(0);
    expect(out.outOfPlaneNeighbor).toBe(99);
    expect(out.wedge).toBe('solid');
  });

  it('compile: opposite parity + toward -> hashed (H still cancels from comparison)', () => {
    const out = compileWedge(
      wedgeToImplicitHEntry({ facing: 'toward' }),
      coordsOpposite,
      false,
    );
    expect(out.wedge).toBe('hashed');
  });

  it('compile: same parity + away -> hashed', () => {
    const out = compileWedge(
      wedgeToImplicitHEntry({ facing: 'away' }),
      coordsSame,
      false,
    );
    expect(out.wedge).toBe('hashed');
  });

  it('compile: graphNeighbors check passes for the 3 real neighbors only', () => {
    const issues = validateStereoTransferEntry(wedgeToImplicitHEntry(), {
      frozenCoords: coordsSame,
      graphNeighbors: new Set([1, 2, 3]),
    });
    expect(issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// W2 — Haworth / Fischer projection adapter. The agent transcribes a single
// pixel bit per stereocenter (verticalSense). The adapter maps it through the
// global HAWORTH_VERTICAL_TOWARD constant to a wedge-projection facing, then
// the standard parity-transfer pipeline runs.
// ---------------------------------------------------------------------------

function haworthEntry(
  over: Partial<StereoTransferEntry> = {},
): StereoTransferEntry {
  // The two in-plane ring neighbors are 1 and 2; the vertical-bond
  // substituent is 3 (outOfPlaneNeighbor). verticalSense = 'up' or 'down'
  // describes whether 3 is drawn above or below the ring line in the image.
  return {
    center: 0,
    drawnNeighborsCW: [3, 1, 2],
    outOfPlaneNeighbor: 3,
    facing: 'toward', // ignored for haworth/fischer — adapter overrides
    projection: 'haworth',
    confidence: 0.9,
    verticalSense: 'up',
    ...over,
  };
}

describe('Haworth/Fischer projection adapter (W2)', () => {
  it('schema accepts projection "haworth" with verticalSense', () => {
    const parsed = graphIntentSchema.safeParse({
      version: 1,
      atoms: [
        { id: 0, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 2, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 3, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
      ],
      bonds: [
        { a: 0, b: 1, order: 1, wedge: null, wedge_from: null },
        { a: 0, b: 2, order: 1, wedge: null, wedge_from: null },
        { a: 0, b: 3, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [{ id: 'r1', atoms: [0, 1, 2], kind: 'kekule' as const }],
      counts: { heavy: 4, rings: 1, heteroatoms: { O: 2 } },
      layoutPolicy: 'ketcher_clean_locked' as const,
      stereoTransfer: [
        {
          center: 0,
          drawnNeighborsCW: [3, 1, 2],
          outOfPlaneNeighbor: 3,
          facing: 'toward' as const,
          projection: 'haworth' as const,
          confidence: 0.9,
          verticalSense: 'up' as const,
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('compile: haworth verticalSense="up" with HAWORTH_VERTICAL_TOWARD=false -> away', () => {
    // With haworthVerticalToward=false, "up" maps to facing=away.
    // Same parity (coordsSame) → ketcherFacing=away → wedge=hashed.
    const out = compileWedge(
      haworthEntry({ verticalSense: 'up' }),
      coordsSame,
      false, // calibrationInvert
      false, // haworthVerticalToward
    );
    expect(out.wedge).toBe('hashed');
  });

  it('compile: haworth verticalSense="down" with HAWORTH_VERTICAL_TOWARD=false -> toward', () => {
    const out = compileWedge(
      haworthEntry({ verticalSense: 'down' }),
      coordsSame,
      false,
      false,
    );
    expect(out.wedge).toBe('solid');
  });

  it('compile: haworth flipping HAWORTH_VERTICAL_TOWARD inverts every wedge', () => {
    const a = compileWedge(haworthEntry({ verticalSense: 'up' }), coordsSame, false, false);
    const b = compileWedge(haworthEntry({ verticalSense: 'up' }), coordsSame, false, true);
    expect(a.wedge).not.toBe(b.wedge);
  });

  it('compile: haworth routes through parity (opposite layout flips the wedge)', () => {
    const same = compileWedge(haworthEntry({ verticalSense: 'up' }), coordsSame, false, false);
    const opp = compileWedge(haworthEntry({ verticalSense: 'up' }), coordsOpposite, false, false);
    expect(same.wedge).not.toBe(opp.wedge);
  });

  it('compile: fischer behaves the same as haworth under the adapter', () => {
    const haw = compileWedge(
      haworthEntry({ projection: 'haworth', verticalSense: 'up' }),
      coordsSame,
      false,
      false,
    );
    const fis = compileWedge(
      haworthEntry({ projection: 'fischer', verticalSense: 'up' }),
      coordsSame,
      false,
      false,
    );
    expect(haw.wedge).toBe(fis.wedge);
  });

  it('compile: missing verticalSense on haworth throws via structural', () => {
    const bad = haworthEntry();
    delete (bad as Partial<StereoTransferEntry>).verticalSense;
    expect(() => compileWedge(bad, coordsSame, false, false)).toThrow(StereoTransferError);
  });

  it('compile: chair projection still rejected (out of scope)', () => {
    // Cast through `as any` because the schema enumeration intentionally does
    // not include "chair"; we want to exercise the structural-issue path that
    // catches an unknown projection at the compiler layer.
    const bad = { ...haworthEntry(), projection: 'chair' } as unknown as StereoTransferEntry;
    expect(() => compileWedge(bad, coordsSame, false, false)).toThrow(StereoTransferError);
  });
});

// --- R/S-direct (handoff-rs-direct §A) schema tests ---------------------

import {
  isStereoLabelEntry,
  isWedgePrimitiveEntry,
  stereoTransferEntrySchema,
} from '../../src/types/graph-intent';

describe('R/S-direct schema — stereoLabelEntry', () => {
  it('accepts a minimal {center, stereo_label: "R"} entry', () => {
    const parsed = stereoTransferEntrySchema.safeParse({ center: 17, stereo_label: 'R' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(isStereoLabelEntry(parsed.data)).toBe(true);
      expect(isWedgePrimitiveEntry(parsed.data)).toBe(false);
    }
  });

  it('accepts stereo_label: "S" and "unknown"', () => {
    expect(stereoTransferEntrySchema.safeParse({ center: 0, stereo_label: 'S' }).success).toBe(true);
    expect(
      stereoTransferEntrySchema.safeParse({ center: 0, stereo_label: 'unknown' }).success,
    ).toBe(true);
  });

  it('rejects invalid stereo_label literals', () => {
    const bad = stereoTransferEntrySchema.safeParse({ center: 0, stereo_label: 'x' });
    expect(bad.success).toBe(false);
  });

  it('rejects stereoLabel entries with extra geometry fields (strict union)', () => {
    const mixed = stereoTransferEntrySchema.safeParse({
      center: 0,
      stereo_label: 'R',
      drawnNeighborsCW: [1, 2, 3],
    });
    expect(mixed.success).toBe(false);
  });

  it('still accepts wedge-primitive entries as the second branch', () => {
    const wp = stereoTransferEntrySchema.safeParse({
      center: 0,
      drawnNeighborsCW: [1, 2, 3],
      outOfPlaneNeighbor: 1,
      facing: 'toward',
      projection: 'wedge',
      confidence: 0.9,
    });
    expect(wp.success).toBe(true);
    if (wp.success) {
      expect(isWedgePrimitiveEntry(wp.data)).toBe(true);
      expect(isStereoLabelEntry(wp.data)).toBe(false);
    }
  });

  it('accepts wedge-primitive entry with optional stereo_unknown: true (Fix 1 skip)', () => {
    const skip = stereoTransferEntrySchema.safeParse({
      center: 5,
      drawnNeighborsCW: [1, 2, 3],
      outOfPlaneNeighbor: 1,
      facing: 'toward',
      projection: 'wedge',
      confidence: 0.0,
      stereo_unknown: true,
    });
    expect(skip.success).toBe(true);
  });
});

describe('R/S-direct schema — full GraphIntent integration', () => {
  it('accepts ketcher_clean_locked with a mix of label and wedge entries', () => {
    const graph = {
      version: 1,
      atoms: [
        { id: 0, element: 'C', drawn_H: 0, charge: 0, radical: 0, ring: null },
        { id: 1, element: 'C', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 2, element: 'C', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 3, element: 'N', drawn_H: 2, charge: 0, radical: 0, ring: null },
        { id: 4, element: 'C', drawn_H: 0, charge: 0, radical: 0, ring: null },
        { id: 5, element: 'O', drawn_H: 0, charge: 0, radical: 0, ring: null },
        { id: 6, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
      ],
      bonds: [
        { a: 0, b: 1, order: 1, wedge: null, wedge_from: null },
        { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
        { a: 1, b: 3, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 4, order: 1, wedge: null, wedge_from: null },
        { a: 4, b: 5, order: 2, wedge: null, wedge_from: null },
        { a: 4, b: 6, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [],
      counts: { heavy: 7, rings: 0, heteroatoms: { N: 1, O: 2 } },
      layoutPolicy: 'ketcher_clean_locked',
      stereoTransfer: [
        { center: 1, stereo_label: 'S' },
        { center: 2, stereo_label: 'unknown' },
      ],
    };
    const parsed = graphIntentSchema.safeParse(graph);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.stereoTransfer).toHaveLength(2);
    }
  });

  it('accepts beyond_protocol stereo_label with beyond_protocol_reason (Stage 5a)', () => {
    const graph = {
      version: 1,
      atoms: [
        { id: 0, element: 'C', drawn_H: 0, charge: 0, radical: 0, ring: null },
        { id: 1, element: 'C', drawn_H: 0, charge: 0, radical: 0, ring: null },
        { id: 2, element: 'C', drawn_H: 0, charge: 0, radical: 0, ring: null },
        { id: 3, element: 'C', drawn_H: 0, charge: 0, radical: 0, ring: null },
      ],
      bonds: [
        { a: 0, b: 1, order: 1, wedge: null, wedge_from: null },
        { a: 1, b: 2, order: 2, wedge: null, wedge_from: null },
        { a: 2, b: 3, order: 2, wedge: null, wedge_from: null },
      ],
      rings: [],
      counts: { heavy: 4, rings: 0, heteroatoms: {} },
      layoutPolicy: 'ketcher_clean_locked',
      stereoTransfer: [
        {
          center: 1,
          stereo_label: 'beyond_protocol',
          beyond_protocol_reason: 'allene',
        },
      ],
    };
    const parsed = graphIntentSchema.safeParse(graph);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.stereoTransfer).toHaveLength(1);
    }
  });

  it('rejects beyond_protocol_reason value outside the enum (Stage 5a)', () => {
    const graph = {
      version: 1,
      atoms: [
        { id: 0, element: 'C', drawn_H: 0, charge: 0, radical: 0, ring: null },
      ],
      bonds: [],
      rings: [],
      counts: { heavy: 1, rings: 0, heteroatoms: {} },
      stereoTransfer: [
        {
          center: 0,
          stereo_label: 'beyond_protocol',
          beyond_protocol_reason: 'made_up_reason',
        },
      ],
    };
    const parsed = graphIntentSchema.safeParse(graph);
    expect(parsed.success).toBe(false);
  });
});
