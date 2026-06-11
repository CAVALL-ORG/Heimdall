import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  samplePatch,
  minPatchInNeighborhood,
  sampleBondLine,
  countConnectedComponents,
  imageMetadata,
} from '../../src/mcp/tools/image-grounding';
import { _resetSessionUuidForTest } from '../../src/mcp/tools/row-state';

let workDir: string;
let benzenePath: string;

// Reset the sticky session-row binding before each test. Anchorless
// validate_graph calls (no sourceImagePath / outputDir) inherit the row a
// prior anchored call established (the session-sticky behavior added
// 2026-05-30); without a per-test reset, a path-supplied test would leak
// its recovered source image into a later "no source image" test.
beforeEach(() => {
  _resetSessionUuidForTest();
});

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'pixel-grounding-'));
  benzenePath = join(workDir, 'benzene.png');
  // Synthesize a benzene hex outline on a 400x400 white canvas.
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
  const path = verts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`)
    .join(' ') + ' Z';
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

describe('samplePatch', () => {
  it('returns mean intensity > 0.95 (white) at known-white coord', async () => {
    const mean = await samplePatch(benzenePath, 10, 10, 5);
    expect(mean).toBeGreaterThan(0.95);
  });

  it('returns mean intensity < 0.95 at a vertex coord on the hex perimeter', async () => {
    const mean = await samplePatch(benzenePath, 200, 100, 7);
    expect(mean).toBeLessThan(0.95);
  });
});

describe('minPatchInNeighborhood (P1 not-visible verdict widen)', () => {
  it('finds the stroke for an off-ink-by-~10px coord near a drawn edge', async () => {
    // The top-right hex edge runs (200,100)→(287,150). The coord (230,110)
    // lands ~10px off that 5px stroke: the 5px center patch reads pure white,
    // but a ~12px neighborhood finds the stroke, so the vertex is NOT declared
    // not-visible. (Coords found by an offline grid probe over the fixture.)
    const onInkCenter = await samplePatch(benzenePath, 230, 110, 5);
    expect(onInkCenter).toBeGreaterThan(0.95); // center missed the stroke
    const neighborhood = await minPatchInNeighborhood(benzenePath, 230, 110, 12);
    expect(neighborhood).toBeLessThan(0.95); // but ink is found nearby
  });

  it('stays white for a coord in true whitespace far from any stroke', async () => {
    // (10,10) is ~250px from the nearest hex stroke — the neighborhood widen
    // must NOT false-green a genuinely-absent vertex.
    const neighborhood = await minPatchInNeighborhood(benzenePath, 10, 10, 12);
    expect(neighborhood).toBeGreaterThan(0.95);
  });
});

describe('sampleBondLine', () => {
  it('returns >70% white fraction along line outside the hex', async () => {
    const whiteFrac = await sampleBondLine(benzenePath, 10, 10, 50, 10, 10);
    expect(whiteFrac).toBeGreaterThan(0.7);
  });

  it('returns <70% white fraction along a drawn hex edge', async () => {
    // Top vertex (200, 100) to top-right vertex (~287, 150) — drawn edge.
    const whiteFrac = await sampleBondLine(benzenePath, 200, 100, 287, 150, 10);
    expect(whiteFrac).toBeLessThan(0.7);
  });
});

describe('countConnectedComponents', () => {
  it('counts benzene hex as a small number of dark regions', async () => {
    const n = await countConnectedComponents(benzenePath, 0.5);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(3);
  });
});

describe('imageMetadata', () => {
  it('returns the benzene fixture dimensions', async () => {
    const meta = await imageMetadata(benzenePath);
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(400);
  });
});

// Integration tests after image-grounding.ts ships:

import { validateTools } from '../../src/mcp/tools/validate';

describe('validate_graph pixel-grounding integration', () => {
  const tool = validateTools[0];

  it('positive control: clean benzene draft emits no pixel-grounding diagnostics', async () => {
    const result = await tool.run({} as any, {
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
    const data = (result as any).data ?? result;
    const codes = (data.diagnostics ?? []).map((d: any) => d.code);
    expect(codes).not.toContain('vertex_not_visible_at_coord');
    expect(codes).not.toContain('bond_line_not_drawn');
    expect(codes).not.toContain('over_deferred_draft');
    expect(codes).not.toContain('declared_coords_out_of_image_bounds');
  });

  it('P1 negative: vertex declared at white pixel triggers vertex_not_visible_at_coord', async () => {
    const result = await tool.run({} as any, {
      sourceImagePath: benzenePath,
      graph: {
        version: 1,
        atoms: [
          { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 10, y: 10 },
        ],
        bonds: [],
        rings: [],
        counts: { heavy: 1, rings: 0, heteroatoms: {} },
      },
    });
    const data = (result as any).data ?? result;
    const codes = (data.diagnostics ?? []).map((d: any) => d.code);
    expect(codes).toContain('vertex_not_visible_at_coord');
  });

  it('P2 negative: bond declared across hex interior (white) triggers bond_line_not_drawn', async () => {
    const result = await tool.run({} as any, {
      sourceImagePath: benzenePath,
      graph: {
        version: 1,
        atoms: [
          { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 200, y: 100 },
          { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 200, y: 300 },
        ],
        bonds: [{ a: 1, b: 2, order: 1, wedge: null, wedge_from: null }],
        rings: [],
        counts: { heavy: 2, rings: 0, heteroatoms: {} },
      },
    });
    const data = (result as any).data ?? result;
    const codes = (data.diagnostics ?? []).map((d: any) => d.code);
    expect(codes).toContain('bond_line_not_drawn');
  });

  it('P3 negative: >50% needs_zoom atoms triggers over_deferred_draft', async () => {
    const result = await tool.run({} as any, {
      sourceImagePath: benzenePath,
      graph: {
        version: 1,
        atoms: [
          { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 200, y: 100, confidence: 'needs_zoom' },
          { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 287, y: 150, confidence: 'needs_zoom' },
          { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 287, y: 250, confidence: 'needs_zoom' },
          { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 200, y: 300 },
        ],
        bonds: [],
        rings: [],
        counts: { heavy: 4, rings: 0, heteroatoms: {} },
        unresolved: [
          { record_id: 'a1', field: 'element', x_center: 200, y_center: 100, bbox_radius: 30 },
          { record_id: 'a2', field: 'element', x_center: 287, y_center: 150, bbox_radius: 30 },
          { record_id: 'a3', field: 'element', x_center: 287, y_center: 250, bbox_radius: 30 },
        ],
      },
    });
    const data = (result as any).data ?? result;
    const codes = (data.diagnostics ?? []).map((d: any) => d.code);
    expect(codes).toContain('over_deferred_draft');
  });

  // P4 image_heavy_count_mismatch test removed — diagnostic dropped because
  // it false-positives on fused polycycles (one connected dark blob vs
  // declared heavy ~25). countConnectedComponents helper kept (unit tested
  // above).

  it('coord-bounds negative: x exceeds image width triggers declared_coords_out_of_image_bounds', async () => {
    const result = await tool.run({} as any, {
      sourceImagePath: benzenePath,
      graph: {
        version: 1,
        atoms: [
          { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 9999, y: 100 },
        ],
        bonds: [],
        rings: [],
        counts: { heavy: 1, rings: 0, heteroatoms: {} },
      },
    });
    const data = (result as any).data ?? result;
    const codes = (data.diagnostics ?? []).map((d: any) => d.code);
    expect(codes).toContain('declared_coords_out_of_image_bounds');
  });

  it('P1/P2 diagnostics carry severity:warning and a P1/P2-only graph stays ok:true (locks §5.5 bug 1)', async () => {
    const result = await tool.run({} as any, {
      sourceImagePath: benzenePath,
      graph: {
        version: 1,
        // Two atoms in true whitespace (P1) joined by a bond across white (P2).
        // Structurally valid (2 heavy, 0 rings) so ok is driven only by the
        // pixel pass — which must NOT flip it.
        atoms: [
          { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 10, y: 10 },
          { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 30, y: 10 },
        ],
        bonds: [{ a: 1, b: 2, order: 1, wedge: null, wedge_from: null }],
        rings: [],
        counts: { heavy: 2, rings: 0, heteroatoms: {} },
      },
    });
    const data = (result as any).data ?? result;
    const diags = data.diagnostics ?? [];
    const p1 = diags.find((d: any) => d.code === 'vertex_not_visible_at_coord');
    const p2 = diags.find((d: any) => d.code === 'bond_line_not_drawn');
    expect(p1).toBeDefined();
    expect(p1.severity).toBe('warning');
    expect(p2).toBeDefined();
    expect(p2.severity).toBe('warning');
    // The pass runs after ok is computed and never recomputes it → ok stays true.
    expect(data.ok).toBe(true);
  });

  it('P1 widen: a vertex declared ~10px off a real stroke does NOT emit vertex_not_visible_at_coord (S3 guard)', async () => {
    const result = await tool.run({} as any, {
      sourceImagePath: benzenePath,
      graph: {
        version: 1,
        // (230,110) is ~10px off the on-ink top-right edge (200,100)→(287,150):
        // 5px center reads white but the 12px widen finds the stroke.
        atoms: [
          { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 230, y: 110 },
        ],
        bonds: [],
        rings: [],
        counts: { heavy: 1, rings: 0, heteroatoms: {} },
      },
    });
    const data = (result as any).data ?? result;
    const codes = (data.diagnostics ?? []).map((d: any) => d.code);
    expect(codes).not.toContain('vertex_not_visible_at_coord');
  });

  it('skips pixel pass entirely when sourceImagePath is absent', async () => {
    const result = await tool.run({} as any, {
      graph: {
        version: 1,
        atoms: [
          { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 9999, y: 9999 },
        ],
        bonds: [],
        rings: [],
        counts: { heavy: 1, rings: 0, heteroatoms: {} },
      },
    });
    const data = (result as any).data ?? result;
    const codes = (data.diagnostics ?? []).map((d: any) => d.code);
    expect(codes).not.toContain('vertex_not_visible_at_coord');
    expect(codes).not.toContain('declared_coords_out_of_image_bounds');
    expect(codes).not.toContain('bond_line_not_drawn');
  });
});
