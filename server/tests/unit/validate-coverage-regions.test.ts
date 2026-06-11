import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { validateTools } from '../../src/mcp/tools/validate';
import { _resetSessionUuidForTest } from '../../src/mcp/tools/row-state';

// Reset the sticky session-row binding before each test so an anchorless
// validate_graph call (no sourceImagePath) does not inherit a source image
// persisted by a prior path-supplied test (session-sticky behavior added
// 2026-05-30).
beforeEach(() => {
  _resetSessionUuidForTest();
});

// ─────────────────────────────────────────────────────────────────────
// Wave-2 Task 4C — wire the bidirectional pixel pass as ONE advisory
// surface: `coverage_regions` (Direction B: pixels → declarations) with
// crop targets for unexplained ink. The pass NEVER blocks build and NEVER
// hard-fails: coverage_regions are advisory only and do NOT flip result.ok.
//
// Direction A (declared → pixels) continues to emit its per-atom/bond
// diagnostics; Direction B adds coverage_regions. Both compare against the
// IMAGE — never declaration ↔ declaration.
// ─────────────────────────────────────────────────────────────────────

const tool = validateTools[0];

const PACLITAXEL_SMILES =
  'CC(=O)O[C@H]1C(=O)[C@@]2(C)[C@H]([C@H](OC(=O)c3ccccc3)[C@]3(O)C[C@H](OC(=O)[C@H](O)[C@@H](NC(=O)c4ccccc4)c4ccccc4)C(C)=C1C3(C)C)[C@]1(OC(C)=O)CO[C@@H]1C[C@@H]2O';

const A004H_FIXTURE = join(
  process.cwd().endsWith('server') ? '..' : '.',
  'tests/scientific/images/academic-hires/A004H_hires.png',
);

const AFFINE = { S: 99.1, OX: 234, OY: 172 } as const;

async function indigoReachable(): Promise<boolean> {
  try {
    const resp = await fetch('http://127.0.0.1:8002/v2/info', {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function paclitaxelAtoms(): Promise<
  Array<{ id: number; element: string; drawn_H: null; charge: number; radical: number; ring: null; x: number; y: number }>
> {
  const resp = await fetch('http://127.0.0.1:8002/v2/indigo/layout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      struct: PACLITAXEL_SMILES,
      output_format: 'chemical/x-mdl-molfile',
    }),
  });
  const molfile: string = (await resp.json()).struct;
  const lines = molfile.split('\n');
  const nAtoms = parseInt(lines[3].slice(0, 3), 10);
  const raw: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < nAtoms; i++) {
    const l = lines[4 + i];
    raw.push({ x: parseFloat(l.slice(0, 10)), y: parseFloat(l.slice(10, 20)) });
  }
  const molMinX = Math.min(...raw.map((c) => c.x));
  const molMaxY = Math.max(...raw.map((c) => c.y));
  return raw.map((c, i) => ({
    id: i + 1,
    element: 'C',
    drawn_H: null,
    charge: 0,
    radical: 0,
    ring: null,
    x: AFFINE.OX + (c.x - molMinX) * AFFINE.S,
    y: AFFINE.OY + (molMaxY - c.y) * AFFINE.S,
  }));
}

function bondsChain(atoms: Array<{ id: number }>): Array<{
  a: number;
  b: number;
  order: number;
  wedge: null;
  wedge_from: null;
}> {
  // A spanning chain so the GraphIntent is connected; exact topology is
  // irrelevant to the pixels→declarations coverage check.
  const out = [];
  for (let i = 1; i < atoms.length; i++) {
    out.push({ a: atoms[i - 1].id, b: atoms[i].id, order: 1, wedge: null, wedge_from: null } as const);
  }
  return out;
}

let workDir: string;
let benzenePath: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'coverage-regions-'));
  benzenePath = join(workDir, 'benzene.png');
  const W = 400;
  const H = 400;
  const cx = 200;
  const cy = 200;
  const r = 100;
  const verts: Array<[number, number]> = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    verts.push([
      Math.round(cx + r * Math.cos(angle)),
      Math.round(cy + r * Math.sin(angle)),
    ]);
  }
  const path =
    verts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ') +
    ' Z';
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="white"/>
      <path d="${path}" stroke="black" stroke-width="5" fill="none"/>
    </svg>`,
  );
  await sharp(svg).png().toFile(benzenePath);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function pickResult(r: unknown): any {
  return (r as any).data ?? r;
}

describe('validate_graph advisory coverage_regions (Task 4C)', () => {
  it('fully-declared benzene → coverage_regions is present and empty', async () => {
    const r = await tool.run({} as any, {
      sourceImagePath: benzenePath,
      graph: {
        version: 1,
        atoms: [
          { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', x: 200, y: 100 },
          { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', x: 287, y: 150 },
          { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', x: 287, y: 250 },
          { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', x: 200, y: 300 },
          { id: 5, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', x: 113, y: 250 },
          { id: 6, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', x: 113, y: 150 },
        ],
        bonds: [
          { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
          { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
          { a: 3, b: 4, order: 1, wedge: null, wedge_from: null },
          { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
          { a: 5, b: 6, order: 1, wedge: null, wedge_from: null },
          { a: 6, b: 1, order: 1, wedge: null, wedge_from: null },
        ],
        rings: [{ id: 'r1', atoms: [1, 2, 3, 4, 5, 6], kind: 'kekule' }],
        counts: { heavy: 6, rings: 1, heteroatoms: {} },
      },
    });
    const data = pickResult(r);
    expect(Array.isArray(data.coverage_regions)).toBe(true);
    expect(data.coverage_regions.length).toBe(0);
  });

  it('coverage_regions is absent / empty when no source image is available', async () => {
    const r = await tool.run({} as any, {
      graph: {
        version: 1,
        atoms: [{ id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 50, y: 50 }],
        bonds: [],
        rings: [],
        counts: { heavy: 1, rings: 0, heteroatoms: {} },
      },
    });
    const data = pickResult(r);
    // No image → nothing to compare against. Field, if present, is empty.
    expect(data.coverage_regions ?? []).toEqual([]);
  });

  it('DENSE: fully-declared paclitaxel → coverage_regions empty (FP=0 at tool level)', async () => {
    if (!(await indigoReachable())) {
      console.warn('SKIP dense coverage FP: Indigo not reachable.');
      return;
    }
    expect(existsSync(A004H_FIXTURE)).toBe(true);
    const atoms = await paclitaxelAtoms();
    const r = await tool.run({} as any, {
      sourceImagePath: A004H_FIXTURE,
      graph: {
        version: 1,
        atoms,
        bonds: bondsChain(atoms),
        rings: [],
        counts: { heavy: atoms.length, rings: 0, heteroatoms: {} },
      },
    });
    const data = pickResult(r);
    expect(Array.isArray(data.coverage_regions)).toBe(true);
    expect(data.coverage_regions.length).toBe(0);
  });

  it('DENSE: fragment-only paclitaxel → coverage_regions populated WITH crop targets, but result stays advisory (does not block)', async () => {
    if (!(await indigoReachable())) {
      console.warn('SKIP dense coverage TP: Indigo not reachable.');
      return;
    }
    const atoms = (await paclitaxelAtoms()).slice(0, 6);
    const r = await tool.run({} as any, {
      sourceImagePath: A004H_FIXTURE,
      graph: {
        version: 1,
        atoms,
        bonds: bondsChain(atoms),
        rings: [],
        counts: { heavy: atoms.length, rings: 0, heteroatoms: {} },
      },
    });
    const data = pickResult(r);
    expect(data.coverage_regions.length).toBeGreaterThanOrEqual(3);
    for (const region of data.coverage_regions) {
      expect(typeof region.x_center).toBe('number');
      expect(typeof region.y_center).toBe('number');
      expect(region.bbox_radius).toBeGreaterThan(0);
      expect(typeof region.ink_density).toBe('number');
    }
  });
});
