/**
 * Task 5F — shorthand-glyph decomposition round-trips on the DIRECT
 * GraphIntent path. Each case builds a direct GraphIntent whose atoms carry a
 * `shorthand` glyph token (the raw text the agent saw), runs it through
 * `translateGraphIntent` → real Ketcher canvas → exported SMILES, and asserts
 * the expanded heavy-atom group is present. The agent NEVER decomposes; the
 * backend pre-expansion pass (`shorthand-expand.ts`) does, deterministically,
 * before the skeleton build.
 *
 * Gating: real Playwright runtime → RUN_KETCHER_E2E=1, else the block skips
 * (same posture as the rest of runtime-e2e). Assertions are Indigo-free —
 * they inspect Ketcher's own exported SMILES + the post-build canvas atom
 * inventory (heavy-atom composition), which the standalone path produces
 * without the remote Indigo service.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import type { GraphIntent } from '../../src/types/graph-intent';

const runE2E = process.env.RUN_KETCHER_E2E === '1';
const describeE2E = runE2E ? describe : describe.skip;

describeE2E('Task 5F shorthand decomposition (direct path → export)', () => {
  const runtime = new KetcherRuntime();

  beforeAll(async () => {
    await runtime.start();
  }, 180000);

  afterAll(async () => {
    await runtime.stop();
  });

  // Build via translateGraphIntent and return both the exported SMILES and the
  // post-build heavy-atom composition (label → count) so each case can assert
  // the expansion landed on the canvas, independent of canonical-SMILES form.
  async function buildAndInspect(graph: GraphIntent): Promise<{
    smiles: string;
    heavy: Record<string, number>;
    heavyTotal: number;
  }> {
    await runtime.callBridge('clearCanvas');
    await translateGraphIntent(runtime, graph, {
      validate_counts: true,
      layout: 'auto',
    });
    const state = await runtime.getState(false);
    const heavy: Record<string, number> = {};
    for (const a of state.atoms) {
      if (a.label === 'H') continue;
      heavy[a.label] = (heavy[a.label] ?? 0) + 1;
    }
    const heavyTotal = Object.values(heavy).reduce((s, n) => s + n, 0);
    return { smiles: state.smiles ?? '', heavy, heavyTotal };
  }

  // ── OMe on a benzene carbon → anisole ───────────────────────────────────
  // Agent sees 7 nodes (6 ring C + 1 OMe glyph). Backend expands OMe → O+CH3.
  it('OMe glyph on benzene → anisole (7 heavy: 7 C + 1 O)', async () => {
    const graph: GraphIntent = {
      version: 1,
      label: 'anisole-via-OMe',
      atoms: [
        { id: 0, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 5, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 6, element: 'C', shorthand: 'OMe', drawn_H: null, charge: 0, radical: 0, ring: null },
      ],
      bonds: [
        { a: 0, b: 1, order: 2, wedge: null, wedge_from: null },
        { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 3, order: 2, wedge: null, wedge_from: null },
        { a: 3, b: 4, order: 1, wedge: null, wedge_from: null },
        { a: 4, b: 5, order: 2, wedge: null, wedge_from: null },
        { a: 5, b: 0, order: 1, wedge: null, wedge_from: null },
        { a: 0, b: 6, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [{ id: 'r1', atoms: [0, 1, 2, 3, 4, 5], kind: 'kekule' }],
      // Agent declares VISIBLE-node counts: 7 nodes, 1 ring, no explicit hetero.
      counts: { heavy: 7, rings: 1, heteroatoms: {} },
    };
    const { smiles, heavy, heavyTotal } = await buildAndInspect(graph);
    // 6 ring C + 1 methyl C = 7 C; 1 methoxy O.
    expect(heavy.O).toBe(1);
    expect(heavy.C).toBe(7);
    expect(heavyTotal).toBe(8);
    // Methoxy O–CH3 fragment present in the exported SMILES. Ketcher exports
    // anisole as `c1(OC)ccccc1` (aromatic ring with a methoxy branch); assert
    // the methoxy O–C tail (OC or CO) and an aromatic 6-ring of c's, robust to
    // branch placement and ring-closure digit.
    expect(/OC|CO/.test(smiles)).toBe(true);
    const aromaticC = (smiles.match(/c/g) ?? []).length;
    expect(aromaticC).toBe(6);
    // eslint-disable-next-line no-console
    console.log('OMe→anisole SMILES:', smiles);
  }, 120000);

  // ── Ph on a methyl → toluene ────────────────────────────────────────────
  // Agent sees 2 nodes (CH3 + Ph glyph). Backend expands Ph → 6-membered C ring.
  it('Ph glyph on a methyl → toluene (7 C, one ring)', async () => {
    const graph: GraphIntent = {
      version: 1,
      label: 'toluene-via-Ph',
      atoms: [
        { id: 0, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
        { id: 1, element: 'C', shorthand: 'Ph', drawn_H: null, charge: 0, radical: 0, ring: null },
      ],
      bonds: [{ a: 0, b: 1, order: 1, wedge: null, wedge_from: null }],
      rings: [],
      counts: { heavy: 2, rings: 0, heteroatoms: {} },
    };
    const { smiles, heavy, heavyTotal } = await buildAndInspect(graph);
    expect(heavy.C).toBe(7); // 1 methyl + 6 phenyl
    expect(heavy.O ?? 0).toBe(0);
    expect(heavyTotal).toBe(7);
    expect(/c1ccccc1|C1=CC=CC=C1/i.test(smiles)).toBe(true);
    // eslint-disable-next-line no-console
    console.log('Ph→toluene SMILES:', smiles);
  }, 120000);

  // ── Et / iPr / tBu alkyls on a phenol oxygen anchor ─────────────────────
  // A single O anchor carrying an alkyl glyph. Backend expands the glyph; the
  // exported heavy-atom count proves the alkyl chain landed.
  function alkylOnOxygen(label: string, shorthand: string): GraphIntent {
    return {
      version: 1,
      label,
      atoms: [
        // A methyl anchor so the O is not a bare hydroxide; O bridges them.
        { id: 0, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
        { id: 1, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 2, element: 'C', shorthand, drawn_H: null, charge: 0, radical: 0, ring: null },
      ],
      bonds: [
        { a: 0, b: 1, order: 1, wedge: null, wedge_from: null },
        { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
      ],
      // 3 visible nodes: CH3 + O + alkyl glyph; heteroatoms O:1 (explicit).
      counts: { heavy: 3, rings: 0, heteroatoms: { O: 1 } },
      rings: [],
    };
  }

  it('Et glyph → ethyl chain (CH3-O-CH2-CH3: 3 C, 1 O)', async () => {
    const { smiles, heavy, heavyTotal } = await buildAndInspect(
      alkylOnOxygen('ethyl-methyl-ether', 'Et'),
    );
    expect(heavy.C).toBe(3); // anchor CH3 + ethyl (2 C)
    expect(heavy.O).toBe(1);
    expect(heavyTotal).toBe(4);
    // eslint-disable-next-line no-console
    console.log('Et SMILES:', smiles);
  }, 120000);

  it('iPr glyph → isopropyl branch (CH3-O-CH(CH3)2: 4 C, 1 O)', async () => {
    const { smiles, heavy, heavyTotal } = await buildAndInspect(
      alkylOnOxygen('isopropyl-methyl-ether', 'iPr'),
    );
    expect(heavy.C).toBe(4); // anchor CH3 + isopropyl (3 C)
    expect(heavy.O).toBe(1);
    expect(heavyTotal).toBe(5);
    // eslint-disable-next-line no-console
    console.log('iPr SMILES:', smiles);
  }, 120000);

  it('tBu glyph → tert-butyl branch (CH3-O-C(CH3)3: 5 C, 1 O)', async () => {
    const { smiles, heavy, heavyTotal } = await buildAndInspect(
      alkylOnOxygen('tert-butyl-methyl-ether', 'tBu'),
    );
    expect(heavy.C).toBe(5); // anchor CH3 + tert-butyl (4 C)
    expect(heavy.O).toBe(1);
    expect(heavyTotal).toBe(6);
    // eslint-disable-next-line no-console
    console.log('tBu SMILES:', smiles);
  }, 120000);

  // ── ADR-0002 (W2a) — declared shorthand_resolution.expansion ────────────
  // An OFF-table glyph (TBS) the agent resolved-and-documented expands via its
  // declared `expansion` (same path as a table entry), instead of failing the
  // build. Phenol carbon anchor → O → TBS silyl ether. Backend splices the
  // declared SiMe2-tBu group; the exported heavy-atom inventory proves it
  // landed (1 Si + 6 expansion C + anchor CH3 + bridging O).
  it('off-table TBS glyph with a declared expansion splices (Si + 6 C land on the canvas)', async () => {
    const graph: GraphIntent = {
      version: 1,
      label: 'tbs-silyl-ether-via-declared-expansion',
      atoms: [
        // Anchor: a methyl-O so the silyl ether is not a bare fragment.
        { id: 0, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
        { id: 1, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null },
        {
          id: 2,
          element: 'C',
          shorthand: 'TBS',
          drawn_H: null,
          charge: 0,
          radical: 0,
          ring: null,
          shorthand_resolution: {
            source: 'paper_legend',
            legend_ref: 'dict#1',
            expansion: {
              atoms: [
                { element: 'Si' }, // 0 — attachment
                { element: 'C', drawn_H: 3 }, // 1
                { element: 'C', drawn_H: 3 }, // 2
                { element: 'C', drawn_H: 0 }, // 3 — quaternary C
                { element: 'C', drawn_H: 3 }, // 4
                { element: 'C', drawn_H: 3 }, // 5
                { element: 'C', drawn_H: 3 }, // 6
              ],
              bonds: [
                { a: 0, b: 1, order: 1 },
                { a: 0, b: 2, order: 1 },
                { a: 0, b: 3, order: 1 },
                { a: 3, b: 4, order: 1 },
                { a: 3, b: 5, order: 1 },
                { a: 3, b: 6, order: 1 },
              ],
              attachment_atom_offset: 0,
            },
          },
        },
      ],
      bonds: [
        { a: 0, b: 1, order: 1, wedge: null, wedge_from: null },
        { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
      ],
      // 3 visible nodes: CH3 + O + TBS glyph; heteroatoms O:1 (explicit).
      counts: { heavy: 3, rings: 0, heteroatoms: { O: 1 } },
      rings: [],
    };
    const { smiles, heavy, heavyTotal } = await buildAndInspect(graph);
    expect(heavy.Si).toBe(1);
    expect(heavy.O).toBe(1);
    expect(heavy.C).toBe(7); // anchor CH3 + 6 expansion C
    expect(heavyTotal).toBe(9);
    // eslint-disable-next-line no-console
    console.log('TBS declared-expansion SMILES:', smiles);
  }, 120000);

  // ── Unknown shorthand fails closed (build error), does NOT crash ────────
  it('unknown shorthand (Xyz) fails the build with schema_invalid, no crash', async () => {
    const graph: GraphIntent = {
      version: 1,
      label: 'unknown-glyph',
      atoms: [
        { id: 0, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
        { id: 1, element: 'C', shorthand: 'Xyz', drawn_H: null, charge: 0, radical: 0, ring: null },
      ],
      bonds: [{ a: 0, b: 1, order: 1, wedge: null, wedge_from: null }],
      rings: [],
      counts: { heavy: 2, rings: 0, heteroatoms: {} },
    };
    await runtime.callBridge('clearCanvas');
    await expect(
      translateGraphIntent(runtime, graph, { validate_counts: true, layout: 'auto' }),
    ).rejects.toMatchObject({ code: 'schema_invalid' });
  }, 120000);
});
