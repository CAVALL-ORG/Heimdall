import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import type { GraphIntent } from '../../src/types/graph-intent';

const runE2E = process.env.RUN_KETCHER_E2E === '1';
const describeE2E = runE2E ? describe : describe.skip;

function caffeine(): GraphIntent {
  return {
    version: 1,
    atoms: [
      { id: 1, element: 'N', drawn_H: 0, charge: 0, radical: 0, ring: 'r1' },
      { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
      { id: 3, element: 'N', drawn_H: 0, charge: 0, radical: 0, ring: 'r1' },
      { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
      { id: 5, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
      { id: 6, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
      { id: 7, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 8, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 9, element: 'N', drawn_H: 0, charge: 0, radical: 0, ring: 'r2' },
      { id: 10, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r2' },
      { id: 11, element: 'N', drawn_H: null, charge: 0, radical: 0, ring: 'r2' },
      { id: 12, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
      { id: 13, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
      { id: 14, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
    ],
    bonds: [
      { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 7, order: 2, wedge: null, wedge_from: null },
      { a: 3, b: 4, order: 1, wedge: null, wedge_from: null },
      { a: 4, b: 8, order: 2, wedge: null, wedge_from: null },
      { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
      { a: 5, b: 6, order: 2, wedge: null, wedge_from: null },
      { a: 6, b: 1, order: 1, wedge: null, wedge_from: null },
      { a: 5, b: 9, order: 1, wedge: null, wedge_from: null },
      { a: 9, b: 10, order: 1, wedge: null, wedge_from: null },
      { a: 10, b: 11, order: 2, wedge: null, wedge_from: null },
      { a: 11, b: 6, order: 1, wedge: null, wedge_from: null },
      { a: 1, b: 13, order: 1, wedge: null, wedge_from: null },
      { a: 3, b: 14, order: 1, wedge: null, wedge_from: null },
      { a: 9, b: 12, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [
      // r1 is pyrimidine-2,4-dione — genuinely non-aromatic (two ring carbonyls
      // break aromaticity). 'kekule' keeps N1/N3 as non-aromatic trivalent amide
      // nitrogens that Indigo over-perceives as stereocenters. DO NOT change to
      // 'aromatic': aromatize() would set the ring bonds to order 4, making N1/N3
      // aromatic and invisible to Indigo's check — that silently disables the C2 test.
      { id: 'r1', atoms: [1, 2, 3, 4, 5, 6], kind: 'kekule' },
      { id: 'r2', atoms: [5, 9, 10, 11, 6], kind: 'aromatic' },
    ],
    counts: { heavy: 14, rings: 2, heteroatoms: { N: 4, O: 2 } },
  } as GraphIntent;
}

function flatGlucoseAllUnknown(): GraphIntent {
  return {
    version: 1,
    atoms: [
      { id: 0, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
      { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', stereo_unknown: true },
      { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', stereo_unknown: true },
      { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', stereo_unknown: true },
      { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', stereo_unknown: true },
      { id: 5, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', stereo_unknown: true },
      { id: 6, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
      { id: 7, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
      { id: 8, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
      { id: 9, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
      { id: 10, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 11, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
    ],
    bonds: [
      { a: 0, b: 1, order: 1, wedge: null, wedge_from: null },
      { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 3, b: 4, order: 1, wedge: null, wedge_from: null },
      { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
      { a: 5, b: 0, order: 1, wedge: null, wedge_from: null },
      { a: 1, b: 6, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 7, order: 1, wedge: null, wedge_from: null },
      { a: 3, b: 8, order: 1, wedge: null, wedge_from: null },
      { a: 4, b: 9, order: 1, wedge: null, wedge_from: null },
      { a: 5, b: 10, order: 1, wedge: null, wedge_from: null },
      { a: 10, b: 11, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [{ id: 'r1', atoms: [0, 1, 2, 3, 4, 5], kind: 'aliphatic' }],
    counts: { heavy: 12, rings: 1, heteroatoms: { O: 6 } },
  } as GraphIntent;
}

function methylTriphosphate(): GraphIntent {
  // CH3-O-Pα(=O)(O⁻)-O-Pβ(=O)(O⁻)-O-Pγ(=O)(O⁻)(OH) — the faithful ATP
  // triphosphate tail, drawn flat with no stereo marks. Indigo over-perceives
  // the asymmetric Pα/Pβ as undefined stereocenters; a flat drawing with no wedge
  // on them is correct, so the build must commit (non-carbon = not an obligation).
  return {
    version: 1,
    atoms: [
      { id: 0, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
      { id: 1, element: 'O', drawn_H: 0, charge: 0, radical: 0, ring: null },
      { id: 2, element: 'P', drawn_H: 0, charge: 0, radical: 0, ring: null },
      { id: 3, element: 'O', drawn_H: 0, charge: 0, radical: 0, ring: null },
      { id: 4, element: 'O', drawn_H: 0, charge: -1, radical: 0, ring: null },
      { id: 5, element: 'O', drawn_H: 0, charge: 0, radical: 0, ring: null },
      { id: 6, element: 'P', drawn_H: 0, charge: 0, radical: 0, ring: null },
      { id: 7, element: 'O', drawn_H: 0, charge: 0, radical: 0, ring: null },
      { id: 8, element: 'O', drawn_H: 0, charge: -1, radical: 0, ring: null },
      { id: 9, element: 'O', drawn_H: 0, charge: 0, radical: 0, ring: null },
      { id: 10, element: 'P', drawn_H: 0, charge: 0, radical: 0, ring: null },
      { id: 11, element: 'O', drawn_H: 0, charge: 0, radical: 0, ring: null },
      { id: 12, element: 'O', drawn_H: 0, charge: -1, radical: 0, ring: null },
      { id: 13, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
    ],
    bonds: [
      { a: 0, b: 1, order: 1, wedge: null, wedge_from: null },
      { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 2, wedge: null, wedge_from: null },
      { a: 2, b: 4, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 5, order: 1, wedge: null, wedge_from: null },
      { a: 5, b: 6, order: 1, wedge: null, wedge_from: null },
      { a: 6, b: 7, order: 2, wedge: null, wedge_from: null },
      { a: 6, b: 8, order: 1, wedge: null, wedge_from: null },
      { a: 6, b: 9, order: 1, wedge: null, wedge_from: null },
      { a: 9, b: 10, order: 1, wedge: null, wedge_from: null },
      { a: 10, b: 11, order: 2, wedge: null, wedge_from: null },
      { a: 10, b: 12, order: 1, wedge: null, wedge_from: null },
      { a: 10, b: 13, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 14, rings: 0, heteroatoms: { O: 10, P: 3 } },
  } as GraphIntent;
}

function flatBromochlorofluoromethane(): GraphIntent {
  // CHFClBr — one tetrahedral carbon, 4 distinct substituents, drawn flat with no
  // wedge and NOT marked stereo_unknown. Carbon IS an obligation, so the build
  // must THROW the unaccounted gate (proves carbon demand was not disabled).
  return {
    version: 1,
    atoms: [
      { id: 0, element: 'C', drawn_H: 1, charge: 0, radical: 0, ring: null },
      { id: 1, element: 'F', drawn_H: 0, charge: 0, radical: 0, ring: null },
      { id: 2, element: 'Cl', drawn_H: 0, charge: 0, radical: 0, ring: null },
      { id: 3, element: 'Br', drawn_H: 0, charge: 0, radical: 0, ring: null },
    ],
    bonds: [
      { a: 0, b: 1, order: 1, wedge: null, wedge_from: null },
      { a: 0, b: 2, order: 1, wedge: null, wedge_from: null },
      { a: 0, b: 3, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 4, rings: 0, heteroatoms: { halogens: 3 } },
  } as GraphIntent;
}

function underValentCarbon(): GraphIntent {
  return {
    version: 1,
    atoms: [
      { id: 0, element: 'C', drawn_H: 0, charge: 0, radical: 0, ring: null },
      { id: 1, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
      { id: 2, element: 'C', drawn_H: 3, charge: 0, radical: 0, ring: null },
    ],
    bonds: [
      { a: 0, b: 1, order: 1, wedge: null, wedge_from: null },
      { a: 0, b: 2, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [],
    counts: { heavy: 3, rings: 0, heteroatoms: {} },
  } as GraphIntent;
}

describeE2E('stereo gate — carbon-obligation gate + mass-skip (C3)', () => {
  const runtime = new KetcherRuntime();
  beforeAll(async () => { await runtime.start(); }, 180000);
  afterAll(async () => { await runtime.stop(); });

  it('caffeine (flat, planar amide N) builds first try, no STEREO_TRANSFER_FAILED', async () => {
    await runtime.callBridge('clearCanvas');
    await runtime.applyMutation('build_from_graph', { validate_counts: true }, async () => {
      await translateGraphIntent(runtime, caffeine(), { validate_counts: true, layout: 'auto' });
    });
    const smiles = await runtime.exportSmiles();
    expect(smiles).toBeTruthy();
    const st = (await runtime.getState(false)) as { atoms: Array<{ label: string }> };
    expect(st.atoms.filter((a) => a.label === 'N').length).toBe(4);
  }, 60000);

  it('faithful methyl triphosphate (flat, phosphate P) commits — non-carbon is not an obligation', async () => {
    await runtime.callBridge('clearCanvas');
    await runtime.applyMutation('build_from_graph', { validate_counts: true }, async () => {
      await translateGraphIntent(runtime, methylTriphosphate(), { validate_counts: true, layout: 'auto' });
    });
    const smiles = await runtime.exportSmiles();
    expect(smiles).toBeTruthy();
    expect(smiles).toMatch(/P/);
    const st = (await runtime.getState(false)) as { atoms: Array<{ label: string }> };
    expect(st.atoms.filter((a) => a.label === 'P').length).toBe(3);
  }, 60000);

  it('a flat carbon stereocenter (no wedge, not skipped) is still demanded (carbon obligation intact)', async () => {
    await runtime.callBridge('clearCanvas');
    await expect(
      runtime.applyMutation('build_from_graph', { validate_counts: true }, async () => {
        await translateGraphIntent(runtime, flatBromochlorofluoromethane(), { validate_counts: true, layout: 'auto' });
      }),
    ).rejects.toThrow(/stereo_transfer_failed|undefined stereo/i);
  }, 60000);

  it('a flat all-stereo_unknown build (>=5 centers) is rejected (mass-skip gate)', async () => {
    await runtime.callBridge('clearCanvas');
    await expect(
      runtime.applyMutation('build_from_graph', { validate_counts: true }, async () => {
        await translateGraphIntent(runtime, flatGlucoseAllUnknown(), { validate_counts: true, layout: 'auto' });
      }),
    ).rejects.toThrow(/mass_skip_gate|mass-skip/i);
  }, 60000);

  it('a built under-valent carbon (no charge/radical) is rejected (valence gate)', async () => {
    await runtime.callBridge('clearCanvas');
    await expect(
      runtime.applyMutation('build_from_graph', { validate_counts: true }, async () => {
        await translateGraphIntent(runtime, underValentCarbon(), { validate_counts: true, layout: 'auto' });
      }),
    ).rejects.toThrow(/under_valent|valence/i);
  }, 60000);
});
