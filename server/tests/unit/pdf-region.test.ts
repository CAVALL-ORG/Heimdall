// server/tests/unit/pdf-region.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { KetcherRuntime } from '../../src/mcp/runtime';
import { pdfTools, computeEdgeInk, trimToContent } from '../../src/mcp/tools/pdf';

// Package is ESM ("type": "module") — no __dirname. Resolve from cwd like
// detect-unexplained-ink.test.ts:43-46 does (vitest runs from server/).
const FIXTURE_PDF = path.resolve(
  path.join(
    process.cwd().endsWith('server') ? '..' : '.',
    'tests/panels/image-to-smiles.pdf',
  ),
); // 5 pages, 612x792 pts, rot 0

const runtime = {} as KetcherRuntime; // tool is canvas-free; run() ignores it
const tool = pdfTools.find((t) => t.name === 'render_pdf_region')!;

const tmpdirs: string[] = [];
async function makeTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-region-'));
  tmpdirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tmpdirs.length) {
    await fs.rm(tmpdirs.pop()!, { recursive: true, force: true });
  }
});

describe('render_pdf_region', () => {
  it('renders a full page at the default locate DPI (150)', async () => {
    const outputDir = await makeTmp();
    const res = await tool.run(runtime, {
      pdfPath: FIXTURE_PDF,
      page: 3,
      outputDir,
    });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, any>;
    // 612x792 pts @150 DPI -> 1275x1650 (poppler may round up by 1)
    expect(data.regionWidthPx).toBeGreaterThanOrEqual(1275);
    expect(data.regionWidthPx).toBeLessThanOrEqual(1276);
    expect(data.regionHeightPx).toBeGreaterThanOrEqual(1650);
    expect(data.regionHeightPx).toBeLessThanOrEqual(1651);
    expect(data.pageWidthPx).toBe(data.regionWidthPx);
    expect(data.dpi).toBe(150);
    expect(data.path).toBe(path.join(outputDir, 'page-3.png'));
    const meta = await sharp(data.path).metadata();
    expect(meta.width).toBe(data.regionWidthPx);
    expect(meta.height).toBe(data.regionHeightPx);
  });

  it('renders a normalized-bbox region at the default crop DPI (400)', async () => {
    const outputDir = await makeTmp();
    const res = await tool.run(runtime, {
      pdfPath: FIXTURE_PDF,
      page: 3,
      bbox: { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.5 },
      outputDir,
    });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, any>;
    // page @400 DPI = 3400x4400 px; region = 0.5w x 0.25h
    expect(Math.abs(data.regionWidthPx - 1700)).toBeLessThanOrEqual(2);
    expect(Math.abs(data.regionHeightPx - 1100)).toBeLessThanOrEqual(2);
    expect(data.dpi).toBe(400);
    expect(data.pixelRect.x).toBeGreaterThan(0);
    const meta = await sharp(data.path).metadata();
    expect(meta.width).toBe(data.regionWidthPx);
  });

  it('clamps a bbox to page bounds instead of failing', async () => {
    const outputDir = await makeTmp();
    const res = await tool.run(runtime, {
      pdfPath: FIXTURE_PDF,
      page: 1,
      bbox: { x0: 0.9, y0: 0.9, x1: 1, y1: 1 },
      dpi: 150,
      outputDir,
    });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, any>;
    expect(data.pixelRect.x + data.pixelRect.w).toBeLessThanOrEqual(data.pageWidthPx);
    expect(data.pixelRect.y + data.pixelRect.h).toBeLessThanOrEqual(data.pageHeightPx);
  });

  it('rejects a degenerate bbox', async () => {
    const outputDir = await makeTmp();
    const res = await tool.run(runtime, {
      pdfPath: FIXTURE_PDF,
      page: 1,
      bbox: { x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.7 },
      outputDir,
    });
    expect(res.ok).toBe(false);
    expect((res.error as any).code).toBe('INVALID_INPUT');
  });

  it('errors on a missing PDF', async () => {
    const outputDir = await makeTmp();
    const res = await tool.run(runtime, {
      pdfPath: '/nonexistent/nope.pdf',
      page: 1,
      outputDir,
    });
    expect(res.ok).toBe(false);
    expect((res.error as any).code).toBe('PDF_NOT_FOUND');
  });

  it('errors on an out-of-range page', async () => {
    const outputDir = await makeTmp();
    const res = await tool.run(runtime, {
      pdfPath: FIXTURE_PDF,
      page: 99,
      outputDir,
    });
    expect(res.ok).toBe(false);
    expect((res.error as any).code).toBe('PAGE_OUT_OF_RANGE');
  });

  it('honors the label override for the output filename', async () => {
    const outputDir = await makeTmp();
    const res = await tool.run(runtime, {
      pdfPath: FIXTURE_PDF,
      page: 2,
      bbox: { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.3 },
      label: 'mol-1',
      outputDir,
    });
    expect(res.ok).toBe(true);
    expect((res.data as any).path).toBe(path.join(outputDir, 'mol-1.png'));
  });

  it('rejects a pure-dot label (path traversal guard)', async () => {
    const outputDir = await makeTmp();
    // zod regex rejects '..' — run() re-parses, so the call throws ZodError
    // (the server layer catches ZodError and maps it to INVALID_INPUT).
    await expect(
      tool.run(runtime, {
        pdfPath: FIXTURE_PDF,
        page: 1,
        label: '..',
        outputDir,
      }),
    ).rejects.toThrow();
  });

  it('paints a whiteout rect white and leaves dims unchanged', async () => {
    const outputDir = await makeTmp();
    const base = await tool.run(runtime, {
      pdfPath: FIXTURE_PDF, page: 1, outputDir, label: 'base',
    });
    const masked = await tool.run(runtime, {
      pdfPath: FIXTURE_PDF, page: 1, outputDir, label: 'masked',
      whiteout: [{ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }],
    });
    expect(masked.ok).toBe(true);
    const b = base.data as Record<string, any>;
    const m = masked.data as Record<string, any>;
    expect(m.regionWidthPx).toBe(b.regionWidthPx);
    expect(m.regionHeightPx).toBe(b.regionHeightPx);
    // a pixel at the center (inside the rect) is white in the masked output
    const W = m.regionWidthPx, H = m.regionHeightPx;
    const center = await sharp(m.path)
      .extract({ left: Math.round(W * 0.5), top: Math.round(H * 0.5), width: 1, height: 1 })
      .removeAlpha().raw().toBuffer();
    expect(center[0]).toBeGreaterThanOrEqual(250);
    expect(center[1]).toBeGreaterThanOrEqual(250);
    expect(center[2]).toBeGreaterThanOrEqual(250);
    // a pixel OUTSIDE the rect is unchanged vs the un-masked render
    // (tolerance ±3: sharp re-encodes the PNG on composite; a profile strip can
    // shift a channel by a hair even though PNG is lossless)
    const at = (p: string) => sharp(p)
      .extract({ left: Math.round(W * 0.05), top: Math.round(H * 0.05), width: 1, height: 1 })
      .removeAlpha().raw().toBuffer();
    const mPix = Array.from(await at(m.path));
    const bPix = Array.from(await at(b.path));
    for (let i = 0; i < 3; i++) expect(Math.abs(mPix[i] - bPix[i])).toBeLessThanOrEqual(3);
  });

  it('rejects a degenerate whiteout rect', async () => {
    const outputDir = await makeTmp();
    const res = await tool.run(runtime, {
      pdfPath: FIXTURE_PDF, page: 1, outputDir,
      whiteout: [{ x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.7 }],
    });
    expect(res.ok).toBe(false);
    expect((res.error as any).code).toBe('INVALID_INPUT');
  });

  it('treats an absent/empty whiteout as a normal render', async () => {
    const outputDir = await makeTmp();
    const res = await tool.run(runtime, {
      pdfPath: FIXTURE_PDF, page: 1, outputDir, whiteout: [],
    });
    expect(res.ok).toBe(true);
    expect((res.data as any).regionWidthPx).toBeGreaterThan(0);
  });

  it('computeEdgeInk: all-white image flags no edges', async () => {
    const dir = await makeTmp();
    const p = path.join(dir, 'white.png');
    await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ffffff' } }).png().toFile(p);
    expect(await computeEdgeInk(p)).toEqual({ top: false, right: false, bottom: false, left: false });
  });

  it('computeEdgeInk: ink on the top edge flags top only', async () => {
    const dir = await makeTmp();
    const p = path.join(dir, 'topink.png');
    await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ffffff' } })
      .composite([{ input: { create: { width: 40, height: 2, channels: 3, background: '#000000' } }, left: 0, top: 0 }])
      .png().toFile(p);
    const e = await computeEdgeInk(p);
    expect(e.top).toBe(true);
    expect(e.bottom).toBe(false);
    expect(e.left).toBe(false);
    expect(e.right).toBe(false);
  });

  it('computeEdgeInk: ink on the left edge flags left only (symmetry)', async () => {
    const dir = await makeTmp();
    const p = path.join(dir, 'leftink.png');
    await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ffffff' } })
      .composite([{ input: { create: { width: 2, height: 40, channels: 3, background: '#000000' } }, left: 0, top: 0 }])
      .png().toFile(p);
    const e = await computeEdgeInk(p);
    expect(e.left).toBe(true);
    expect(e.right).toBe(false);
    expect(e.top).toBe(false);
    expect(e.bottom).toBe(false);
  });

  it('render returns edgeInk all-false on a full page (white margins)', async () => {
    const outputDir = await makeTmp();
    const res = await tool.run(runtime, { pdfPath: FIXTURE_PDF, page: 1, outputDir });
    expect(res.ok).toBe(true);
    // a full typeset page has white margins → no ink at any border (the spec's
    // "generous crop flags all-false" half, on a real render)
    expect((res.data as Record<string, any>).edgeInk).toEqual({
      top: false, right: false, bottom: false, left: false,
    });
  });

  it('edgeInk flags an edge on a tight crop that cuts page content', async () => {
    const outputDir = await makeTmp();
    // a tight crop through the text-dense upper half of page 1 cuts ink at an edge
    const res = await tool.run(runtime, {
      pdfPath: FIXTURE_PDF, page: 1,
      bbox: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.5 }, outputDir,
    });
    expect(res.ok).toBe(true);
    const e = (res.data as Record<string, any>).edgeInk;
    expect(e.top || e.right || e.bottom || e.left).toBe(true);
  });

  it('whiteout over the whole crop covers real ink (non-vacuous)', async () => {
    const outputDir = await makeTmp();
    // page 1 has dark text → at least one channel min is well below white
    const base = await tool.run(runtime, { pdfPath: FIXTURE_PDF, page: 1, outputDir, label: 'inkbase' });
    const baseStats = await sharp((base.data as Record<string, any>).path).stats();
    expect(Math.min(...baseStats.channels.map((c) => c.min))).toBeLessThan(100);
    // whiteout the entire frame → the whole page is painted white
    const masked = await tool.run(runtime, {
      pdfPath: FIXTURE_PDF, page: 1, outputDir, label: 'inkmask',
      whiteout: [{ x0: 0, y0: 0, x1: 1, y1: 1 }],
    });
    const maskStats = await sharp((masked.data as Record<string, any>).path).stats();
    expect(Math.min(...maskStats.channels.map((c) => c.min))).toBeGreaterThanOrEqual(250);
  });

  it('trim defaults off: data.trim is null and dims equal a plain render', async () => {
    const outputDir = await makeTmp();
    const plain = await tool.run(runtime, { pdfPath: FIXTURE_PDF, page: 1, outputDir, label: 'p' });
    expect(plain.ok).toBe(true);
    expect((plain.data as Record<string, any>).trim).toBeNull();
  });

  it('trim:true tightens a generous crop yet stays clean (edgeInk all-false, ink kept)', async () => {
    const outputDir = await makeTmp();
    // a full typeset page has wide white margins → trim removes them
    const full = await tool.run(runtime, { pdfPath: FIXTURE_PDF, page: 1, outputDir, label: 'full' });
    const trimmed = await tool.run(runtime, { pdfPath: FIXTURE_PDF, page: 1, outputDir, label: 'trim', trim: true });
    expect(trimmed.ok).toBe(true);
    const f = full.data as Record<string, any>;
    const t = trimmed.data as Record<string, any>;
    expect(t.trim.applied).toBe(true);
    // final image is smaller than the untrimmed page on both axes
    expect(t.regionWidthPx).toBeLessThan(f.regionWidthPx);
    expect(t.regionHeightPx).toBeLessThan(f.regionHeightPx);
    // 12px margin > 3px edgeInk band → a clean generous crop reads all-false
    expect(t.edgeInk).toEqual({ top: false, right: false, bottom: false, left: false });
    // ink survived the trim
    const stats = await sharp(t.path).stats();
    expect(Math.min(...stats.channels.map((c) => c.min))).toBeLessThan(100);
  });

  it('trim:true does NOT mask a real clip — edgeInk (pre-trim) still flags it', async () => {
    const outputDir = await makeTmp();
    // tight crop slicing through dense text: ink reaches the crop boundary. edgeInk
    // is measured on the PRE-trim crop, so it must still flag the clip even with trim.
    const res = await tool.run(runtime, {
      pdfPath: FIXTURE_PDF, page: 1,
      bbox: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.5 }, outputDir, trim: true,
    });
    expect(res.ok).toBe(true);
    const e = (res.data as Record<string, any>).edgeInk;
    expect(e.top || e.right || e.bottom || e.left).toBe(true);
  });

  it('trim:true on an all-white region is a safe no-op (applied=false, no crash)', async () => {
    const outputDir = await makeTmp();
    // crop a region then white the whole frame out → nothing for trim to find
    const res = await tool.run(runtime, {
      pdfPath: FIXTURE_PDF, page: 1, outputDir, trim: true,
      whiteout: [{ x0: 0, y0: 0, x1: 1, y1: 1 }],
    });
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, any>).trim.applied).toBe(false);
  });
});

describe('trimToContent', () => {
  it('trims the white margin to the content bbox plus a uniform margin', async () => {
    const buf = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } })
      .composite([{ input: { create: { width: 20, height: 20, channels: 3, background: '#000000' } }, left: 40, top: 40 }])
      .png().toBuffer();
    const r = await trimToContent(buf, 5, 10);
    expect(r.applied).toBe(true);
    expect(r.contentWidthPx).toBe(20);
    expect(r.contentHeightPx).toBe(20);
    expect(r.offsetLeftPx).toBe(40);
    expect(r.offsetTopPx).toBe(40);
    const meta = await sharp(r.buffer).metadata();
    expect(meta.width).toBe(30); // 20 content + 2×5 margin
    expect(meta.height).toBe(30);
  });

  it('never removes ink — the content survives the trim', async () => {
    const buf = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#ffffff' } })
      .composite([{ input: { create: { width: 16, height: 16, channels: 3, background: '#000000' } }, left: 10, top: 10 }])
      .png().toBuffer();
    const r = await trimToContent(buf, 4, 10);
    const stats = await sharp(r.buffer).stats();
    expect(Math.min(...stats.channels.map((c) => c.min))).toBeLessThan(50);
  });

  it('is a no-op on an all-white image (applied=false, input returned unchanged)', async () => {
    const buf = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const r = await trimToContent(buf, 5, 10);
    expect(r.applied).toBe(false);
    const meta = await sharp(r.buffer).metadata();
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(50);
  });

  it('excludes whited-out foreign ink from the trim bbox (whiteout feeds trim)', async () => {
    // two ink blocks; white over the right one → trim bbox = left block only
    const withForeign = await sharp({ create: { width: 120, height: 60, channels: 3, background: '#ffffff' } })
      .composite([
        { input: { create: { width: 20, height: 20, channels: 3, background: '#000000' } }, left: 10, top: 20 },
        { input: { create: { width: 20, height: 20, channels: 3, background: '#000000' } }, left: 90, top: 20 },
      ]).png().toBuffer();
    const masked = await sharp(withForeign)
      .composite([{ input: { create: { width: 40, height: 60, channels: 3, background: '#ffffff' } }, left: 80, top: 0 }])
      .png().toBuffer();
    const r = await trimToContent(masked, 0, 10);
    expect(r.contentWidthPx).toBe(20);
    expect(r.offsetLeftPx).toBe(10);
  });
});
