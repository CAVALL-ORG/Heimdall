/**
 * Hi-res fixture generator. Operator-driven (run-once after manifest changes;
 * not part of CI). Re-rasterizes the hard-ratchet rows via Indigo so the next
 * ratchet can isolate vision-tier ceiling (low-res original fixtures) from
 * protocol-tier ceiling (synthetic hi-res fixtures).
 *
 * Fixtures must satisfy: mol_bbox_min_side >= 0.8 * canvas_min_side.
 * The generator fails (exit 1) if any rendered fixture is below this
 * threshold after compositing on white.
 *
 * Indigo auto-scales molecules to fill the canvas with default margins.
 * The bbox pixel dimensions are fixed regardless of canvas size (Indigo
 * renders at a fixed internal scale). So fill = bbox_min / canvas_min, and
 * the correct tuning is to REDUCE the canvas until canvas_min <= bbox_min/0.80.
 * Constraint: canvas >= mol bbox dimensions (so the molecule fits).
 *
 * Per-molecule canvas overrides are in RENDER_OVERRIDES below. These were
 * calibrated empirically: measure bbox at 4000×3000 (default), compute
 * target canvas_min = bbox_min / 0.82, set canvas accordingly.
 *
 * Usage:
 *   npx tsx tests/scientific/runner/generate_hires_fixtures.ts A004 A009 A011
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const INDIGO_URL = 'http://127.0.0.1:8002/v2/indigo/render';
const REPO_ROOT = process.cwd();
const MANIFEST_PATH = join(
  REPO_ROOT,
  'tests/ketcher/image-to-smiles/manifest.jsonl',
);
const OUT_DIR = join(REPO_ROOT, 'tests/scientific/images/academic-hires');
const FILL_THRESHOLD = 0.80;

interface RenderOpts {
  /** Canvas width in pixels. */
  width: number;
  /** Canvas height in pixels. */
  height: number;
}

/**
 * Per-row canvas overrides. Tuned so mol_bbox_min_side >= 0.8 * canvas_min_side.
 * Default (no override): 4000×3000.
 *
 * Methodology: Indigo renders molecules at a fixed internal bond scale,
 * auto-centered with margins. The mol bbox size in pixels is INDEPENDENT of
 * canvas size. So fill = bbox_min / canvas_min. To hit ≥80% fill, we shrink
 * the canvas until canvas_min = bbox_min / 0.82 (with a small safety buffer).
 *
 * Calibration (4000×3000 default):
 *   A004: bbox_min=956px → target canvas_min = 956/0.82 = 1165 → canvas 1631×1165
 *   A009: bbox_min=785px → target canvas_min = 785/0.82 = 957  → canvas 1339×957
 *   A011: bbox_min=713px → target canvas_min = 713/0.82 = 869  → canvas 1349×869
 */
const RENDER_OVERRIDES: Record<string, RenderOpts> = {
  A004: { width: 1631, height: 1165 },
  A009: { width: 1339, height: 957 },
  A011: { width: 1349, height: 869 },
};

interface ManifestRow {
  id: string;
  expected_canonical_smiles: string;
  image_path?: string;
  notes?: string;
}

function loadRow(id: string): ManifestRow {
  const text = readFileSync(MANIFEST_PATH, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as ManifestRow;
    if (row.id === id) return row;
  }
  throw new Error(`row ${id} not in manifest`);
}

/**
 * Measure the fill ratio of a rendered PNG, compositing transparent
 * backgrounds onto white before computing the molecule bounding box.
 * Returns: mol_bbox_min_side / canvas_min_side.
 */
async function measureFill(pngPath: string): Promise<number> {
  const meta = await sharp(pngPath).metadata();
  const { width = 1, height = 1 } = meta;

  // Composite on white: flatten RGBA onto white background.
  const composited = await sharp(pngPath)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .grayscale()
    .raw()
    .toBuffer();

  const pixels = new Uint8Array(composited);
  const nRows = height;
  const nCols = width;

  // Find bounding box of "dark" pixels (mol content < threshold 240).
  const DARK = 240;
  let rmin = nRows, rmax = -1, cmin = nCols, cmax = -1;
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      if (pixels[r * nCols + c] < DARK) {
        if (r < rmin) rmin = r;
        if (r > rmax) rmax = r;
        if (c < cmin) cmin = c;
        if (c > cmax) cmax = c;
      }
    }
  }

  if (rmax < 0) return 0; // no molecule content

  const bboxH = rmax - rmin + 1;
  const bboxW = cmax - cmin + 1;
  const canvasMin = Math.min(nRows, nCols);
  const bboxMin = Math.min(bboxH, bboxW);
  const fill = bboxMin / canvasMin;
  console.log(
    `  fill check: bbox=${bboxW}x${bboxH}, canvas=${nCols}x${nRows}, fill=${fill.toFixed(4)}`,
  );
  return fill;
}

async function renderOne(id: string): Promise<void> {
  const row = loadRow(id);
  const overrides = RENDER_OVERRIDES[id];
  const opts: RenderOpts = overrides ?? { width: 4000, height: 3000 };

  const body = {
    struct: row.expected_canonical_smiles,
    output_format: 'image/png',
    options: {
      'render-image-width': opts.width,
      'render-image-height': opts.height,
    },
  };
  const resp = await fetch(INDIGO_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'image/png',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Indigo render failed for ${id}: HTTP ${resp.status}`);
  }
  const png = Buffer.from(await resp.arrayBuffer());
  const pngPath = join(OUT_DIR, `${id}H_hires.png`);
  const licPath = `${pngPath}.LICENSE.txt`;
  writeFileSync(pngPath, png);
  writeFileSync(
    licPath,
    [
      `${id}H`,
      'Source: synthesized via Indigo render of manifest expected_canonical_smiles',
      `Indigo endpoint: ${INDIGO_URL}`,
      `Render dims: ${opts.width}x${opts.height} (tuned for >=80% fill)`,
      `Source SMILES: ${row.expected_canonical_smiles}`,
      'License: derived asset — Indigo render of canonical SMILES; no third-party copyright.',
      `Original fixture: tests/scientific/${row.image_path} (paired control).`,
      `Notes: ${row.notes ?? '(none)'}`,
      '',
    ].join('\n'),
  );
  console.log(`wrote ${pngPath} (${png.length} bytes)`);

  // Fill assertion: fail if mol_bbox_min_side < 0.8 * canvas_min_side.
  const fill = await measureFill(pngPath);
  if (fill < FILL_THRESHOLD) {
    throw new Error(
      `${id}H_hires.png fill=${fill.toFixed(4)} < ${FILL_THRESHOLD}: ` +
      `reduce canvas in RENDER_OVERRIDES (current: ${opts.width}x${opts.height}). ` +
      `target canvas_min <= bbox_min / 0.80`,
    );
  }
  console.log(`  PASS fill=${fill.toFixed(4)} >= ${FILL_THRESHOLD}`);
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error(
      'usage: npx tsx tests/scientific/runner/generate_hires_fixtures.ts <ID> [<ID>...]',
    );
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  let failed = false;
  for (const id of ids) {
    try {
      await renderOne(id);
    } catch (err) {
      console.error(`FAIL ${id}:`, err instanceof Error ? err.message : err);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
