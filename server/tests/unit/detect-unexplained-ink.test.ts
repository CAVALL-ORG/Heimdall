import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  detectUnexplainedInkRegions,
  type DeclaredAtomCoord,
} from '../../src/mcp/tools/image-grounding';

// ─────────────────────────────────────────────────────────────────────
// Wave-2 Task 4B — detectUnexplainedInkRegions (Direction B: pixels →
// declarations). FP=0 GATE is a HARD SHIP CONDITION.
//
// The detector grids the image, measures ink density per cell, and flags
// cells that have ink AND no declared atom nearby ("unexplained ink").
//
// HARD GATE:
//   - FP1 (simple): benzene, all 6 atoms declared at true pixel coords → 0.
//   - FP2 (DENSE):  paclitaxel (A004H_hires fixture), all 62 atoms declared
//     at their TRUE vertex pixel coords → 0. If this cannot be driven to 0,
//     the detector DOES NOT SHIP.
//   - TP:           the SAME dense molecule, only a ~6-atom fragment
//     declared → ≥3 unexplained regions.
//
// The dense fixture's true vertex pixel coords are obtained by laying the
// molecule out via Indigo (deterministic) and applying the calibrated
// affine the committed A004H_hires.png render uses. When Indigo is not
// reachable, the dense FP2 + TP cases SKIP with a documented reason
// (mirrors the repo's RUN_KETCHER_E2E gating); the benzene FP1 case is
// fully hermetic and always runs.
// ─────────────────────────────────────────────────────────────────────

const INDIGO_LAYOUT_URL = 'http://127.0.0.1:8002/v2/indigo/layout';

// Full paclitaxel — same SMILES as manifest row A004 / the A004H_hires
// generator. NOTE: this is a test fixture coordinate source only; no
// SMILES is authored toward an answer here.
const PACLITAXEL_SMILES =
  'CC(=O)O[C@H]1C(=O)[C@@]2(C)[C@H]([C@H](OC(=O)c3ccccc3)[C@]3(O)C[C@H](OC(=O)[C@H](O)[C@@H](NC(=O)c4ccccc4)c4ccccc4)C(C)=C1C3(C)C)[C@]1(OC(C)=O)CO[C@@H]1C[C@@H]2O';

// Committed hi-res fixture (1631×1165). Path resolves from the package cwd.
const A004H_FIXTURE = join(
  process.cwd().endsWith('server') ? '..' : '.',
  'tests/scientific/images/academic-hires/A004H_hires.png',
);

// Affine calibrated against the committed A004H_hires.png render:
//   px_x = OX + (molX - molMinX) * S
//   px_y = OY + (molMaxY - molY) * S   (image y is y-DOWN; molfile is y-UP)
// Fit maximizes on-ink vertices; residual ≤ 6px (sub-bond-length jitter),
// well inside the detector's grid/proximity tolerance.
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

/** Lay paclitaxel out via Indigo and map each atom to its pixel coord. */
async function paclitaxelPixelCoords(): Promise<DeclaredAtomCoord[]> {
  const resp = await fetch(INDIGO_LAYOUT_URL, {
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
    x: AFFINE.OX + (c.x - molMinX) * AFFINE.S,
    y: AFFINE.OY + (molMaxY - c.y) * AFFINE.S,
  }));
}

let workDir: string;
let benzenePath: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'detect-ink-'));
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

describe('detectUnexplainedInkRegions — FP=0 GATE (hard ship condition)', () => {
  it('FP1 (simple): benzene fully declared at true coords → 0 unexplained regions', async () => {
    const declared: DeclaredAtomCoord[] = [
      { id: 1, x: 200, y: 100 },
      { id: 2, x: 287, y: 150 },
      { id: 3, x: 287, y: 250 },
      { id: 4, x: 200, y: 300 },
      { id: 5, x: 113, y: 250 },
      { id: 6, x: 113, y: 150 },
    ];
    const regions = await detectUnexplainedInkRegions(benzenePath, declared);
    expect(regions.length).toBe(0);
  });

  it('FP2 (DENSE): paclitaxel fully declared at true vertex coords → 0 unexplained regions', async () => {
    if (!(await indigoReachable())) {
      // Documented skip: dense FP fixture needs Indigo /layout for true
      // vertex coords. Benzene FP1 (above) is the hermetic FP gate.
      console.warn(
        'SKIP FP2 (dense): Indigo not reachable; cannot derive true vertex coords for paclitaxel.',
      );
      return;
    }
    expect(existsSync(A004H_FIXTURE)).toBe(true);
    const declared = await paclitaxelPixelCoords();
    expect(declared.length).toBe(62); // C47H51NO14 → 62 heavy atoms
    const regions = await detectUnexplainedInkRegions(A004H_FIXTURE, declared);
    expect(regions.length).toBe(0);
  });

  it('FP2 robustness: paclitaxel coords perturbed by ±6px (affine residual) → still 0', async () => {
    if (!(await indigoReachable())) {
      console.warn('SKIP FP2-robustness: Indigo not reachable.');
      return;
    }
    const declared = await paclitaxelPixelCoords();
    // Deterministic ±6px jitter on every atom (worst-case coord residual).
    let s = 12345;
    const rnd = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    const noisy = declared.map((a) => ({
      id: a.id,
      x: a.x + (rnd() * 2 - 1) * 6,
      y: a.y + (rnd() * 2 - 1) * 6,
    }));
    const regions = await detectUnexplainedInkRegions(A004H_FIXTURE, noisy);
    expect(regions.length).toBe(0);
  });

  it('TP: paclitaxel with only a 6-atom fragment declared → ≥3 unexplained regions', async () => {
    if (!(await indigoReachable())) {
      console.warn('SKIP TP: Indigo not reachable.');
      return;
    }
    const declared = await paclitaxelPixelCoords();
    const fragment = declared.slice(0, 6);
    const regions = await detectUnexplainedInkRegions(A004H_FIXTURE, fragment);
    expect(regions.length).toBeGreaterThanOrEqual(3);
  });

  it('returns crop targets (x, y, bbox) for each unexplained region', async () => {
    if (!(await indigoReachable())) {
      console.warn('SKIP crop-target shape: Indigo not reachable.');
      return;
    }
    const declared = await paclitaxelPixelCoords();
    const regions = await detectUnexplainedInkRegions(
      A004H_FIXTURE,
      declared.slice(0, 6),
    );
    expect(regions.length).toBeGreaterThan(0);
    for (const r of regions) {
      expect(typeof r.x_center).toBe('number');
      expect(typeof r.y_center).toBe('number');
      expect(typeof r.bbox_radius).toBe('number');
      expect(r.bbox_radius).toBeGreaterThan(0);
      expect(typeof r.ink_density).toBe('number');
    }
  });
});
