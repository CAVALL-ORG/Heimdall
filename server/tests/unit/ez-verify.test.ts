/**
 * Build-time E/Z verification of declared `bond.geom` double bonds.
 *
 * Two layers, mirroring mode-c-cip-selective-reapply.test.ts:
 *
 *   1. PURE helpers (no Indigo, no Chromium): `parseEZDescriptors` parses
 *      Indigo's two-atom INDIGO_CIP_DESC bond records into an edge→E/Z map;
 *      `verifyDeclaredGeom` compares declared cis/trans against that map and
 *      emits advisory mismatch diagnostics. Fixed-string V3000 fixtures
 *      captured from indigo-service v1.43 on 2-butene.
 *
 *   2. Indigo-gated e2e (RUN_KETCHER_E2E=1 + Indigo reachable): drives a real
 *      2-butene GraphIntent with a declared-`geom` double bond at known 2-D
 *      coordinates through `translateGraphIntent` and asserts the build
 *      result's E/Z verification surface. One case where the DRAWN geometry
 *      MATCHES the declared label (cis coords + declared cis → no diagnostic)
 *      and one where the drawn geometry is INVERTED relative to the same label
 *      (trans coords + declared cis → mismatch diagnostic).
 *
 * Gating (skip-closed, never false-green): when Indigo is down the perception
 * call throws, the translator emits NO diagnostic, so the e2e assertions would
 * be vacuous. ctx.skip() emits a genuine SKIP rather than risk a false green —
 * same posture as the Mode C layout-locked block.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  expectedEZForDeclared,
  parseEZDescriptors,
  verifyDeclaredGeom,
  type PerceivedEZ,
} from '../../src/adapter/graph-intent/ez-verify';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import {
  RUN_STEREO_E2E,
  STEREO_GATE_REMOTE_BASE,
  startStereoGate,
  type StereoGate,
} from '../fixtures/stereo-e2e-gate';
import type { GraphIntent } from '../../src/types/graph-intent';

// --- Pure helpers ---------------------------------------------------------

// Captured verbatim from indigo-service v1.43 `indigo/convert`
// (molfile-saving-add-stereo-desc=1) on trans-2-butene. The bond descriptor
// names 2 atoms (the double bond C2=C3) with FIELDDATA "(E)".
const TRANS_V3000_DESC =
  'M  V30 1 DAT 1 ATOMS=(2 2 3) FIELDNAME=INDIGO_CIP_DESC ' +
  'FIELDDISP="    0.0000    0.0000    DR    ALL  1       1  " FIELDDATA="(E)"';

// cis-2-butene → "(Z)".
const CIS_V3000_DESC =
  'M  V30 1 DAT 1 ATOMS=(2 2 3) FIELDNAME=INDIGO_CIP_DESC ' +
  'FIELDDISP="    0.0000    0.0000    DR    ALL  1       1  " FIELDDATA="(Z)"';

// A single-atom tetrahedral CIP record — parseEZDescriptors MUST ignore it
// (that is parseCIPSGroups' job).
const TETRA_V3000_DESC =
  'M  V30 2 DAT 1 ATOMS=(1 4) FIELDNAME=INDIGO_CIP_DESC ' +
  'FIELDDISP="    0.0000    0.0000    DR    ALL  1       1  " FIELDDATA="(R)"';

describe('parseEZDescriptors', () => {
  it('parses a trans (E) two-atom bond descriptor keyed by sorted edge', () => {
    const m = parseEZDescriptors(TRANS_V3000_DESC);
    expect([...m.entries()]).toEqual([['2-3', 'E']]);
  });

  it('parses a cis (Z) two-atom bond descriptor', () => {
    const m = parseEZDescriptors(CIS_V3000_DESC);
    expect(m.get('2-3')).toBe('Z');
  });

  it('ignores single-atom tetrahedral (R/S) CIP records', () => {
    const m = parseEZDescriptors(TETRA_V3000_DESC);
    expect(m.size).toBe(0);
  });

  it('keys edges order-independently (edgeKey sorts)', () => {
    // Same descriptor with atoms listed high-then-low still keys "2-3".
    const swapped = TRANS_V3000_DESC.replace('ATOMS=(2 2 3)', 'ATOMS=(2 3 2)');
    const m = parseEZDescriptors(swapped);
    expect(m.get('2-3')).toBe('E');
  });

  it('returns empty for a molfile with no stereo descriptors', () => {
    expect(parseEZDescriptors('M  V30 BEGIN BOND\nM  V30 END BOND').size).toBe(0);
  });
});

describe('expectedEZForDeclared', () => {
  it('maps cis → Z and trans → E', () => {
    expect(expectedEZForDeclared('cis')).toBe('Z');
    expect(expectedEZForDeclared('trans')).toBe('E');
  });
});

// Minimal 2-butene GraphIntent skeleton for the pure verifyDeclaredGeom tests.
// Coordinates are irrelevant here — verifyDeclaredGeom consumes a
// caller-supplied perceived map, not the canvas — so we omit them.
function buteneGraph(declared: 'cis' | 'trans'): GraphIntent {
  return {
    version: 1,
    label: 'butene',
    atoms: [1, 2, 3, 4].map((id) => ({
      id,
      element: 'C' as const,
      drawn_H: null,
      charge: 0,
      radical: 0 as const,
      ring: null,
    })),
    bonds: [
      { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 2, wedge: null, wedge_from: null, geom: declared },
      { a: 3, b: 4, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 4, rings: 0, heteroatoms: {} },
  };
}

describe('verifyDeclaredGeom (pure comparison)', () => {
  // GraphIntent ids 2,3 → canvas ids 1,2 → molfile 1-based 2,3 (the live
  // mapping observed end-to-end). Reproduce that chain here.
  const atomIdMap: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 3 };
  const canvasIdToMolfile1Based = new Map<number, number>([
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
  ]);

  it('emits NO diagnostic when perceived E/Z matches the declared label', () => {
    const perceived = new Map<string, PerceivedEZ>([['2-3', 'Z']]);
    const out = verifyDeclaredGeom({
      graph: buteneGraph('cis'),
      atomIdMap,
      canvasIdToMolfile1Based,
      perceivedEZByMolfileEdge: perceived,
    });
    expect(out.diagnostics).toEqual([]);
    expect(out.records).toEqual([
      {
        intentA: 2,
        intentB: 3,
        declared: 'cis',
        expectedEZ: 'Z',
        perceivedEZ: 'Z',
        match: true,
      },
    ]);
  });

  it('emits a mismatch diagnostic when perceived E/Z contradicts the declared label', () => {
    // Declared cis (expects Z) but Indigo perceived E on the built canvas.
    const perceived = new Map<string, PerceivedEZ>([['2-3', 'E']]);
    const out = verifyDeclaredGeom({
      graph: buteneGraph('cis'),
      atomIdMap,
      canvasIdToMolfile1Based,
      perceivedEZByMolfileEdge: perceived,
    });
    expect(out.diagnostics).toEqual([
      {
        bondAtomIds: [2, 3],
        declared: 'cis',
        perceivedEZ: 'E',
        reason:
          'declared cis (expects Z) but built-canvas geometry perceives E',
      },
    ]);
    expect(out.records[0].match).toBe(false);
  });

  it('skip-closed: no diagnostic when Indigo described no E/Z for the bond', () => {
    const out = verifyDeclaredGeom({
      graph: buteneGraph('trans'),
      atomIdMap,
      canvasIdToMolfile1Based,
      perceivedEZByMolfileEdge: new Map(), // empty perception
    });
    expect(out.diagnostics).toEqual([]);
    expect(out.records[0].perceivedEZ).toBeNull();
    expect(out.records[0].match).toBe(false);
  });

  it('ignores bonds with no declared geom', () => {
    const plain: GraphIntent = {
      ...buteneGraph('cis'),
      bonds: buteneGraph('cis').bonds.map((b) =>
        b.a === 2 && b.b === 3 ? { ...b, geom: null } : b,
      ),
    };
    const out = verifyDeclaredGeom({
      graph: plain,
      atomIdMap,
      canvasIdToMolfile1Based,
      perceivedEZByMolfileEdge: new Map([['2-3', 'E']]),
    });
    expect(out.records).toEqual([]);
    expect(out.diagnostics).toEqual([]);
  });
});

// --- Indigo-gated e2e integration -----------------------------------------
//
// Gating (skip-closed) via the shared `startStereoGate` helper: requires
// RUN_KETCHER_E2E=1 AND Indigo reachable AND the runtime started in REMOTE
// mode (Task 6C — standalone silently no-ops perception). See
// tests/fixtures/stereo-e2e-gate.ts for the full rationale.

const REMOTE_BASE = STEREO_GATE_REMOTE_BASE;

/**
 * 2-butene, C1-C2=C3-C4, declared geom on the C2=C3 double bond. V4 mandates
 * coords on both endpoints AND their non-H neighbors, so every atom is
 * coord-pinned. The translator preserves image-y (no flip), so:
 *   - `coordsKind: 'trans'` puts the two methyls on OPPOSITE sides of the
 *     C2=C3 axis → Indigo perceives E (verified end-to-end → `C/C=C/C`).
 *   - `coordsKind: 'cis'` puts them on the SAME side → Indigo perceives Z
 *     (`C/C=C\C`).
 * `declared` is what the agent wrote on the bond, independent of the coords.
 */
function butene(
  coordsKind: 'cis' | 'trans',
  declared: 'cis' | 'trans',
): GraphIntent {
  const c1y = coordsKind === 'trans' ? 1.0 : -1.0; // methyl on C2
  const c4y = -1.0; // methyl on C3 (fixed above the axis)
  return {
    version: 1,
    label: `butene-${coordsKind}-coords-declared-${declared}`,
    atoms: [
      { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: -1.0, y: c1y },
      { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 0.0, y: 0.0 },
      { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 1.0, y: 0.0 },
      { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 2.0, y: c4y },
    ],
    bonds: [
      { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 2, wedge: null, wedge_from: null, geom: declared },
      { a: 3, b: 4, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 4, rings: 0, heteroatoms: {} },
  };
}

const describeE2E = RUN_STEREO_E2E ? describe : describe.skip;

describeE2E('build-time E/Z verification on the real build path (Indigo + remote gated)', () => {
  const runtime = new KetcherRuntime();
  let gate: StereoGate;

  beforeAll(async () => {
    gate = await startStereoGate(runtime, REMOTE_BASE);
  }, 180000);

  afterAll(async () => {
    await gate?.stop();
  });

  it('drawn geometry MATCHES declared label → no mismatch diagnostic', async (ctx) => {
    ctx.skip(!gate.ready, gate.skipReason);

    await runtime.callBridge('clearCanvas');
    // cis coords + declared cis: expectedEZ Z, perceived Z → agree.
    const result = await translateGraphIntent(runtime, butene('cis', 'cis'), {
      validate_counts: true,
      layout: 'preserve',
    });

    const records = result.geomVerification ?? [];
    const rec = records.find((r) => r.intentA === 2 && r.intentB === 3);
    expect(rec).toBeDefined();
    // Forensic comparison (declared vs perceived).
    expect(rec!.declared).toBe('cis');
    expect(rec!.expectedEZ).toBe('Z');
    expect(rec!.perceivedEZ).toBe('Z');
    expect(rec!.match).toBe(true);

    expect(result.geomMismatchDiagnostics ?? []).toEqual([]);

    // Ketcher authors the SMILES; cis coords canonicalize to the Z slashes.
    const smiles = await runtime.exportSmiles();
    expect(smiles).toBe('C/C=C\\C');
  }, 120000);

  it('drawn geometry INVERTED relative to declared label → mismatch diagnostic', async (ctx) => {
    ctx.skip(!gate.ready, gate.skipReason);

    await runtime.callBridge('clearCanvas');
    // trans coords + declared cis: expectedEZ Z, perceived E → contradiction.
    const result = await translateGraphIntent(runtime, butene('trans', 'cis'), {
      validate_counts: true,
      layout: 'preserve',
    });

    const records = result.geomVerification ?? [];
    const rec = records.find((r) => r.intentA === 2 && r.intentB === 3);
    expect(rec).toBeDefined();
    // Forensic comparison (declared vs perceived): cis declared, E perceived.
    expect(rec!.declared).toBe('cis');
    expect(rec!.expectedEZ).toBe('Z');
    expect(rec!.perceivedEZ).toBe('E');
    expect(rec!.match).toBe(false);

    const diags = result.geomMismatchDiagnostics ?? [];
    expect(diags).toHaveLength(1);
    expect(diags[0].bondAtomIds).toEqual([2, 3]);
    expect(diags[0].declared).toBe('cis');
    expect(diags[0].perceivedEZ).toBe('E');

    // ADVISORY only: the build still commits the agent's drawn (trans/E)
    // geometry — Ketcher authors `C/C=C/C`. The diagnostic does NOT rewrite it.
    const smiles = await runtime.exportSmiles();
    expect(smiles).toBe('C/C=C/C');
  }, 120000);
});
