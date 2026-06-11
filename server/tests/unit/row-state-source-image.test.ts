import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  readSourceImagePath,
  writeSourceImagePath,
} from '../../src/mcp/tools/row-state';
import { validateTools } from '../../src/mcp/tools/validate';

// Wave-2 Task 4A — de-dormant the pixel-grounding pass.
//
// `validate_graph` is stateless: each call is independent and the source
// image path is only present on the call where the agent supplies it.
// The bidirectional pixel pass needs that path on EVERY call for the row,
// so it is persisted into the row-state sidecar on first sight and
// recovered on later calls (keyed by the row's outputDir, which
// resolveRowState already derives from the sourceImagePath hash).
describe('row-state sourceImagePath sidecar (Task 4A)', () => {
  const cleanups: string[] = [];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'row-state-src-'));
    cleanups.push(dir);
  });

  afterEach(() => {
    for (const d of cleanups) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    cleanups.length = 0;
  });

  it('readSourceImagePath returns null when sidecar absent', () => {
    expect(readSourceImagePath(dir)).toBeNull();
  });

  it('persists a sourceImagePath on one call and recovers it on the next', () => {
    // First call: agent supplied the path → persist it.
    writeSourceImagePath(dir, '/images/A004H_hires.png');
    // Subsequent stateless call: path not supplied → recover from sidecar.
    expect(readSourceImagePath(dir)).toBe('/images/A004H_hires.png');
  });

  it('does not overwrite an already-persisted path with a later write of the same value', () => {
    writeSourceImagePath(dir, '/images/A004H_hires.png');
    writeSourceImagePath(dir, '/images/A004H_hires.png');
    expect(readSourceImagePath(dir)).toBe('/images/A004H_hires.png');
  });
});

// End-to-end: the de-dormant pass recovers the path across a stateless
// validate_graph call boundary. Call 1 supplies sourceImagePath + an
// explicit outputDir; call 2 (same outputDir, NO sourceImagePath) must
// still run the pixel pass against the recovered path.
describe('validate_graph de-dormant pixel pass recovers sourceImagePath (Task 4A)', () => {
  const tool = validateTools[0];
  const cleanups: string[] = [];
  let workDir: string;
  let benzenePath: string;
  let rowDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'src-recover-img-'));
    cleanups.push(workDir);
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

  beforeEach(() => {
    rowDir = mkdtempSync(join(tmpdir(), 'src-recover-row-'));
    cleanups.push(rowDir);
  });

  afterAll(() => {
    for (const d of cleanups) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    cleanups.length = 0;
  });

  // A single carbon declared at a white pixel: the pixel pass emits
  // `vertex_not_visible_at_coord` ONLY if it actually ran (i.e. a source
  // path was available). Used as a witness that the path was recovered.
  const whiteVertexGraph = {
    version: 1 as const,
    atoms: [
      {
        id: 1,
        element: 'C',
        drawn_H: null,
        charge: 0,
        radical: 0,
        ring: null,
        x: 10,
        y: 10,
      },
    ],
    bonds: [],
    rings: [],
    counts: { heavy: 1, rings: 0, heteroatoms: {} },
  };

  it('call 1 (path supplied) persists; call 2 (no path, same outputDir) recovers and still runs the pass', async () => {
    // Call 1: supply the path.
    const r1 = await tool.run({} as any, {
      sourceImagePath: benzenePath,
      outputDir: rowDir,
      rowId: 'A004',
      graph: whiteVertexGraph,
    });
    const codes1 = ((r1 as any).data?.diagnostics ?? (r1 as any).diagnostics ?? []).map(
      (d: any) => d.code,
    );
    expect(codes1).toContain('vertex_not_visible_at_coord');
    expect(readSourceImagePath(rowDir)).toBe(benzenePath);

    // Call 2: NO sourceImagePath, but same outputDir → recovered path.
    const r2 = await tool.run({} as any, {
      outputDir: rowDir,
      rowId: 'A004',
      graph: whiteVertexGraph,
    });
    const codes2 = ((r2 as any).data?.diagnostics ?? (r2 as any).diagnostics ?? []).map(
      (d: any) => d.code,
    );
    expect(codes2).toContain('vertex_not_visible_at_coord');
  });

  it('without a prior persist, a path-less call runs no pixel pass (no recovery, no FP)', async () => {
    const r = await tool.run({} as any, {
      outputDir: rowDir,
      rowId: 'A004',
      graph: whiteVertexGraph,
    });
    const codes = ((r as any).data?.diagnostics ?? (r as any).diagnostics ?? []).map(
      (d: any) => d.code,
    );
    expect(codes).not.toContain('vertex_not_visible_at_coord');
  });
});
