/**
 * Task 5A — FEATURE-PARITY GATE round-trip proofs (PRESENT features).
 *
 * Each `it()` here proves one worksheet-census feature survives the DIRECT
 * GraphIntent path end-to-end: direct GraphIntent → translateGraphIntent →
 * real Ketcher canvas → exported SMILES. These features are ALREADY in the
 * direct schema (`types/graph-intent.ts`) and honored by the translator; the
 * tests are the parity-gate evidence that collapsing to one shape (Task 5E)
 * does not lose them.
 *
 * The ADDED features (isotope, stereo_group, unsure_regions) have their own
 * dedicated round-trip tests committed alongside the schema/translator change
 * that adds them.
 *
 * Gating: real Playwright runtime → RUN_KETCHER_E2E=1, else the block skips
 * (same posture as the rest of runtime-e2e). The stereo assertions need
 * Ketcher's CIP perception, which is exercised through the standalone
 * Indigo-free path here (wedge + coords → `@`/`@@` marker survives
 * canonicalization); no external Indigo dependency, so no Indigo gate is
 * required for these specific assertions (they assert a stereo marker is
 * present, which Ketcher's own writer emits from the pinned coords).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import type { GraphIntent } from '../../src/types/graph-intent';

const runE2E = process.env.RUN_KETCHER_E2E === '1';
const describeE2E = runE2E ? describe : describe.skip;

describeE2E('Task 5A direct-shape feature parity (round-trip → export)', () => {
  const runtime = new KetcherRuntime();

  beforeAll(async () => {
    await runtime.start();
  }, 180000);

  afterAll(async () => {
    await runtime.stop();
  });

  async function buildAndExport(graph: GraphIntent): Promise<string> {
    await runtime.callBridge('clearCanvas');
    await runtime.applyMutation(
      'build_from_graph',
      { validate_counts: true, layout: 'auto' },
      async () => {
        await translateGraphIntent(runtime, graph, {
          validate_counts: true,
          layout: 'auto',
        });
      },
    );
    return (await runtime.getState(false)).smiles ?? '';
  }

  // ── Feature 1 — wedge primitive (bond.wedge + wedge_from + coords) ──────
  // The direct bond carries wedge='solid'/'hashed' + wedge_from (the chiral
  // center) and the cluster carries pixel coords. The translator's
  // setWedgeBond pass auto-orients the bond so wedge_from is begin, so
  // solid→toward-viewer and the CIP marker survives export. (The `facing`
  // toward/away/wavy/unknown axis is carried by the stereoTransfer wedge
  // entry — Feature 1b below — not by the direct bond, which encodes the
  // same toward/away bit as solid/hashed.)
  it('1 — direct bond wedge (solid + coords) round-trips a chiral marker', async () => {
    const lAlanine: GraphIntent = {
      version: 1,
      label: 'l-alanine',
      atoms: [
        { id: 1, element: 'N', drawn_H: 2, charge: 0, radical: 0, ring: null, x: 0, y: 1, stereo: 'declared' },
        { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 0, y: 0, stereo: 'declared' },
        { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 1, y: 0 },
        { id: 4, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 5, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 6, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: -1, y: 0 },
      ],
      bonds: [
        { a: 1, b: 2, order: 1, wedge: 'solid', wedge_from: 2 },
        { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
        { a: 3, b: 4, order: 2, wedge: null, wedge_from: null },
        { a: 3, b: 5, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 6, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [],
      counts: { heavy: 6, rings: 0, heteroatoms: { N: 1, O: 2 } },
    };
    const smiles = await buildAndExport(lAlanine);
    expect(/@/.test(smiles)).toBe(true);
  }, 120000);

  // ── Feature 1b — stereoTransfer wedge primitive with `facing` ───────────
  // `facing: 'toward'|'away'` IS carried on the direct shape — by the
  // wedgePrimitiveStereoEntry in `stereoTransfer`. Flipping toward↔away must
  // produce a different chiral SMILES, proving the facing axis round-trips on
  // the direct path (no worksheet, no `n*`/`s*` segment ids).
  function chbrclfTransfer(
    facing: 'toward' | 'away' | 'wavy' | 'unknown',
  ): GraphIntent {
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
          drawnNeighborsCW: [5, 4, 3, 1],
          outOfPlaneNeighbor: 5,
          facing,
          projection: 'wedge',
          confidence: 1,
        },
      ],
    };
  }

  it('1b — stereoTransfer wedge `facing` toward↔away flips the chiral SMILES', async () => {
    const toward = await buildAndExport(chbrclfTransfer('toward'));
    const away = await buildAndExport(chbrclfTransfer('away'));
    expect(/\[C@@?H?\]|\[C@@?\]/.test(toward)).toBe(true);
    expect(/\[C@@?H?\]|\[C@@?\]/.test(away)).toBe(true);
    expect(toward).not.toEqual(away);
  }, 120000);

  // ── Feature 1c — `facing: 'wavy' | 'unknown'` maps to stereo_unknown ──────
  // LOCK 22: a wavy / unreadable wedge is an explicit no-stereo declaration.
  // compileWedge only understands toward/away and would otherwise coerce
  // wavy→solid/hashed and fire a BOGUS wedge (Mode C refuses, but only after
  // the wedge already landed). Correct behavior: NO wedge applied, center
  // addressed as an explicit skip → no chiral marker in the export.
  it('1c — stereoTransfer wedge `facing` wavy/unknown applies NO wedge', async () => {
    const wavy = await buildAndExport(chbrclfTransfer('wavy'));
    const unknown = await buildAndExport(chbrclfTransfer('unknown'));
    expect(/@/.test(wavy)).toBe(false);
    expect(/@/.test(unknown)).toBe(false);
  }, 120000);

  // ── Feature 2 — rs_label backend escape (stereoTransfer stereo_label) ───
  // The saddle-junction escape: when wedge orientation is unreadable but the
  // printed R/S is legible, the agent emits a stereoLabelEntry. The direct
  // shape carries it in `stereoTransfer`. The translator's per-center CIP
  // solver picks a wedge configuration producing the target label → exported
  // SMILES carries a defined stereocenter.
  it('2 — rs_label (stereoTransfer stereo_label "S") round-trips a chiral marker', async () => {
    const alanineFlat: GraphIntent = {
      version: 1,
      label: 'alanine-flat-rs-label',
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 2, element: 'C', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 3, element: 'N', drawn_H: 2, charge: 0, radical: 0, ring: null },
        { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 5, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 6, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
      ],
      bonds: [
        { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 4, order: 1, wedge: null, wedge_from: null },
        { a: 4, b: 5, order: 2, wedge: null, wedge_from: null },
        { a: 4, b: 6, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [],
      counts: { heavy: 6, rings: 0, heteroatoms: { N: 1, O: 2 } },
      layoutPolicy: 'ketcher_clean_locked',
      stereoTransfer: [{ center: 2, stereo_label: 'S' }],
    };
    const smiles = await buildAndExport(alanineFlat);
    expect(/@/.test(smiles)).toBe(true);
  }, 120000);

  // ── Feature 3 — charge (atom.charge) round-trips ────────────────────────
  // The direct shape carries the charge VALUE on the atom (charge: -1).
  // The charge_glyph node + attachment[] anchoring is a worksheet-only
  // validation affordance (LOCK-13, validate.ts); the BUILD only needs the
  // numeric charge, which the translator applies via setAtomCharge.
  it('3 — atom charge round-trips (sodium acetate → [Na+] + carboxylate)', async () => {
    const sodiumAcetate: GraphIntent = {
      version: 1,
      atoms: [
        { id: 1, element: 'Na', drawn_H: 0, charge: 1, radical: 0, ring: null },
        { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 4, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 5, element: 'O', drawn_H: 0, charge: -1, radical: 0, ring: null },
      ],
      bonds: [
        { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
        { a: 3, b: 4, order: 2, wedge: null, wedge_from: null },
        { a: 3, b: 5, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [],
      counts: { heavy: 5, rings: 0, heteroatoms: { Na: 1, O: 2 } },
    };
    const smiles = await buildAndExport(sodiumAcetate);
    expect(smiles).toMatch(/\[Na\+\]/);
    expect(smiles).toMatch(/\[O-\]|\[O\-\]/);
  }, 120000);

  // ── Feature 3b — multi-charge cation (charge range parity) ──────────────
  // The worksheet node carries charge -4..+4 ("Mg2+ now legal"); the direct
  // atom carries the same range. A +2 cation salt proves the full charge
  // range round-trips on the direct path. (The worksheet's charge_glyph node
  // + attachment[] anchoring is a transcription-fidelity VALIDATION affordance
  // — there is no separable glyph node on the direct shape to mis-anchor, so
  // the numeric atom.charge IS the anchor and the anchoring check has no
  // expressiveness analogue to port. See report.)
  it('3b — multi-charge cation round-trips (MgCl2 → [Mg+2] . [Cl-] . [Cl-])', async () => {
    const mgCl2: GraphIntent = {
      version: 1,
      label: 'MgCl2',
      atoms: [
        { id: 1, element: 'Mg', drawn_H: 0, charge: 2, radical: 0, ring: null },
        { id: 2, element: 'Cl', drawn_H: 0, charge: -1, radical: 0, ring: null },
        { id: 3, element: 'Cl', drawn_H: 0, charge: -1, radical: 0, ring: null },
      ],
      bonds: [],
      rings: [],
      counts: { heavy: 3, rings: 0, heteroatoms: { Mg: 1, halogens: 2 }, components: 3 },
    };
    const smiles = await buildAndExport(mgCl2);
    expect(smiles).toMatch(/\[Mg\+2\]/);
    expect((smiles.match(/\[Cl-\]/g) ?? []).length).toBe(2);
  }, 120000);

  // ── Feature 4c — drawn_H round-trips ────────────────────────────────────
  // Explicit drawn-H count on a heteroatom must survive. Pyrrole's ring N
  // carries one drawn H (N-H); the exported aromatic SMILES has `[nH]`.
  it('4c — drawn_H round-trips (pyrrole ring N-H → [nH])', async () => {
    const pyrrole: GraphIntent = {
      version: 1,
      label: 'pyrrole',
      atoms: [
        { id: 1, element: 'N', drawn_H: 1, charge: 0, radical: 0, ring: 'r1' },
        { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 5, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
      ],
      bonds: [
        { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 3, order: 2, wedge: null, wedge_from: null },
        { a: 3, b: 4, order: 1, wedge: null, wedge_from: null },
        { a: 4, b: 5, order: 2, wedge: null, wedge_from: null },
        { a: 5, b: 1, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [{ id: 'r1', atoms: [1, 2, 3, 4, 5], kind: 'kekule' }],
      counts: { heavy: 5, rings: 1, heteroatoms: { N: 1 } },
    };
    const smiles = await buildAndExport(pyrrole);
    expect(/\[nH\]/i.test(smiles)).toBe(true);
  }, 120000);

  // ── Feature 5 — E/Z (bond.geom + coords) round-trips ────────────────────
  // The direct bond carries geom: 'cis'|'trans'; the translator pins the
  // agent coords so Indigo/Ketcher perceives the matching E/Z at export
  // time, emitting `/` or `\` slashes. (geom_refs is a worksheet-only
  // disambiguation field — see report; coords + geom suffice on the direct
  // path.) The build-time ez-verify (ez-verify.ts) ADVISORY-checks the
  // declared label against perception; it never rewrites or blocks.
  it('5 — bond.geom "cis" + coords round-trips an E/Z slash', async () => {
    const cisStilbene: GraphIntent = {
      version: 1,
      label: 'cis-stilbene',
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 0, y: 0 },
        { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 1, y: 0 },
        { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', x: -1, y: 1 },
        { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 5, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 6, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 7, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 8, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 9, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r2', x: 2, y: 1 },
        { id: 10, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r2' },
        { id: 11, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r2' },
        { id: 12, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r2' },
        { id: 13, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r2' },
        { id: 14, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r2' },
      ],
      bonds: [
        { a: 1, b: 2, order: 2, wedge: null, wedge_from: null, geom: 'cis' },
        { a: 1, b: 3, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 9, order: 1, wedge: null, wedge_from: null },
        { a: 3, b: 4, order: 2, wedge: null, wedge_from: null },
        { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
        { a: 5, b: 6, order: 2, wedge: null, wedge_from: null },
        { a: 6, b: 7, order: 1, wedge: null, wedge_from: null },
        { a: 7, b: 8, order: 2, wedge: null, wedge_from: null },
        { a: 8, b: 3, order: 1, wedge: null, wedge_from: null },
        { a: 9, b: 10, order: 2, wedge: null, wedge_from: null },
        { a: 10, b: 11, order: 1, wedge: null, wedge_from: null },
        { a: 11, b: 12, order: 2, wedge: null, wedge_from: null },
        { a: 12, b: 13, order: 1, wedge: null, wedge_from: null },
        { a: 13, b: 14, order: 2, wedge: null, wedge_from: null },
        { a: 14, b: 9, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [
        { id: 'r1', atoms: [3, 4, 5, 6, 7, 8], kind: 'kekule' },
        { id: 'r2', atoms: [9, 10, 11, 12, 13, 14], kind: 'kekule' },
      ],
      counts: { heavy: 14, rings: 2, heteroatoms: {} },
    };
    const smiles = await buildAndExport(cisStilbene);
    expect(/[/\\]/.test(smiles)).toBe(true);
  }, 120000);
});
