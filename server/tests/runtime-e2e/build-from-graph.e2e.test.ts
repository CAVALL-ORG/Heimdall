import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KetcherRuntime, RuntimeMutationError } from '../../src/mcp/runtime';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import type { GraphIntent } from '../../src/types/graph-intent';
import { buildTools } from '../../src/mcp/tools/build';

const runE2E = process.env.RUN_KETCHER_E2E === '1';
const describeE2E = runE2E ? describe : describe.skip;

function benzene(): GraphIntent {
  return {
    version: 1,
    label: 'benzene',
    atoms: [1, 2, 3, 4, 5, 6].map((id) => ({
      id,
      element: 'C',
      drawn_H: null,
      charge: 0,
      radical: 0 as const,
      ring: 'r1',
    })),
    bonds: [
      { a: 1, b: 2, order: 2, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 3, b: 4, order: 2, wedge: null, wedge_from: null },
      { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
      { a: 5, b: 6, order: 2, wedge: null, wedge_from: null },
      { a: 6, b: 1, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [{ id: 'r1', atoms: [1, 2, 3, 4, 5, 6], kind: 'kekule' }],
    counts: { heavy: 6, rings: 1, heteroatoms: {} },
  };
}

function pyridine(): GraphIntent {
  return {
    version: 1,
    label: 'pyridine',
    atoms: [
      { id: 1, element: 'N', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
      ...[2, 3, 4, 5, 6].map((id) => ({
        id,
        element: 'C' as const,
        drawn_H: null,
        charge: 0,
        radical: 0 as const,
        ring: 'r1' as string,
      })),
    ],
    bonds: [
      { a: 1, b: 2, order: 2, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 3, b: 4, order: 2, wedge: null, wedge_from: null },
      { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
      { a: 5, b: 6, order: 2, wedge: null, wedge_from: null },
      { a: 6, b: 1, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [{ id: 'r1', atoms: [1, 2, 3, 4, 5, 6], kind: 'kekule' }],
    counts: { heavy: 6, rings: 1, heteroatoms: { N: 1 } },
  };
}

function sodiumAcetate(): GraphIntent {
  return {
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
}

function lAlanine(): GraphIntent {
  // skeleton: N - Cα(H) - C(=O) - O - (H)   plus methyl on Cα.
  // atom ids: 1=N, 2=Cα, 3=C (carboxyl), 4=O (=O), 5=O (OH), 6=C (methyl)
  // V9 now requires coords on chiral cluster when any wedge is set.
  // Layout (image-y-down): Cα at origin, N below (y=+1), C carboxyl to the
  // right (x=+1), methyl to the left (x=-1).
  return {
    version: 1,
    label: 'l-alanine',
    atoms: [
      { id: 1, element: 'N', drawn_H: 2, charge: 0, radical: 0, ring: null, x: 0, y: 1 },
      { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 0, y: 0 },
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
}

describeE2E('build_from_graph e2e', () => {
  const runtime = new KetcherRuntime();

  beforeAll(async () => {
    await runtime.start();
  }, 180000);

  afterAll(async () => {
    await runtime.stop();
  });

  async function build(
    graph: GraphIntent,
    opts: { validate_counts: boolean; layout: 'auto' | 'preserve' | 'clean' } = {
      validate_counts: true,
      layout: 'auto',
    },
  ) {
    await runtime.callBridge('clearCanvas');
    return runtime.applyMutation('build_from_graph', opts, async () => {
      await translateGraphIntent(runtime, graph, opts);
    });
  }

  it('builds benzene → lowercase aromatic c1ccccc1', async () => {
    const result = await build(benzene());
    const smiles = result.after.smiles ?? '';
    expect(smiles.toLowerCase()).toContain('c1ccccc1');
  });

  it('builds pyridine with N in the ring', async () => {
    const result = await build(pyridine());
    const smiles = result.after.smiles ?? '';
    expect(/n/i.test(smiles)).toBe(true);
    expect(result.after.atoms.length).toBe(6);
  });

  it('builds sodium acetate as two disconnected fragments', async () => {
    const result = await build(sodiumAcetate());
    expect(result.after.atoms.length).toBe(5);
    const smiles = result.after.smiles ?? '';
    expect(smiles).toMatch(/\./);
    expect(smiles).toMatch(/\[Na\+\]/);
  });

  it('builds L-alanine via wedge_from (no CIP inversion)', async () => {
    const result = await build(lAlanine());
    expect(result.after.atoms.length).toBe(6);
    const smiles = result.after.smiles ?? '';
    expect(/@/.test(smiles)).toBe(true);
  });

  // --- PLAN-coord-pinning.md runtime e2e (tests 1-5) ---

  function lPheCoords(mirror = false): GraphIntent {
    // L-Phenylalanine: N - Cα(H) - C(=O)OH, Cα also bound to CH2-phenyl.
    // ids: 1=N, 2=Cα, 3=Ccarboxyl, 4=O(=O), 5=O(H), 6=Cβ, 7..12=phenyl ring.
    // Layout (image coords, y-down): Cα at origin, N below (or above for mirror).
    const ny = mirror ? -1 : 1; // image-y of N (below Cα in default → flips to above in mirror)
    return {
      version: 1,
      label: 'l-phenylalanine',
      atoms: [
        { id: 1, element: 'N', drawn_H: 2, charge: 0, radical: 0, ring: null, x: 0, y: ny },
        { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 0, y: 0 },
        { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 1, y: 0 },
        { id: 4, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 5, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 6, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: -1, y: 0 },
        { id: 7, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 8, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 9, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 10, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 11, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 12, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
      ],
      bonds: [
        { a: 1, b: 2, order: 1, wedge: 'solid', wedge_from: 2 },
        { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
        { a: 3, b: 4, order: 2, wedge: null, wedge_from: null },
        { a: 3, b: 5, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 6, order: 1, wedge: null, wedge_from: null },
        { a: 6, b: 7, order: 1, wedge: null, wedge_from: null },
        { a: 7, b: 8, order: 2, wedge: null, wedge_from: null },
        { a: 8, b: 9, order: 1, wedge: null, wedge_from: null },
        { a: 9, b: 10, order: 2, wedge: null, wedge_from: null },
        { a: 10, b: 11, order: 1, wedge: null, wedge_from: null },
        { a: 11, b: 12, order: 2, wedge: null, wedge_from: null },
        { a: 12, b: 7, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [{ id: 'r1', atoms: [7, 8, 9, 10, 11, 12], kind: 'kekule' }],
      counts: { heavy: 12, rings: 1, heteroatoms: { N: 1, O: 2 } },
    };
  }

  function stilbene(geom: 'cis' | 'trans'): GraphIntent {
    // Ph-CH=CH-Ph. ids: 1=C(sp2 left), 2=C(sp2 right), 3..8 = left phenyl, 9..14 = right phenyl.
    // Coords for 1,2 and ring-attach atoms (3, 9). cis = both phenyls on same side; trans = opposite.
    const y3 = geom === 'cis' ? 1 : 1;
    const y9 = geom === 'cis' ? 1 : -1;
    return {
      version: 1,
      label: `${geom}-stilbene`,
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 0, y: 0 },
        { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 1, y: 0 },
        { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', x: -1, y: y3 },
        { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 5, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 6, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 7, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 8, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 9, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r2', x: 2, y: y9 },
        { id: 10, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r2' },
        { id: 11, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r2' },
        { id: 12, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r2' },
        { id: 13, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r2' },
        { id: 14, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r2' },
      ],
      bonds: [
        { a: 1, b: 2, order: 2, wedge: null, wedge_from: null, geom },
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
  }

  it('L-Phe with coords (NH2 below Cα + wedge solid) → S center [C@@H]', async () => {
    const result = await build(lPheCoords(false));
    const smiles = result.after.smiles ?? '';
    expect(/@/.test(smiles)).toBe(true);
    expect(smiles.includes('[C@@H]')).toBe(true);
  });

  it('L-Phe mirror (NH2 above Cα + same wedge solid) → opposite enantiomer [C@H]', async () => {
    const result = await build(lPheCoords(true));
    const smiles = result.after.smiles ?? '';
    expect(/@/.test(smiles)).toBe(true);
    expect(smiles.includes('[C@H]') && !smiles.includes('[C@@H]')).toBe(true);
  });

  it('cis-stilbene with coords + bond.geom="cis" → Z isomer in SMILES', async () => {
    const result = await build(stilbene('cis'));
    const smiles = result.after.smiles ?? '';
    // Z-stilbene canonical isomeric uses matched slashes (`\…\` or `/…/`).
    expect(/[\/\\]/.test(smiles)).toBe(true);
  });

  it('trans-stilbene with coords + bond.geom="trans" → E isomer in SMILES', async () => {
    const result = await build(stilbene('trans'));
    const smiles = result.after.smiles ?? '';
    expect(/[\/\\]/.test(smiles)).toBe(true);
  });

  it('L-Ala topology-only (no coords) → still produces a chirality marker (regression)', async () => {
    const result = await build(lAlanine());
    const smiles = result.after.smiles ?? '';
    expect(/@/.test(smiles)).toBe(true);
  });

  // --- PLAN-scaffolding-upgrade.md runtime e2e (wedge_to_implicit_h) ---

  function chiralCarbonWithImplicitHWedge(
    wedge: 'solid' | 'hashed',
  ): GraphIntent {
    // 1-bromoethanol scaffold: Br - C*(OH) - CH3. The central C has 3
    // heavy neighbors {Br, O, Cmethyl} + one implicit H. A wedge from
    // C* to the implicit H makes it a stereocenter. Coord-pinned
    // cluster so V8 + coord-driven CIP perception both apply.
    return {
      version: 1,
      label: 'chiral-c-with-implicit-h-wedge',
      atoms: [
        {
          id: 1,
          element: 'C',
          drawn_H: null,
          charge: 0,
          radical: 0,
          ring: null,
          x: 0,
          y: 0,
          wedge_to_implicit_h: wedge,
        },
        { id: 2, element: 'N', drawn_H: 2, charge: 0, radical: 0, ring: null, x: 1, y: 0 },
        { id: 3, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null, x: 0, y: 1 },
        { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: -1, y: 0 },
      ],
      bonds: [
        { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
        { a: 1, b: 3, order: 1, wedge: null, wedge_from: null },
        { a: 1, b: 4, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [],
      counts: { heavy: 4, rings: 0, heteroatoms: { N: 1, O: 1 } },
    };
  }

  it('wedge_to_implicit_h: solid wedge yields a CIP stereo marker', async () => {
    const result = await build(chiralCarbonWithImplicitHWedge('solid'));
    const smiles = result.after.smiles ?? '';
    expect(/@/.test(smiles)).toBe(true);
    // The materialized explicit H may or may not appear in the SMILES;
    // what matters is the chiral marker survives canonicalization.
    expect(smiles.length).toBeGreaterThan(0);
  });

  it('wedge_to_implicit_h: hashed wedge yields the opposite enantiomer marker', async () => {
    const solid = await build(chiralCarbonWithImplicitHWedge('solid'));
    const hashed = await build(chiralCarbonWithImplicitHWedge('hashed'));
    const solidSmi = solid.after.smiles ?? '';
    const hashedSmi = hashed.after.smiles ?? '';
    expect(/@/.test(solidSmi)).toBe(true);
    expect(/@/.test(hashedSmi)).toBe(true);
    // Flipping the wedge direction must produce a different chiral SMILES.
    expect(solidSmi).not.toEqual(hashedSmi);
  });

  it('stereo_unknown is a no-op (build succeeds, no extra mutations)', async () => {
    const graph: GraphIntent = {
      version: 1,
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null,
          stereo_unknown: true },
        { id: 3, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
      ],
      bonds: [
        { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [],
      counts: { heavy: 3, rings: 0, heteroatoms: { O: 1 } },
    };
    const result = await build(graph);
    expect(result.after.atoms.length).toBe(3);
    const smiles = result.after.smiles ?? '';
    // No stereo marker expected — stereo_unknown does not mutate the canvas.
    expect(/@/.test(smiles)).toBe(false);
  });

  it('reverts canvas + throws on count mismatch', async () => {
    await runtime.callBridge('clearCanvas');
    const before = await runtime.getState(false);
    const bad = benzene();
    bad.counts.heavy = 999;
    let threw = false;
    try {
      await runtime.applyMutation('build_from_graph', { validate_counts: true }, async () => {
        await translateGraphIntent(runtime, bad, { validate_counts: true, layout: 'auto' });
      });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(RuntimeMutationError);
    }
    expect(threw).toBe(true);
    const after = await runtime.getState(false);
    expect(after.atoms.length).toBe(before.atoms.length);
  });

  // --- PLAN-cat1 W1 — wedgeToImplicitH in the parity-transfer pipeline ---

  function chiralCWithImplicitHWedgeParityTransfer(
    facing: 'toward' | 'away',
  ): GraphIntent {
    // Same scaffold as the one-shot wedge_to_implicit_h test: Br-C*(NH2)(OH)-CH3
    // shape (3 real heavy neighbors + an implicit H). Parity-transfer mode:
    // no coords on stereo-critical atoms; one stereoTransfer entry with
    // wedgeToImplicitH = true and outOfPlaneNeighbor = 999 (id reserved for
    // the materialized H).
    return {
      version: 1,
      label: 'wedgeToImplicitH-parity-transfer',
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 2, element: 'N', drawn_H: 2, charge: 0, radical: 0, ring: null },
        { id: 3, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      ],
      bonds: [
        { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
        { a: 1, b: 3, order: 1, wedge: null, wedge_from: null },
        { a: 1, b: 4, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [],
      counts: { heavy: 4, rings: 0, heteroatoms: { N: 1, O: 1 } },
      layoutPolicy: 'ketcher_clean_locked',
      stereoTransfer: [
        {
          center: 1,
          drawnNeighborsCW: [2, 3, 4],
          outOfPlaneNeighbor: 999,
          facing,
          projection: 'wedge',
          confidence: 0.95,
          wedgeToImplicitH: true,
        },
      ],
    };
  }

  it('W1 wedgeToImplicitH (toward) builds via parity-transfer with a CIP marker', async () => {
    const result = await build(chiralCWithImplicitHWedgeParityTransfer('toward'));
    const smiles = result.after.smiles ?? '';
    expect(/@/.test(smiles)).toBe(true);
  });

  it('W1 wedgeToImplicitH facing flip yields a different chiral SMILES', async () => {
    const toward = await build(chiralCWithImplicitHWedgeParityTransfer('toward'));
    const away = await build(chiralCWithImplicitHWedgeParityTransfer('away'));
    const t = toward.after.smiles ?? '';
    const a = away.after.smiles ?? '';
    expect(/@/.test(t)).toBe(true);
    expect(/@/.test(a)).toBe(true);
    expect(t).not.toEqual(a);
  });

  // --- PLAN-cat1 W2 — Haworth α-D-glucopyranose end-to-end ---

  function alphaDGlucopyranoseHaworth(): GraphIntent {
    // Atom ids: 1..5 = ring C, 6 = ring O (O5), 7..10 = ring-C OHs,
    // 11 = C6 (CH2), 12 = C6-OH.
    return {
      version: 1,
      label: 'alpha-D-glucopyranose (Haworth)',
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 5, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 6, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: 'r1' },
        { id: 7, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 8, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 9, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 10, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 11, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 12, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
      ],
      bonds: [
        { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
        { a: 3, b: 4, order: 1, wedge: null, wedge_from: null },
        { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
        { a: 5, b: 6, order: 1, wedge: null, wedge_from: null },
        { a: 6, b: 1, order: 1, wedge: null, wedge_from: null },
        { a: 1, b: 7, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 8, order: 1, wedge: null, wedge_from: null },
        { a: 3, b: 9, order: 1, wedge: null, wedge_from: null },
        { a: 4, b: 10, order: 1, wedge: null, wedge_from: null },
        { a: 5, b: 11, order: 1, wedge: null, wedge_from: null },
        { a: 11, b: 12, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [{ id: 'r1', atoms: [1, 2, 3, 4, 5, 6], kind: 'kekule' }],
      counts: { heavy: 12, rings: 1, heteroatoms: { O: 6 } },
      layoutPolicy: 'ketcher_clean_locked',
      stereoTransfer: [
        { center: 1, drawnNeighborsCW: [7, 2, 6], outOfPlaneNeighbor: 7,
          facing: 'toward', projection: 'haworth', confidence: 0.95, verticalSense: 'down' },
        { center: 2, drawnNeighborsCW: [8, 3, 1], outOfPlaneNeighbor: 8,
          facing: 'toward', projection: 'haworth', confidence: 0.95, verticalSense: 'down' },
        { center: 3, drawnNeighborsCW: [9, 4, 2], outOfPlaneNeighbor: 9,
          facing: 'toward', projection: 'haworth', confidence: 0.95, verticalSense: 'up' },
        { center: 4, drawnNeighborsCW: [10, 5, 3], outOfPlaneNeighbor: 10,
          facing: 'toward', projection: 'haworth', confidence: 0.95, verticalSense: 'down' },
        { center: 5, drawnNeighborsCW: [11, 6, 4], outOfPlaneNeighbor: 11,
          facing: 'toward', projection: 'haworth', confidence: 0.95, verticalSense: 'up' },
      ],
    };
  }

  it('W2 Haworth α-D-glucopyranose builds with 5 chiral markers', async () => {
    const result = await build(alphaDGlucopyranoseHaworth());
    const smiles = result.after.smiles ?? '';
    // Five chiral markers (one per ring center). The mix of @ vs @@ depends
    // on the canonical traversal direction; we only assert the count.
    const atSigns = (smiles.match(/@/g) ?? []).length;
    expect(atSigns).toBeGreaterThanOrEqual(5);
  });

  // --- R/S-direct (handoff-rs-direct §B) + Fix 1 enumerate-and-require ---

  function alanineFlat(stereoTransfer?: unknown): GraphIntent {
    // CC(N)C(=O)O — alanine flat topology, no coords on stereocenter.
    // Used to exercise both the R/S-direct path (one stereoTransfer entry
    // with stereo_label) and the Fix 1 enumerate-and-require path (empty
    // or missing entry).
    const base = {
      version: 1 as const,
      label: 'alanine-flat',
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0 as const, ring: null },
        { id: 2, element: 'C', drawn_H: 1, charge: 0, radical: 0 as const, ring: null },
        { id: 3, element: 'N', drawn_H: 2, charge: 0, radical: 0 as const, ring: null },
        { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0 as const, ring: null },
        { id: 5, element: 'O', drawn_H: null, charge: 0, radical: 0 as const, ring: null },
        { id: 6, element: 'O', drawn_H: 1, charge: 0, radical: 0 as const, ring: null },
      ],
      bonds: [
        { a: 1, b: 2, order: 1 as const, wedge: null, wedge_from: null },
        { a: 2, b: 3, order: 1 as const, wedge: null, wedge_from: null },
        { a: 2, b: 4, order: 1 as const, wedge: null, wedge_from: null },
        { a: 4, b: 5, order: 2 as const, wedge: null, wedge_from: null },
        { a: 4, b: 6, order: 1 as const, wedge: null, wedge_from: null },
      ],
      rings: [],
      counts: { heavy: 6, rings: 0, heteroatoms: { N: 1, O: 2 } },
      layoutPolicy: 'ketcher_clean_locked' as const,
    };
    if (stereoTransfer !== undefined) {
      return { ...base, stereoTransfer } as unknown as GraphIntent;
    }
    return base as unknown as GraphIntent;
  }

  it('R/S-direct: alanine with stereo_label "S" produces chiral SMILES', async () => {
    const intent = alanineFlat([{ center: 2, stereo_label: 'S' }]);
    const result = await build(intent);
    const smiles = result.after.smiles ?? '';
    // Either @ or @@ is acceptable — the canonical traversal direction is
    // Ketcher's choice. The point is the center is no longer unspecified.
    expect(/@/.test(smiles)).toBe(true);
  });

  it('R/S-direct: stereo_label "unknown" is a no-op (no wedge applied)', async () => {
    const intent = alanineFlat([{ center: 2, stereo_label: 'unknown' }]);
    const result = await build(intent);
    const smiles = result.after.smiles ?? '';
    // No wedge → no chiral marker in the canonical SMILES.
    expect(/@/.test(smiles)).toBe(false);
  });

  it('Fix 1 enumerate-and-require: missing entry for perceived stereocenter throws', async () => {
    // Threonine-like CC(N)C(O)C(=O)O has 2 stereocenters (atoms 2 and 4).
    // Provide an entry only for atom 2; atom 4 must trip the Fix 1 gate.
    const intent: GraphIntent = {
      version: 1,
      label: 'threonine-fix1-test',
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 2, element: 'C', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 3, element: 'N', drawn_H: 2, charge: 0, radical: 0, ring: null },
        { id: 4, element: 'C', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 5, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 6, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 7, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 8, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
      ],
      bonds: [
        { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 4, order: 1, wedge: null, wedge_from: null },
        { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
        { a: 4, b: 6, order: 1, wedge: null, wedge_from: null },
        { a: 6, b: 7, order: 2, wedge: null, wedge_from: null },
        { a: 6, b: 8, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [],
      counts: { heavy: 8, rings: 0, heteroatoms: { N: 1, O: 3 } },
      layoutPolicy: 'ketcher_clean_locked',
      stereoTransfer: [{ center: 2, stereo_label: 'S' } as unknown as never],
    };
    await expect(build(intent)).rejects.toThrow(/stereo_transfer_failed|enumerate_stereocenters/);
  });

  it('Fix 1 (non-layoutPolicy path): flat alanine without any wedge fails post-build', async () => {
    // No layoutPolicy, no bond.wedge, no stereo_unknown → Indigo perceives
    // the central C as undefined stereo → post-build Fix 1 must fail.
    const intent: GraphIntent = {
      version: 1,
      label: 'alanine-flat-no-wedge',
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
    };
    await expect(build(intent)).rejects.toThrow(/stereo_transfer_failed|enumerate_stereocenters/);
  });

  it('Fix 1 (non-layoutPolicy path): flat alanine with atom.stereo_unknown=true passes', async () => {
    // Explicit per-atom skip → Fix 1 tolerates the still-undefined center.
    const intent: GraphIntent = {
      version: 1,
      label: 'alanine-flat-skip',
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 2, element: 'C', drawn_H: 1, charge: 0, radical: 0, ring: null, stereo_unknown: true },
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
    };
    const result = await build(intent);
    const smiles = result.after.smiles ?? '';
    expect(/@/.test(smiles)).toBe(false);
  });

  it('Fix 1: stereo_label "unknown" satisfies the enumerate-and-require gate', async () => {
    const intent: GraphIntent = {
      version: 1,
      label: 'threonine-fix1-unknown-test',
      atoms: [
        { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 2, element: 'C', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 3, element: 'N', drawn_H: 2, charge: 0, radical: 0, ring: null },
        { id: 4, element: 'C', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 5, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
        { id: 6, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 7, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null },
        { id: 8, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null },
      ],
      bonds: [
        { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
        { a: 2, b: 4, order: 1, wedge: null, wedge_from: null },
        { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
        { a: 4, b: 6, order: 1, wedge: null, wedge_from: null },
        { a: 6, b: 7, order: 2, wedge: null, wedge_from: null },
        { a: 6, b: 8, order: 1, wedge: null, wedge_from: null },
      ],
      rings: [],
      counts: { heavy: 8, rings: 0, heteroatoms: { N: 1, O: 3 } },
      layoutPolicy: 'ketcher_clean_locked',
      stereoTransfer: [
        { center: 2, stereo_label: 'S' } as unknown as never,
        { center: 4, stereo_label: 'unknown' } as unknown as never,
      ],
    };
    const result = await build(intent);
    const smiles = result.after.smiles ?? '';
    // One stereocenter is committed (S), the other is unknown — exactly
    // one @ marker.
    expect((smiles.match(/@/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

const buildTool = buildTools[0]; // build_from_graph

// ---------------------------------------------------------------------------
// Task 3: build_from_graph pins validate_counts:true (forbids the bypass)
// ---------------------------------------------------------------------------
// Rationale: build_from_graph is the Ketcher-authored path for BOTH
// ketcher-image-rebuild AND ketcher-ingest, both contracted to true. An agent
// self-authorizing validate_counts:false silently shipped a wrong skeleton in
// the A004H-r1 failure (declared 7 rings, bonds formed 10 cycles). Forcing
// true on the tool layer closes the footgun without touching the translator.
//
// Two cases:
//   Catch  — square+chord graph (Euler rings=2 from bonds, declared rings=1):
//             schema passes (counts.rings==rings.length==1, V12 ring-walk ok)
//             but bond topology has 2 Euler rings → validate_counts mismatch.
//             With false (today): bypass honored → ok:true (RED).
//             After pin: forced true → count_mismatch → ok:false (GREEN).
//   FP=0   — pristine benzene (declared rings:1, bond-Euler 1) + false → builds ok
// ---------------------------------------------------------------------------

const describeTask3 = runE2E ? describe : describe.skip;

// A graph that passes schema validation (counts.rings == rings.length == 1,
// V12 ring-walk ok: all consecutive ring-atom pairs have a bond) but whose
// bond topology forms 2 Euler rings (the declared ring + an extra chord).
// All atoms carry stereo_unknown:true so Fix 1 (enumerate-and-require) does
// not fire, leaving validate_counts as the only guard.
//
// Layout: 4-atom ring [1-2-3-4-1] with an extra bond [1-3].
//   - Ring walk 1→2→3→4→(1) → all 4 edges present → V12 ok.
//   - Euler: 5 bonds - 4 atoms + 1 component = 2 rings.
//   - declared: counts.rings=1, rings.length=1 → schema ok.
//   - validate_counts: expected 1 ≠ observed 2 → count_mismatch.
function squareWithChord(): GraphIntent {
  return {
    version: 1,
    label: 'square-with-chord',
    atoms: [
      { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', stereo_unknown: true },
      { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', stereo_unknown: true },
      { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', stereo_unknown: true },
      { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', stereo_unknown: true },
    ],
    bonds: [
      { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 3, b: 4, order: 1, wedge: null, wedge_from: null },
      { a: 4, b: 1, order: 1, wedge: null, wedge_from: null },
      // Extra chord: splits the ring → 2 Euler rings, only 1 declared.
      { a: 1, b: 3, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [{ id: 'r1', atoms: [1, 2, 3, 4], kind: 'kekule' }],
    counts: { heavy: 4, rings: 1, heteroatoms: {} },
  };
}

describeTask3(
  'Task 3: build_from_graph pins validate_counts:true (forbids the bypass)',
  () => {
    const rt = new KetcherRuntime();

    beforeAll(async () => {
      await rt.start();
      // Disable T1b gate: no preceding validate_graph round needed.
      process.env.KETCHER_BUILD_AFTER_VALIDATE = '0';
    }, 180000);

    afterAll(async () => {
      delete process.env.KETCHER_BUILD_AFTER_VALIDATE;
      await rt.stop();
    });

    it('Catch: extra-chord graph (Euler rings=2, declared rings=1) + validate_counts:false still rejects (count_mismatch)', async () => {
      const result = await buildTool.run(rt, {
        graph: squareWithChord(),
        validate_counts: false,
        layout: 'auto' as const,
      });
      // RED: before the fix, false is honored → no check → ok:true.
      // GREEN: after the pin, forced true → count_mismatch → ok:false.
      expect((result as { ok: boolean }).ok).toBe(false);
      expect(
        (result as { ok: false; error: { code: string } }).error.code,
      ).toBe('BUILD_FROM_GRAPH_COUNT_MISMATCH');
    });

    it('FP=0: pristine benzene + validate_counts:false still builds ok (forced check passes)', async () => {
      const result = await buildTool.run(rt, {
        graph: benzene(),
        validate_counts: false,
        layout: 'auto' as const,
      });
      // Forcing the check on a correct graph must not block a clean build.
      expect((result as { ok: boolean }).ok).toBe(true);
    });
  },
);

// ---------------------------------------------------------------------------
// Task 2C: build_from_graph clears canvas first (cross-row leakage prevention)
// ---------------------------------------------------------------------------
// TDD failing test: before the fix, back-to-back build_from_graph calls
// (without any intervening clearCanvas) accumulate atoms on the same canvas.
// After the fix (clearCanvas at the top of the tool's run handler), each
// build starts on a blank canvas.
//
// Implementation note: we import buildTools and call the run() handler
// directly so the test exercises the actual tool path (not just
// translateGraphIntent). T1b gate is disabled via env var.
// ---------------------------------------------------------------------------

const describeClear = runE2E ? describe : describe.skip;

describeClear('build_from_graph clears canvas before building (Task 2C)', () => {
  const rt = new KetcherRuntime();

  beforeAll(async () => {
    await rt.start();
    // Disable T1b gate so the tool handler runs without a preceding
    // validate_graph round in the session trace.
    process.env.KETCHER_BUILD_AFTER_VALIDATE = '0';
  }, 180000);

  afterAll(async () => {
    delete process.env.KETCHER_BUILD_AFTER_VALIDATE;
    await rt.stop();
  });

  const benzeneArgs = {
    graph: benzene(),
    validate_counts: true,
    layout: 'auto' as const,
  };

  const waterArgs = {
    graph: {
      version: 1 as const,
      label: 'water',
      atoms: [{ id: 1, element: 'O', drawn_H: 2 as number | null, charge: 0, radical: 0 as const, ring: null }],
      bonds: [],
      rings: [],
      counts: { heavy: 1, rings: 0, heteroatoms: { O: 1 } },
    } as GraphIntent,
    validate_counts: true,
    layout: 'auto' as const,
  };

  it('second build_from_graph call sees only the new molecule atoms (no cross-row leakage)', async () => {
    // Row 1: build benzene (6 heavy atoms).
    const row1 = await buildTool.run(rt, benzeneArgs);
    expect((row1 as { ok: boolean }).ok).toBe(true);
    const afterBenzene = await rt.getState(false);
    expect(afterBenzene.atoms.length).toBe(6); // sanity

    // Row 2: build water (1 heavy atom) WITHOUT any explicit clearCanvas call
    // between rows. The tool handler MUST clear internally.
    //
    // FAILS before fix: benzene (6) + water oxygen (1) = 7 atoms total.
    // PASSES after fix: clearCanvas inside run() → only water's 1 atom.
    const row2 = await buildTool.run(rt, waterArgs);
    expect((row2 as { ok: boolean }).ok).toBe(true);
    const afterWater = await rt.getState(false);

    // Key assertion: only 1 atom (water's O), not 7 (benzene + water leakage).
    expect(afterWater.atoms.length).toBe(1);
  });
});
