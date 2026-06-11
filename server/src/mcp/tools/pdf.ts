// server/src/mcp/tools/pdf.ts
//
// render_pdf_region — stateless, canvas-free PDF rasterize + region crop.
//
// Shells poppler's pdftoppm (sharp's prebuilt libvips has no PDF decode —
// verified on this box). bbox is NORMALIZED [0,1] over the page so agent
// vision never has to reason about raster pixel sizes (Read may downscale
// what the agent sees; normalized coords are downscale-invariant). No bbox
// = full page at LOCATE_DPI; bbox = that region at CROP_DPI. Deliberately
// NOT wired into row-state / ARGS_DEFAULT_TOOLS: this tool is upstream
// pre-processing for ketcher-pdf-extract, not part of an image-rebuild row.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import type { ToolDefinition } from './types';
import { segmentToKeep, resampleMaskRegion, compositeWhiteWhereZero } from '../../adapter/ink-segmentation';

const execFileAsync = promisify(execFile);

const LOCATE_DPI = 150; // full-page render: legible overview for vision
const CROP_DPI = 400;   // region render: clears image-rebuild's 300px floor
const TRIM_MARGIN_PX = 12; // white margin re-added after a trim. > computeEdgeInk's
                           // 3px band so a cleanly-trimmed crop still reads edgeInk
                           // all-false (the margin is white, no ink in the border).
const TRIM_THRESHOLD = 10; // sharp trim background tolerance: a channel within 10 of
                           // 255 (i.e. >=245) counts as white — matches the near-white
                           // cutoff computeEdgeInk uses, so both agree on "white".

const DETECT_DPI = 200;      // detection pass: enough resolution for ink segmentation
const SEG_THRESHOLD = 180;   // binarize: any channel < 180 is ink
const SEG_DILATION_PX = 6;   // at DETECT_DPI: bridges bond<->label gaps, below caption gaps

// Tool is canvas-free (no serialization queue), so concurrent calls can
// share a default stem. Render to a unique temp stem, then atomically
// rename into place (same-dir rename is atomic on POSIX).
let renderSeq = 0;

const bboxSchema = z.object({
  x0: z.number().min(0).max(1),
  y0: z.number().min(0).max(1),
  x1: z.number().min(0).max(1),
  y1: z.number().min(0).max(1),
});

const whiteoutRectSchema = z.object({
  x0: z.number().min(0).max(1),
  y0: z.number().min(0).max(1),
  x1: z.number().min(0).max(1),
  y1: z.number().min(0).max(1),
});

const renderPdfRegionSchema = z.object({
  pdfPath: z.string().min(1),
  page: z.number().int().min(1),
  bbox: bboxSchema.optional(),
  dpi: z.number().int().min(72).max(600).optional(),
  outputDir: z.string().min(1),
  label: z
    .string()
    // Filename-safe AND not a pure-dot segment ('.', '..') — the regex has
    // no '/' so a label can never be a multi-segment path, and the lookahead
    // blocks the only remaining traversal token.
    .regex(/^(?!\.+$)[A-Za-z0-9._-]+$/, 'label must be filename-safe')
    .optional(),
  whiteout: z.array(whiteoutRectSchema).optional(),
  trim: z.boolean().optional(),
});

const seedSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
const cropMoleculeSchema = z.object({
  pdfPath: z.string().min(1),
  page: z.number().int().min(1),
  seeds: z.array(seedSchema).min(1),
  outputDir: z.string().min(1),
  label: z.string().regex(/^(?!\.+$)[A-Za-z0-9._-]+$/).optional(),
  within: bboxSchema.optional(),
  dpi: z.number().int().min(72).max(600).optional(),
  detectDpi: z.number().int().min(72).max(400).optional(),
  threshold: z.number().int().min(1).max(254).optional(),
  dilationPx: z.number().int().min(0).max(64).optional(),
  marginPx: z.number().int().min(0).max(128).optional(),
  seedTolerancePx: z.number().int().min(0).max(64).optional(),
});

type PageInfo = { widthPt: number; heightPt: number; rot: number };

async function readPageInfo(pdfPath: string, page: number): Promise<PageInfo | null> {
  const { stdout } = await execFileAsync('pdfinfo', [
    '-f', String(page), '-l', String(page), pdfPath,
  ]);
  const size = stdout.match(/Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/);
  if (!size) return null;
  const rot = stdout.match(/Page\s+\d+\s+rot:\s+(\d+)/);
  return {
    widthPt: Number(size[1]),
    heightPt: Number(size[2]),
    rot: rot ? Number(rot[1]) : 0,
  };
}

/**
 * Border-pixel advisory: does drawn (non-near-white) ink touch a crop edge?
 * A clipping guardrail for the generous-crop strategy — NOT transcription CV.
 * Scans the outermost `band` rows/cols of the output PNG; an edge flags when
 * its band has > `threshold` fraction of non-near-white pixels.
 */
export async function computeEdgeInk(
  input: string | Buffer,
  band = 3,
  threshold = 0.005,
): Promise<{ top: boolean; right: boolean; bottom: boolean; left: boolean }> {
  const { data, info } = await sharp(input)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const inkAt = (x: number, y: number): boolean => {
    const i = (y * width + x) * channels;
    return !(data[i] >= 245 && data[i + 1] >= 245 && data[i + 2] >= 245);
  };
  const b = Math.max(1, Math.min(band, Math.floor(Math.min(width, height) / 2)));
  // rowFrac/colFrac scan only the MIDDLE of each edge (excluding the corner
  // bands) so an ink stripe on one edge does not spuriously flag the two
  // perpendicular edges via the shared corner pixels.
  const rowFrac = (y: number): number => {
    const midW = width - 2 * b;
    if (midW <= 0) return 0;
    let n = 0;
    for (let x = b; x < width - b; x++) if (inkAt(x, y)) n++;
    return n / midW;
  };
  const colFrac = (x: number): number => {
    const midH = height - 2 * b;
    if (midH <= 0) return 0;
    let n = 0;
    for (let y = b; y < height - b; y++) if (inkAt(x, y)) n++;
    return n / midH;
  };
  let top = 0, bottom = 0, left = 0, right = 0;
  for (let k = 0; k < b; k++) {
    top = Math.max(top, rowFrac(k));
    bottom = Math.max(bottom, rowFrac(height - 1 - k));
    left = Math.max(left, colFrac(k));
    right = Math.max(right, colFrac(width - 1 - k));
  }
  return {
    top: top > threshold,
    right: right > threshold,
    bottom: bottom > threshold,
    left: left > threshold,
  };
}

/**
 * Trim the uniform white border off a crop, then re-add a small uniform white
 * margin. The deterministic tightening half of the generous-crop-then-mask path:
 * the agent crops loose (never clipping own ink) and whites out separated foreign
 * ink; this removes the leftover white margin so the result is tight AND complete.
 * Trim only ever removes white, so own ink can never be clipped by it. Returns a
 * no-op (`applied:false`, the input buffer unchanged) when there is no white border
 * to remove — an all-white crop, or content that already fills the frame. `marginPx`
 * is re-added on every side after a successful trim; `offset*Px` are the pixels
 * removed from the left / top edges (for manifest provenance).
 */
export async function trimToContent(
  input: Buffer,
  marginPx: number,
  threshold = TRIM_THRESHOLD,
): Promise<{
  buffer: Buffer;
  applied: boolean;
  offsetLeftPx: number;
  offsetTopPx: number;
  contentWidthPx: number;
  contentHeightPx: number;
}> {
  const meta = await sharp(input).metadata();
  const w0 = meta.width ?? 0;
  const h0 = meta.height ?? 0;
  const noop = {
    buffer: input,
    applied: false,
    offsetLeftPx: 0,
    offsetTopPx: 0,
    contentWidthPx: w0,
    contentHeightPx: h0,
  };
  try {
    const { data, info } = await sharp(input)
      .trim({ background: '#ffffff', threshold })
      .toBuffer({ resolveWithObject: true });
    // Nothing removed → no white border (all-white crop, or content fills frame).
    if (info.width === w0 && info.height === h0) return noop;
    const buffer = marginPx > 0
      ? await sharp(data)
          .extend({ top: marginPx, bottom: marginPx, left: marginPx, right: marginPx, background: '#ffffff' })
          .png()
          .toBuffer()
      : await sharp(data).png().toBuffer();
    return {
      buffer,
      applied: true,
      offsetLeftPx: -(info.trimOffsetLeft ?? 0),
      offsetTopPx: -(info.trimOffsetTop ?? 0),
      contentWidthPx: info.width,
      contentHeightPx: info.height,
    };
  } catch {
    return noop; // defensive: any trim failure → ship the untrimmed crop
  }
}

export const pdfTools: ToolDefinition[] = [
  {
    name: 'render_pdf_region',
    description:
      'Rasterize one page of a PDF (or a region of it) to a PNG on disk via poppler pdftoppm. ' +
      'Without `bbox`, renders the FULL page at 150 DPI — Read the returned path to locate drawn ' +
      'structures. With `bbox` ({x0,y0,x1,y1}, normalized 0-1, top-left origin), renders just that ' +
      'region at 400 DPI — use it to cut one structure into a standalone image. Estimate bbox as ' +
      'fractions of the page you viewed (downscaling-proof); after each crop, Read it and adjust: ' +
      'expand if a label is clipped at an edge, shrink if neighboring ink intruded. Returns the ' +
      'output path plus pixel geometry (regionWidthPx/regionHeightPx = ACTUAL rendered pixels; ' +
      'pixelRect = REQUESTED clamped rect). `label` overrides the output filename (use neutral ' +
      'names like mol-1, never chemistry names). Keep full-page renders at the default 150 DPI — ' +
      'a letter page at 600 DPI is ~34 megapixels; raise dpi only on bbox region crops. ' +
      'Pass whiteout rects (crop-relative 0-1) to erase foreign ink after a generous crop. ' +
      'Returns edgeInk {top,right,bottom,left} flagging ink that touches a crop edge (you clipped — expand that edge). ' +
      'Pass trim:true to deterministically tighten the crop to its content (removes the white margin, re-adds a small one) — the recommended path is: crop generously, whiteout separated foreign ink, then trim. ' +
      'Stateless: requires explicit outputDir; never touches image-rebuild row state. ' +
      'Example: { "pdfPath": "/abs/paper.pdf", "page": 2, "bbox": {"x0":0.04,"y0":0.09,"x1":0.23,"y1":0.18}, "outputDir": "/abs/out" }',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: { type: 'string', minLength: 1, description: 'Absolute path to the source PDF.' },
        page: { type: 'integer', minimum: 1, description: '1-based page number.' },
        bbox: {
          type: 'object',
          properties: {
            x0: { type: 'number', minimum: 0, maximum: 1 },
            y0: { type: 'number', minimum: 0, maximum: 1 },
            x1: { type: 'number', minimum: 0, maximum: 1 },
            y1: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['x0', 'y0', 'x1', 'y1'],
          additionalProperties: false,
          description:
            'Normalized region (fractions of page width/height, top-left origin, y-down). Omit for the full page.',
        },
        dpi: {
          type: 'integer', minimum: 72, maximum: 600,
          description: 'Override DPI. Defaults: 150 full-page, 400 region.',
        },
        outputDir: { type: 'string', minLength: 1, description: 'Absolute directory for the output PNG (created if missing).' },
        label: {
          type: 'string',
          pattern: '^(?!\\.+$)[A-Za-z0-9._-]+$',
          description: 'Optional filename stem override (filename-safe, no extension). Default: page-<n> or page-<n>-crop-<x>_<y>_<w>x<h>.',
        },
        whiteout: {
          type: 'array',
          description:
            'Optional rectangles to paint WHITE after cropping, to erase foreign ink (a neighbor molecule\'s atoms, a caption, an arrow). Coords are CROP-RELATIVE normalized 0-1 (fractions of the cropped region you see via Read), NOT page coords. Crop generously so the molecule is never clipped, then whiteout intruding ink.',
          items: {
            type: 'object',
            properties: {
              x0: { type: 'number', minimum: 0, maximum: 1 },
              y0: { type: 'number', minimum: 0, maximum: 1 },
              x1: { type: 'number', minimum: 0, maximum: 1 },
              y1: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: ['x0', 'y0', 'x1', 'y1'],
            additionalProperties: false,
          },
        },
        trim: {
          type: 'boolean',
          description:
            'When true, after cropping (and any whiteout) trim the uniform white border down to the drawn content, then re-add a small white margin — a deterministic tight-but-complete crop that can never clip own ink (trim only removes white). Recommended path: crop generously, whiteout SEPARATED foreign ink, then trim. edgeInk is still measured on the PRE-trim crop, so it keeps flagging a genuine clip (ink at the rendered boundary). Default false.',
        },
      },
      required: ['pdfPath', 'page', 'outputDir'],
      additionalProperties: false,
    },
    inputValidator: renderPdfRegionSchema,
    run: async (_runtime, args) => {
      const parsed = renderPdfRegionSchema.parse(args);
      if (!path.isAbsolute(parsed.pdfPath) || !path.isAbsolute(parsed.outputDir)) {
        return {
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'pdfPath and outputDir must be absolute paths.' },
        };
      }
      if (!existsSync(parsed.pdfPath)) {
        return {
          ok: false,
          error: { code: 'PDF_NOT_FOUND', message: `No file at ${parsed.pdfPath}` },
        };
      }
      if (parsed.bbox && (parsed.bbox.x1 <= parsed.bbox.x0 || parsed.bbox.y1 <= parsed.bbox.y0)) {
        return {
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'bbox must have x1 > x0 and y1 > y0.' },
        };
      }
      if (parsed.whiteout) {
        for (const r of parsed.whiteout) {
          if (r.x1 <= r.x0 || r.y1 <= r.y0) {
            return {
              ok: false,
              error: { code: 'INVALID_INPUT', message: 'whiteout rects must have x1 > x0 and y1 > y0.' },
            };
          }
        }
      }

      const dpi = parsed.dpi ?? (parsed.bbox ? CROP_DPI : LOCATE_DPI);

      let info: PageInfo | null;
      try {
        info = await readPageInfo(parsed.pdfPath, parsed.page);
      } catch (error) {
        // Out-of-range page: pdfinfo exits 99 with "Wrong page range given"
        // (verified empirically, poppler 24.02).
        if ((error as Error).message.includes('Wrong page range')) {
          return {
            ok: false,
            error: { code: 'PAGE_OUT_OF_RANGE', message: `Page ${parsed.page} not in document.` },
          };
        }
        const code = (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'POPPLER_MISSING'
          : 'PDF_RENDER_FAILED';
        return {
          ok: false,
          error: {
            code,
            message:
              code === 'POPPLER_MISSING'
                ? 'pdfinfo/pdftoppm not found — install poppler-utils (apt install poppler-utils / brew install poppler).'
                : `pdfinfo failed: ${(error as Error).message}`,
          },
        };
      }
      if (!info) {
        return {
          ok: false,
          error: { code: 'PAGE_OUT_OF_RANGE', message: `Page ${parsed.page} not in document.` },
        };
      }

      // Poppler rounds rendered dims UP (observed: 1265.43 -> 1266), and
      // /Rotate 90|270 swaps the rendered axes relative to the mediabox.
      const rotated = info.rot === 90 || info.rot === 270;
      const pageWidthPx = Math.ceil(((rotated ? info.heightPt : info.widthPt) / 72) * dpi);
      const pageHeightPx = Math.ceil(((rotated ? info.widthPt : info.heightPt) / 72) * dpi);

      let pixelRect: { x: number; y: number; w: number; h: number } | null = null;
      const popplerArgs = [
        '-png', '-singlefile',
        '-r', String(dpi),
        '-f', String(parsed.page), '-l', String(parsed.page),
      ];
      if (parsed.bbox) {
        const x = Math.max(0, Math.min(pageWidthPx - 1, Math.round(parsed.bbox.x0 * pageWidthPx)));
        const y = Math.max(0, Math.min(pageHeightPx - 1, Math.round(parsed.bbox.y0 * pageHeightPx)));
        const w = Math.max(1, Math.min(pageWidthPx - x, Math.round((parsed.bbox.x1 - parsed.bbox.x0) * pageWidthPx)));
        const h = Math.max(1, Math.min(pageHeightPx - y, Math.round((parsed.bbox.y1 - parsed.bbox.y0) * pageHeightPx)));
        pixelRect = { x, y, w, h };
        popplerArgs.push('-x', String(x), '-y', String(y), '-W', String(w), '-H', String(h));
      }

      const stem = parsed.label
        ?? (pixelRect
          ? `page-${parsed.page}-crop-${pixelRect.x}_${pixelRect.y}_${pixelRect.w}x${pixelRect.h}`
          : `page-${parsed.page}`);
      mkdirSync(parsed.outputDir, { recursive: true });
      // Unique temp stem → atomic rename, so concurrent calls that share a
      // default stem never expose a torn PNG (same-dir rename is atomic).
      const tmpStem = path.join(
        parsed.outputDir,
        `.tmp-${process.pid}-${renderSeq++}-${stem}`,
      );

      try {
        await execFileAsync('pdftoppm', [...popplerArgs, parsed.pdfPath, tmpStem]);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'POPPLER_MISSING'
          : 'PDF_RENDER_FAILED';
        return {
          ok: false,
          error: {
            code,
            message:
              code === 'POPPLER_MISSING'
                ? 'pdftoppm not found — install poppler-utils (apt install poppler-utils / brew install poppler).'
                : `pdftoppm failed: ${(error as Error).message}`,
          },
        };
      }

      const outputPath = path.join(parsed.outputDir, `${stem}.png`);
      const rendered = `${tmpStem}.png`;
      const hasWhiteout = !!(parsed.whiteout && parsed.whiteout.length > 0);

      let edgeInk: { top: boolean; right: boolean; bottom: boolean; left: boolean };
      let trim: {
        applied: boolean;
        offsetLeftPx: number;
        offsetTopPx: number;
        contentWidthPx: number;
        contentHeightPx: number;
        marginPx: number;
      } | null = null;

      if (!hasWhiteout && !parsed.trim) {
        // Fast path: no compositing, no re-encode — atomic same-dir rename.
        renameSync(rendered, outputPath);
        edgeInk = await computeEdgeInk(outputPath);
      } else {
        // Build the pre-trim crop in memory (whiteout composited if requested).
        let preTrim: Buffer;
        if (hasWhiteout) {
          const dims = await sharp(rendered).metadata();
          const W = dims.width ?? 0;
          const H = dims.height ?? 0;
          const overlays = parsed.whiteout!.map((r) => {
            const left = Math.max(0, Math.min(W - 1, Math.round(r.x0 * W)));
            const top = Math.max(0, Math.min(H - 1, Math.round(r.y0 * H)));
            const w = Math.max(1, Math.min(W - left, Math.round((r.x1 - r.x0) * W)));
            const h = Math.max(1, Math.min(H - top, Math.round((r.y1 - r.y0) * H)));
            return {
              input: { create: { width: w, height: h, channels: 3 as const, background: '#ffffff' } },
              left,
              top,
            };
          });
          preTrim = await sharp(rendered).composite(overlays).png().toBuffer();
        } else {
          preTrim = await sharp(rendered).png().toBuffer();
        }
        unlinkSync(rendered);
        // edgeInk is measured on the GENEROUS (pre-trim) crop, where "ink at an
        // edge" still means "you clipped own ink". Trim tightens to content, which
        // would make a post-trim edgeInk meaningless (ink would touch every edge).
        edgeInk = await computeEdgeInk(preTrim);
        let finalBuf = preTrim;
        if (parsed.trim) {
          const t = await trimToContent(preTrim, TRIM_MARGIN_PX);
          finalBuf = t.buffer;
          trim = {
            applied: t.applied,
            offsetLeftPx: t.offsetLeftPx,
            offsetTopPx: t.offsetTopPx,
            contentWidthPx: t.contentWidthPx,
            contentHeightPx: t.contentHeightPx,
            marginPx: t.applied ? TRIM_MARGIN_PX : 0,
          };
        }
        writeFileSync(outputPath, finalBuf);
      }

      const meta = await sharp(outputPath).metadata(); // actual dims — never trust predicted math
      if (!meta.width || !meta.height) {
        return {
          ok: false,
          error: { code: 'PDF_RENDER_FAILED', message: 'Rendered PNG is unreadable.' },
        };
      }
      return {
        ok: true,
        data: {
          path: outputPath,
          page: parsed.page,
          dpi,
          regionWidthPx: meta.width,
          regionHeightPx: meta.height,
          pageWidthPx,
          pageHeightPx,
          pixelRect,
          pageRot: info.rot,
          edgeInk,
          trim,
          whiteout: parsed.whiteout ?? [],
        },
      };
    },
  },
  {
    name: 'crop_molecule',
    description:
      'Crop ONE drawn molecule out of a PDF by pointing at it. Give seeds (1+ normalized {x,y} points on the molecule); ' +
      'the tool snaps to the connected ink component(s) at those points, masks out everything else (neighbors, captions, ' +
      'arrows), and writes a tight PNG that includes every bond/label of that molecule and nothing separated from it. ' +
      'A label can never be clipped (it is part of the component). Add a second seed to pull in a label drawn with a big ' +
      'gap; add `within` (a loose box, edges in whitespace) only to cut a neighbor that is physically bridged to yours. ' +
      'Stateless; requires absolute outputDir; needs poppler-utils.',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: { type: 'string', minLength: 1, description: 'Absolute path to the source PDF.' },
        page: { type: 'integer', minimum: 1, description: '1-based page number.' },
        seeds: {
          type: 'array', minItems: 1,
          description: 'Normalized {x,y} points (0-1, top-left origin) on the target molecule. One is usually enough; add more to union a far-flung label.',
          items: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } }, required: ['x', 'y'], additionalProperties: false },
        },
        outputDir: { type: 'string', minLength: 1, description: 'Absolute output directory (created if missing).' },
        label: { type: 'string', pattern: '^(?!\\.+$)[A-Za-z0-9._-]+$', description: 'Output filename stem (no extension).' },
        within: { type: 'object', properties: { x0: { type: 'number', minimum: 0, maximum: 1 }, y0: { type: 'number', minimum: 0, maximum: 1 }, x1: { type: 'number', minimum: 0, maximum: 1 }, y1: { type: 'number', minimum: 0, maximum: 1 } }, required: ['x0', 'y0', 'x1', 'y1'], additionalProperties: false, description: 'Optional loose clip box (normalized) to cut a bridged neighbor. Make it generous; edges should fall in whitespace.' },
        dpi: { type: 'integer', minimum: 72, maximum: 600, description: 'Final crop DPI (default 400).' },
        detectDpi: { type: 'integer', minimum: 72, maximum: 400, description: 'Detection-pass DPI (default 200).' },
        threshold: { type: 'integer', minimum: 1, maximum: 254, description: 'Ink cutoff (default 180).' },
        dilationPx: { type: 'integer', minimum: 0, maximum: 64, description: 'Gap-bridge radius at detect DPI (default 6).' },
        marginPx: { type: 'integer', minimum: 0, maximum: 128, description: 'White margin around the molecule (default 12).' },
        seedTolerancePx: { type: 'integer', minimum: 0, maximum: 64, description: 'If a seed misses ink, snap to the nearest ink within this many DETECT-resolution px (default 0 = off; ~12 helps when seeding near a ring center).' },
      },
      required: ['pdfPath', 'page', 'seeds', 'outputDir'],
      additionalProperties: false,
    },
    inputValidator: cropMoleculeSchema,
    run: async (_runtime, args) => {
      const parsed = cropMoleculeSchema.parse(args);
      if (!path.isAbsolute(parsed.pdfPath) || !path.isAbsolute(parsed.outputDir)) {
        return { ok: false, error: { code: 'INVALID_INPUT', message: 'pdfPath and outputDir must be absolute paths.' } };
      }
      if (!existsSync(parsed.pdfPath)) {
        return { ok: false, error: { code: 'PDF_NOT_FOUND', message: `No file at ${parsed.pdfPath}` } };
      }
      if (parsed.within && (parsed.within.x1 <= parsed.within.x0 || parsed.within.y1 <= parsed.within.y0)) {
        return { ok: false, error: { code: 'INVALID_INPUT', message: 'within must have x1 > x0 and y1 > y0.' } };
      }

      const detectDpi = parsed.detectDpi ?? DETECT_DPI;
      const cropDpi = parsed.dpi ?? CROP_DPI;
      const threshold = parsed.threshold ?? SEG_THRESHOLD;
      const dilationPx = parsed.dilationPx ?? SEG_DILATION_PX;
      const marginPx = parsed.marginPx ?? TRIM_MARGIN_PX;

      let info: PageInfo | null;
      try { info = await readPageInfo(parsed.pdfPath, parsed.page); }
      catch (error) {
        if ((error as Error).message.includes('Wrong page range'))
          return { ok: false, error: { code: 'PAGE_OUT_OF_RANGE', message: `Page ${parsed.page} not in document.` } };
        const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'POPPLER_MISSING' : 'PDF_RENDER_FAILED';
        return { ok: false, error: { code, message: code === 'POPPLER_MISSING'
          ? 'pdfinfo/pdftoppm not found — install poppler-utils.' : `pdfinfo failed: ${(error as Error).message}` } };
      }
      if (!info) return { ok: false, error: { code: 'PAGE_OUT_OF_RANGE', message: `Page ${parsed.page} not in document.` } };

      const rotated = info.rot === 90 || info.rot === 270;
      const pagePtW = rotated ? info.heightPt : info.widthPt;
      const pagePtH = rotated ? info.widthPt : info.heightPt;

      mkdirSync(parsed.outputDir, { recursive: true });

      // ---- detection pass: full page at detectDpi ----
      const detW = Math.ceil((pagePtW / 72) * detectDpi);
      const detH = Math.ceil((pagePtH / 72) * detectDpi);
      const detStem = path.join(parsed.outputDir, `.tmp-${process.pid}-${renderSeq++}-detect`);
      try {
        await execFileAsync('pdftoppm', ['-png', '-singlefile', '-r', String(detectDpi),
          '-f', String(parsed.page), '-l', String(parsed.page), parsed.pdfPath, detStem]);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'POPPLER_MISSING' : 'PDF_RENDER_FAILED';
        return { ok: false, error: { code, message: code === 'POPPLER_MISSING' ? 'pdftoppm not found — install poppler-utils.' : `pdftoppm failed: ${(error as Error).message}` } };
      }
      const detPng = `${detStem}.png`;
      const { data: detData, info: detInfo } =
        await sharp(detPng).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      unlinkSync(detPng);
      const dW = detInfo.width, dH = detInfo.height, dC = detInfo.channels;

      void detW; void detH; // computed for documentation; actual dims come from sharp

      const seedsPx = parsed.seeds.map(s => ({ x: s.x * dW, y: s.y * dH }));
      const withinPx = parsed.within ? {
        x0: Math.floor(parsed.within.x0 * dW), y0: Math.floor(parsed.within.y0 * dH),
        x1: Math.ceil(parsed.within.x1 * dW),  y1: Math.ceil(parsed.within.y1 * dH),
      } : null;

      const seg = segmentToKeep(detData as unknown as Uint8Array, dW, dH, dC, seedsPx,
        { threshold, dilationPx, connectivity: 8, withinPx, seedTolerancePx: parsed.seedTolerancePx ?? 0 });
      if (seg.error || !seg.bbox) {
        const code = seg.error === 'WITHIN_CLIPS_ALL' ? 'WITHIN_CLIPS_ALL' : 'NO_INK_AT_SEED';
        const message = seg.error === 'WITHIN_CLIPS_ALL'
          ? 'Ink was found at the seed(s) but the `within` box excluded all of it — expand the within box.'
          : 'No ink at the given seed point(s).';
        return { ok: false, error: { code, message } };
      }

      // normalized bbox (+ inclusive->exclusive) + margin (margin in final px -> normalized)
      const finPageW = Math.ceil((pagePtW / 72) * cropDpi);
      const finPageH = Math.ceil((pagePtH / 72) * cropDpi);
      const mNX = marginPx / finPageW, mNY = marginPx / finPageH;
      const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
      const rx0 = clamp01(seg.bbox.x0 / dW - mNX), ry0 = clamp01(seg.bbox.y0 / dH - mNY);
      const rx1 = clamp01((seg.bbox.x1 + 1) / dW + mNX), ry1 = clamp01((seg.bbox.y1 + 1) / dH + mNY);

      // ---- final pass: render just that rect at cropDpi ----
      const fx = Math.max(0, Math.min(finPageW - 1, Math.round(rx0 * finPageW)));
      const fy = Math.max(0, Math.min(finPageH - 1, Math.round(ry0 * finPageH)));
      const fw = Math.max(1, Math.min(finPageW - fx, Math.round((rx1 - rx0) * finPageW)));
      const fh = Math.max(1, Math.min(finPageH - fy, Math.round((ry1 - ry0) * finPageH)));
      const finStem = path.join(parsed.outputDir, `.tmp-${process.pid}-${renderSeq++}-final`);
      try {
        await execFileAsync('pdftoppm', ['-png', '-singlefile', '-r', String(cropDpi),
          '-f', String(parsed.page), '-l', String(parsed.page),
          '-x', String(fx), '-y', String(fy), '-W', String(fw), '-H', String(fh), parsed.pdfPath, finStem]);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'POPPLER_MISSING' : 'PDF_RENDER_FAILED';
        return { ok: false, error: { code, message: `pdftoppm failed: ${(error as Error).message}` } };
      }
      const finPng = `${finStem}.png`;
      const { data: finData, info: finI } =
        await sharp(finPng).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      unlinkSync(finPng);

      // resample the detect-res keep mask into the final crop's page-rect, then white out keep==0
      const keepFin = resampleMaskRegion(seg.keep, dW, dH, { x0: rx0, y0: ry0, x1: rx1, y1: ry1 }, finI.width, finI.height);
      const masked = compositeWhiteWhereZero(finData as unknown as Uint8Array, finI.width, finI.height, finI.channels, keepFin);

      const stem = parsed.label ?? `mol-p${parsed.page}-${Math.round(parsed.seeds[0].x * 100)}_${Math.round(parsed.seeds[0].y * 100)}`;
      const outputPath = path.join(parsed.outputDir, `${stem}.png`);
      await sharp(Buffer.from(masked), { raw: { width: finI.width, height: finI.height, channels: finI.channels } })
        .png().toFile(outputPath);

      return {
        ok: true,
        data: {
          path: outputPath, page: parsed.page, dpi: cropDpi,
          regionWidthPx: finI.width, regionHeightPx: finI.height,
          bbox: { x0: rx0, y0: ry0, x1: rx1, y1: ry1 },
          seeds: parsed.seeds, targetComponentCount: seg.targetCount, componentsMaskedOut: seg.maskedOut,
          pageWidthPx: finPageW, pageHeightPx: finPageH, pageRot: info.rot, warnings: [],
        },
      };
    },
  },
];
