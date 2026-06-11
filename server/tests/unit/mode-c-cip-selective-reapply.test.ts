/**
 * Mode C poor-man CIP — derive intended R/S from wedge-primitive pixel facts.
 *
 * Covers the pure helper in mode-c-cip.ts (geometry only) AND the
 * layout-locked translator integration: a wedge primitive driven through the
 * real `ketcher_clean_locked` path must perceive a NON-null intended R/S.
 *
 * The integration block guards the vision-path stereo regression: under
 * `ketcher_clean_locked`, stereo-critical atoms carry NO pixel coordinates
 * (assertLayoutLockedValid forbids them — the translator owns the coordinate
 * frame). Mode C must therefore derive intended R/S from the FROZEN
 * post-layout coordinates, not from the coord-banned graph.atoms. Before the
 * fix, Mode C read graph.atoms → `no_coords` → the layout-invariant V2000
 * re-apply was structurally dead on every vision build.
 *
 * Fixtures use CHBrClF (pure helper) / CC(F)(Cl)Br (integration) — four
 * distinct first-shell elements (Br > Cl > F > C/H by atomic number) — so the
 * CIP priority ordering is unambiguous and we can verify R vs S against the
 * standard manual derivation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveIntendedCIPFromWedgePrimitive } from '../../src/adapter/graph-intent/mode-c-cip';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import {
  RUN_STEREO_E2E,
  STEREO_GATE_REMOTE_BASE,
  startStereoGate,
  type StereoGate,
} from '../fixtures/stereo-e2e-gate';
import type {
  GraphIntent,
  IntentAtom,
  WedgePrimitiveStereoEntry,
} from '../../src/types/graph-intent';

const intentAtom = (
  partial: Partial<IntentAtom> & Pick<IntentAtom, 'id' | 'element'>,
): IntentAtom => ({
  id: partial.id,
  element: partial.element,
  drawn_H: partial.drawn_H ?? null,
  charge: partial.charge ?? 0,
  radical: partial.radical ?? 0,
  ring: partial.ring ?? null,
  x: partial.x,
  y: partial.y,
});

function atomMap(atoms: IntentAtom[]): Map<number, IntentAtom> {
  return new Map(atoms.map((a) => [a.id, a]));
}

/**
 * (S)-CHBrClF — synthetic chirality fixture.
 * Image coordinates (LOCK 8: Y-down). Center C at (100, 100).
 *   Br at (200, 100) — right of center (in-plane)
 *   Cl at (100, 200) — below center in image (in-plane)
 *   F  at (0,   100) — left of center (in-plane)
 *   H  at (100, 50)  — above center in image, wedge tip toward viewer (solid)
 * drawnNeighborsCW (image CW from right): [Br, Cl, F, H].
 * CIP priority: Br(35) > Cl(17) > F(9) > H(1).
 * Manual derivation: H ('toward', z>0); view from -Z (H far). After mental
 * 180° flip about vertical: Br appears left, Cl bottom, F right.
 * Br → Cl → F = left → bottom → right = CCW (cross product +) = S.
 */
function chbrclfPositive(): {
  atoms: IntentAtom[];
  entry: WedgePrimitiveStereoEntry;
} {
  const center = 1;
  const br = 2;
  const cl = 3;
  const f = 4;
  const h = 5;
  return {
    atoms: [
      intentAtom({ id: center, element: 'C', x: 100, y: 100 }),
      intentAtom({ id: br, element: 'Br', x: 200, y: 100 }),
      intentAtom({ id: cl, element: 'Cl', x: 100, y: 200 }),
      intentAtom({ id: f, element: 'F', x: 0, y: 100 }),
      intentAtom({ id: h, element: 'H', x: 100, y: 50 }),
    ],
    entry: {
      center,
      drawnNeighborsCW: [br, cl, f, h],
      outOfPlaneNeighbor: h,
      facing: 'toward',
      projection: 'wedge',
      confidence: 1,
    },
  };
}

describe('deriveIntendedCIPFromWedgePrimitive', () => {
  it('CHBrClF with H wedged toward viewer → S', () => {
    const { atoms, entry } = chbrclfPositive();
    const result = deriveIntendedCIPFromWedgePrimitive(entry, atomMap(atoms));
    expect(result).toEqual({ label: 'S' });
  });

  it('inverts to R when wedge flips toward → away (mirror image)', () => {
    const { atoms, entry } = chbrclfPositive();
    const mirror: WedgePrimitiveStereoEntry = { ...entry, facing: 'away' };
    const result = deriveIntendedCIPFromWedgePrimitive(
      mirror,
      atomMap(atoms),
    );
    expect(result).toEqual({ label: 'R' });
  });

  it('inverts under X-axis mirror reflection of the in-plane geometry', () => {
    // Flip every neighbor's x about the center's x (mirror through YZ plane).
    // True spatial mirror image — should invert chirality S → R.
    const { atoms, entry } = chbrclfPositive();
    const center = atoms.find((a) => a.id === entry.center)!;
    const cx = center.x!;
    const mirrored = atoms.map((a) =>
      a.id === entry.center ? a : { ...a, x: 2 * cx - a.x! },
    );
    const result = deriveIntendedCIPFromWedgePrimitive(
      entry,
      atomMap(mirrored),
    );
    expect(result).toEqual({ label: 'R' });
  });

  it('refuses with tie when two first-shell neighbors share atomic number', () => {
    // Carbon-carbon tie: chiral C with one O, two Cs, one H.
    const atoms = [
      intentAtom({ id: 1, element: 'C', x: 100, y: 100 }),
      intentAtom({ id: 2, element: 'O', x: 200, y: 100 }),
      intentAtom({ id: 3, element: 'C', x: 100, y: 200 }),
      intentAtom({ id: 4, element: 'C', x: 0, y: 100 }),
      intentAtom({ id: 5, element: 'H', x: 100, y: 50 }),
    ];
    const entry: WedgePrimitiveStereoEntry = {
      center: 1,
      drawnNeighborsCW: [2, 3, 4, 5],
      outOfPlaneNeighbor: 5,
      facing: 'toward',
      projection: 'wedge',
      confidence: 1,
    };
    const result = deriveIntendedCIPFromWedgePrimitive(entry, atomMap(atoms));
    expect(result).toEqual({ label: null, reason: 'tie' });
  });

  it('refuses with stereo_unknown when entry self-flags', () => {
    const { atoms, entry } = chbrclfPositive();
    const flagged: WedgePrimitiveStereoEntry = {
      ...entry,
      stereo_unknown: true,
    };
    const result = deriveIntendedCIPFromWedgePrimitive(
      flagged,
      atomMap(atoms),
    );
    expect(result).toEqual({ label: null, reason: 'stereo_unknown' });
  });

  it('refuses with incomplete when facing is wavy / unknown', () => {
    const { atoms, entry } = chbrclfPositive();
    for (const facing of ['wavy', 'unknown'] as const) {
      const result = deriveIntendedCIPFromWedgePrimitive(
        { ...entry, facing },
        atomMap(atoms),
      );
      expect(result).toEqual({ label: null, reason: 'incomplete' });
    }
  });

  it('refuses with unsupported_projection on haworth / fischer', () => {
    const { atoms, entry } = chbrclfPositive();
    for (const projection of ['haworth', 'fischer'] as const) {
      const result = deriveIntendedCIPFromWedgePrimitive(
        { ...entry, projection, verticalSense: 'up' },
        atomMap(atoms),
      );
      expect(result).toEqual({
        label: null,
        reason: 'unsupported_projection',
      });
    }
  });

  it('refuses with unsupported_projection when wedgeToImplicitH', () => {
    const { atoms, entry } = chbrclfPositive();
    const result = deriveIntendedCIPFromWedgePrimitive(
      { ...entry, wedgeToImplicitH: true },
      atomMap(atoms),
    );
    expect(result).toEqual({
      label: null,
      reason: 'unsupported_projection',
    });
  });

  it('refuses with no_coords when any required atom is missing x/y', () => {
    const { atoms, entry } = chbrclfPositive();
    const noCoords = atoms.map((a) =>
      a.id === entry.drawnNeighborsCW[1] ? { ...a, x: undefined, y: undefined } : a,
    );
    const result = deriveIntendedCIPFromWedgePrimitive(
      entry,
      atomMap(noCoords),
    );
    expect(result).toEqual({ label: null, reason: 'no_coords' });
  });

  it('refuses with incomplete when only 3 drawn neighbors', () => {
    const { atoms, entry } = chbrclfPositive();
    const short: WedgePrimitiveStereoEntry = {
      ...entry,
      drawnNeighborsCW: entry.drawnNeighborsCW.slice(0, 3),
    };
    const result = deriveIntendedCIPFromWedgePrimitive(short, atomMap(atoms));
    expect(result).toEqual({ label: null, reason: 'incomplete' });
  });

  it('refuses with incomplete on an unknown element symbol', () => {
    const { atoms, entry } = chbrclfPositive();
    const swapped = atoms.map((a) =>
      a.id === entry.drawnNeighborsCW[0] ? { ...a, element: 'Xx' } : a,
    );
    const result = deriveIntendedCIPFromWedgePrimitive(
      entry,
      atomMap(swapped),
    );
    expect(result).toEqual({ label: null, reason: 'incomplete' });
  });

  it('refuses with degenerate_geometry when all neighbors are colinear', () => {
    // All 4 along the x-axis — degenerate tetrahedron (zero signed volume).
    const atoms = [
      intentAtom({ id: 1, element: 'C', x: 0, y: 0 }),
      intentAtom({ id: 2, element: 'Br', x: 100, y: 0 }),
      intentAtom({ id: 3, element: 'Cl', x: 50, y: 0 }),
      intentAtom({ id: 4, element: 'F', x: -50, y: 0 }),
      intentAtom({ id: 5, element: 'H', x: -100, y: 0 }),
    ];
    const entry: WedgePrimitiveStereoEntry = {
      center: 1,
      drawnNeighborsCW: [2, 3, 4, 5],
      outOfPlaneNeighbor: 2,
      facing: 'toward',
      projection: 'wedge',
      confidence: 1,
    };
    const result = deriveIntendedCIPFromWedgePrimitive(entry, atomMap(atoms));
    expect(result).toEqual({
      label: null,
      reason: 'degenerate_geometry',
    });
  });

  it('refuses with incomplete when outOfPlaneNeighbor is not in drawnNeighborsCW', () => {
    const { atoms, entry } = chbrclfPositive();
    const orphan: WedgePrimitiveStereoEntry = {
      ...entry,
      outOfPlaneNeighbor: 999,
    };
    const result = deriveIntendedCIPFromWedgePrimitive(orphan, atomMap(atoms));
    expect(result).toEqual({ label: null, reason: 'incomplete' });
  });
});

// --- Layout-locked translator integration -------------------------------
//
// Drives a wedge primitive through the REAL `ketcher_clean_locked` path and
// asserts Mode C derives a non-null intended R/S. This is the vision-path
// regression: stereo-critical atoms carry no pixel coords under
// ketcher_clean_locked (the translator owns the frame), so Mode C must read
// the FROZEN post-layout coords. Before the coord fix, Mode C read the
// coord-banned graph.atoms → `intendedRS: null`, `skipReason: 'no_coords'`,
// and the layout-invariant V2000 re-apply never fired.
//
// Gating (skip-closed, never false-green) — shared `startStereoGate` helper:
//   - Requires RUN_KETCHER_E2E=1 (real Playwright runtime). Without it the
//     block skips — same posture as the runtime-e2e suite.
//   - Requires BOTH Indigo reachable at KETCHER_REMOTE_API_PATH AND the
//     runtime started in REMOTE mode (Task 6C). Standalone mode silently
//     no-ops Mode C + the silent-achiral guard, so these tests REQUIRE remote
//     mode; the gate skip-closes otherwise rather than risk a false green or a
//     false-RED. Mode C's CIP perception is an Indigo HTTP call — when Indigo
//     is down it no-ops perception and the non-null-R/S assertion would be
//     vacuous. The intended-R/S derivation itself is layout/Indigo-
//     independent, but the full re-apply path the test exercises is not.
//   See tests/fixtures/stereo-e2e-gate.ts for the full rationale.

const REMOTE_BASE = STEREO_GATE_REMOTE_BASE;

// CC(F)(Cl)Br — 2-bromo-2-chloro-2-fluoropropane. Central C (id 2) is a
// quaternary stereocenter with four DISTINCT first-shell elements
// (CH3 carbon=6, F=9, Cl=17, Br=35), so poor-man CIP decides without a
// digraph descent. NO coordinates on any stereo-critical atom — the locked
// path forbids them and assigns its own via ketcher.layout().
function chloroFluoroBromoPropane(): GraphIntent {
  return {
    version: 1,
    label: 'CC(F)(Cl)Br',
    layoutPolicy: 'ketcher_clean_locked',
    atoms: [
      { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 3, element: 'F', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 4, element: 'Cl', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 5, element: 'Br', drawn_H: null, charge: 0, radical: 0, ring: null },
    ],
    bonds: [
      { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 4, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 5, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 5, rings: 0, heteroatoms: { halogens: 3 } },
    stereoTransfer: [
      {
        center: 2,
        // CW visual order of the four drawn neighbors: Br, Cl, F, CH3.
        drawnNeighborsCW: [5, 4, 3, 1],
        outOfPlaneNeighbor: 5, // Br wedged
        facing: 'toward',
        projection: 'wedge',
        confidence: 1,
      },
    ],
  };
}

// Same skeleton, but a wedge transcription whose intended R/S DISAGREES with
// the label Indigo perceives from Ketcher's auto-layout — so the
// layout-invariant V2000 re-apply must fire. With CH3 (id 1) wedged toward
// the viewer in the CW order [Br, Cl, F, CH3], poor-man CIP on the frozen
// coords yields intended=R, while Indigo perceives S on the post-build canvas
// (Ketcher's layout is deterministic for this molecule — verified across
// repeated builds). Mode C detects intended≠perceived and re-applies the
// intended R via the molfile V2000 solver; the exported SMILES is the R form
// `C[C@](Br)(Cl)F`, NOT the layout-artifact S.
function chloroFluoroBromoPropaneReapply(): GraphIntent {
  const base = chloroFluoroBromoPropane();
  return {
    ...base,
    stereoTransfer: [
      {
        center: 2,
        drawnNeighborsCW: [5, 4, 3, 1],
        outOfPlaneNeighbor: 1, // CH3 wedged (forces intended≠perceived)
        facing: 'toward',
        projection: 'wedge',
        confidence: 1,
      },
    ],
  };
}

const describeE2E = RUN_STEREO_E2E ? describe : describe.skip;

describeE2E('Mode C on the layout-locked vision path (Indigo + remote gated)', () => {
  const runtime = new KetcherRuntime();
  let gate: StereoGate;

  beforeAll(async () => {
    // Skip-closed: starts the runtime in REMOTE mode iff Indigo is reachable.
    // gate.ready is true only when BOTH hold (Task 6C).
    gate = await startStereoGate(runtime, REMOTE_BASE);
  }, 180000);

  afterAll(async () => {
    await gate?.stop();
  });

  it('derives a non-null intended R/S from frozen post-layout coords (re-apply fires)', async (ctx) => {
    // Skip-closed: Indigo down OR standalone → Mode C perception/re-apply
    // no-ops → the non-null-R/S assertion would be vacuous. ctx.skip() emits a
    // genuine SKIP (not a silent green), so the row is never false-green.
    ctx.skip(!gate.ready, gate.skipReason);

    await runtime.callBridge('clearCanvas');
    const result = await translateGraphIntent(
      runtime,
      chloroFluoroBromoPropane(),
      { validate_counts: true, layout: 'auto' },
    );

    // One Mode C record for the single stereocenter (intent id 2).
    const records = result.modeC ?? [];
    const center = records.find((r) => r.intentCenter === 2);
    expect(center).toBeDefined();

    // THE FIX: intended R/S is derived from the frozen post-layout coords,
    // so it is a real CIP label — never the pre-fix `no_coords` null.
    expect(center!.skipReason).not.toBe('no_coords');
    expect(center!.intendedRS === 'R' || center!.intendedRS === 'S').toBe(true);

    // Layout-invariant guarantee: when Indigo's perceived label differs from
    // the intended one, the V2000 solver re-applies the intended label; when
    // they already agree, no re-apply is needed. Either way the EXPORTED
    // molecule must carry the agent-intended chirality, not a layout artifact.
    if (center!.perceivedRS && center!.intendedRS !== center!.perceivedRS) {
      expect(center!.reapplied).toBe(true);
    }

    const smiles = await runtime.exportSmiles();
    expect(smiles).toBeTruthy();
    // Ketcher authors the SMILES; CC(F)(Cl)Br with this wedge transcription
    // canonicalizes to a defined stereocenter (a `@`/`@@` token present).
    expect(/\[C@@?H?\]|\[C@@?\]/.test(smiles ?? '')).toBe(true);
  }, 120000);

  it('re-applies the intended label when Indigo perception disagrees (layout-invariant)', async (ctx) => {
    ctx.skip(!gate.ready, gate.skipReason);

    await runtime.callBridge('clearCanvas');
    const result = await translateGraphIntent(
      runtime,
      chloroFluoroBromoPropaneReapply(),
      { validate_counts: true, layout: 'auto' },
    );

    const center = (result.modeC ?? []).find((r) => r.intentCenter === 2);
    expect(center).toBeDefined();

    // Intended R/S derived from frozen coords (the fix); Indigo perceives the
    // opposite from the auto-layout; the V2000 solver re-applies the intent.
    expect(center!.intendedRS).toBe('R');
    expect(center!.perceivedRS).toBe('S');
    expect(center!.reapplied).toBe(true);
    expect(center!.skipReason).toBeNull();

    // Intent wins over the layout artifact: the exported molecule is the R
    // form. (Ketcher authors the SMILES — this string is read back from
    // export_smiles, not hand-written.)
    const smiles = await runtime.exportSmiles();
    expect(smiles).toBe('C[C@](Br)(Cl)F');
  }, 120000);
});
