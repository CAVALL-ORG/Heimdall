// server/tests/unit/crop-molecule.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import sharp from 'sharp';
import type { KetcherRuntime } from '../../src/mcp/runtime';
import { pdfTools } from '../../src/mcp/tools/pdf';
import { CANVAS_FREE_TOOLS } from '../../src/mcp/canvas-multiplex';

const runtime = {} as KetcherRuntime;
const tool = pdfTools.find(t => t.name === 'crop_molecule')!;

// Package is ESM ("type": "module") — no __dirname. Resolve from cwd like pdf-region.test.ts does.
const FIXTURE = path.resolve(
  path.join(
    process.cwd().endsWith('server') ? '..' : '.',
    'tests/panels/image-to-smiles.pdf',
  ),
); // 5 pages, 612x792 pts, rot 0

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cropmol-'));
}

describe('crop_molecule schema/registration', () => {
  it('is registered and canvas-free', () => {
    expect(tool).toBeTruthy();
    expect(CANVAS_FREE_TOOLS.has('crop_molecule')).toBe(true);
  });
  it('rejects empty seeds', async () => {
    // cropMoleculeSchema.parse throws ZodError for seeds:[] (min(1))
    await expect(
      tool.run(runtime, { pdfPath: FIXTURE, page: 1, seeds: [], outputDir: '/tmp/x' }),
    ).rejects.toThrow();
  });
  it('rejects non-absolute paths', async () => {
    const res = await tool.run(runtime, {
      pdfPath: 'rel.pdf',
      page: 1,
      seeds: [{ x: 0.5, y: 0.5 }],
      outputDir: '/tmp/x',
    });
    expect(res.ok).toBe(false);
    expect((res.error as { code: string }).code).toBe('INVALID_INPUT');
  });
});

describe('crop_molecule render', () => {
  it('crops a region around a seed, writes a PNG, returns bbox + counts', async () => {
    const outputDir = await tmp();
    // Page 3 of the fixture: seed at (0.16, 0.30) lands on a drawn molecule's ink
    // (confirmed black ink at pixel level — value 0,0,0 on a 200-DPI render).
    const res = await tool.run(runtime, {
      pdfPath: FIXTURE,
      page: 3,
      seeds: [{ x: 0.16, y: 0.30 }],
      outputDir,
      label: 'm',
    });
    expect(res.ok).toBe(true);
    const d = res.data as Record<string, unknown>;
    expect(d.path).toBe(path.join(outputDir, 'm.png'));
    const meta = await sharp(d.path as string).metadata();
    expect(meta.width).toBe(d.regionWidthPx);
    expect(d.regionWidthPx).toBeGreaterThan(0);
    const bbox = d.bbox as { x0: number; y0: number; x1: number; y1: number };
    expect(bbox.x1).toBeGreaterThan(bbox.x0);
    // the crop must contain ink (the seeded molecule), i.e. not blank-white
    const stats = await sharp(d.path as string).stats();
    expect(Math.min(...stats.channels.map(c => c.min))).toBeLessThan(100);
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  it('surfaces WITHIN_CLIPS_ALL when the within box excludes the seeded molecule', async () => {
    const outputDir = await tmp();
    // Same confirmed-ink seed as the render test above (page 3, drawn molecule ink).
    // Pass a within box in a far blank corner that cannot contain the molecule.
    const res = await tool.run(runtime, {
      pdfPath: FIXTURE,
      page: 3,
      seeds: [{ x: 0.16, y: 0.30 }],
      within: { x0: 0.9, y0: 0.9, x1: 0.99, y1: 0.99 },
      outputDir,
    });
    expect(res.ok).toBe(false);
    expect((res.error as { code: string }).code).toBe('WITHIN_CLIPS_ALL');
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  it('NO_INK_AT_SEED when the seed lands on a blank page region', async () => {
    const outputDir = await tmp();
    // Page 1 top-left margin is blank — confirmed white (255,255,255) at 200 DPI.
    const res = await tool.run(runtime, {
      pdfPath: FIXTURE,
      page: 1,
      seeds: [{ x: 0.02, y: 0.02 }],
      outputDir,
    });
    expect(res.ok).toBe(false);
    expect((res.error as { code: string }).code).toBe('NO_INK_AT_SEED');
    await fs.rm(outputDir, { recursive: true, force: true });
  });
});
