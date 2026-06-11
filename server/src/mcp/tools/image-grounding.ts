/**
 * Pixel-grounding helpers for validate_graph (Layer 5 of image-rebuild
 * protocol v3). Backend interpreter primitives — extract pixel facts
 * from source images so validate_graph can reject drafts that aren't
 * pixel-grounded.
 *
 * All functions read the source PNG via sharp; no canvas state, no
 * Ketcher dependency.
 */

import sharp from 'sharp';

export interface ImageMetadata {
  width: number;
  height: number;
}

export async function imageMetadata(
  imagePath: string,
): Promise<ImageMetadata> {
  const meta = await sharp(imagePath).metadata();
  if (typeof meta.width !== 'number' || typeof meta.height !== 'number') {
    throw new Error(`sharp could not extract dimensions for ${imagePath}`);
  }
  return { width: meta.width, height: meta.height };
}

/**
 * Mean grayscale intensity in an N×N patch centered at (x, y).
 * Returns [0, 1] where 1 = pure white, 0 = pure black.
 * Out-of-bounds region treated as white.
 */
export async function samplePatch(
  imagePath: string,
  x: number,
  y: number,
  size: number,
): Promise<number> {
  const meta = await imageMetadata(imagePath);
  const half = Math.floor(size / 2);
  // sharp's extract requires integer geometry; declared coords may be
  // fractional, so floor the window origin and clamp to the canvas.
  const left = Math.max(0, Math.floor(x - half));
  const top = Math.max(0, Math.floor(y - half));
  const w = Math.min(size, meta.width - left);
  const h = Math.min(size, meta.height - top);
  if (w <= 0 || h <= 0) return 1.0;
  const { data, info } = await sharp(imagePath)
    .extract({ left, top, width: w, height: h })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    sum += data[i] / 255;
  }
  return sum / (info.width * info.height);
}

/**
 * Minimum mean intensity of a 5×5 patch over a small neighborhood around
 * (x, y), searched on a coarse grid out to ±`radius` pixels. Returns the
 * darkest patch found (lower = more ink nearby); 1.0 = the whole
 * neighborhood is white.
 *
 * Purpose: soften the `vertex_not_visible_at_coord` VERDICT only. A by-eye
 * declared coord routinely lands a few pixels off the drawn stroke; if ink
 * sits within ~10–15px the vertex IS visible and should not be flagged. This
 * is a READ-ONLY check — it never returns or mutates a coordinate, so it can
 * never become a "snap the agent's coords for them" feature. The caller keeps
 * the agent's declared coord verbatim and only uses this min to decide
 * whether to suppress the not-visible diagnostic.
 *
 * Step size is 5px so consecutive 5×5 patches tile the neighborhood without
 * gaps. The center (offset 0,0) reproduces the existing 5px center read.
 */
export async function minPatchInNeighborhood(
  imagePath: string,
  x: number,
  y: number,
  radius: number,
): Promise<number> {
  const STEP = 5;
  let min = 1.0;
  for (let dy = -radius; dy <= radius; dy += STEP) {
    for (let dx = -radius; dx <= radius; dx += STEP) {
      const mean = await samplePatch(imagePath, x + dx, y + dy, 5);
      if (mean < min) min = mean;
      // Early exit: any clearly-inked patch is enough to call it visible.
      if (min <= 0.95) return min;
    }
  }
  return min;
}

/**
 * Fraction of N evenly-spaced points along the line from (x1, y1) to
 * (x2, y2) whose local 3×3 patch is "mostly white" (mean > 0.90).
 * Returns [0, 1] where 1 = entire line traverses white pixels.
 */
export async function sampleBondLine(
  imagePath: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  samples: number,
): Promise<number> {
  let whiteCount = 0;
  for (let i = 1; i <= samples; i++) {
    const t = i / (samples + 1);
    const px = Math.round(x1 + t * (x2 - x1));
    const py = Math.round(y1 + t * (y2 - y1));
    const mean = await samplePatch(imagePath, px, py, 3);
    if (mean > 0.9) whiteCount++;
  }
  return whiteCount / samples;
}

// ── Direction B: pixels → declarations (Wave-2 Task 4B) ───────────────

/** A declared atom with its pixel-space coordinate. */
export interface DeclaredAtomCoord {
  id: number | string;
  x: number;
  y: number;
}

/**
 * An ink region in the source image that no declared atom explains. Emitted
 * as an ADVISORY crop target so the agent can zoom the missed region — it
 * never blocks a build and never hard-fails validation.
 */
export interface UnexplainedInkRegion {
  /** Grid-cell-center x in pixel space. */
  x_center: number;
  /** Grid-cell-center y in pixel space. */
  y_center: number;
  /** Suggested crop half-side: scaled to the cell so the zoom covers it. */
  bbox_radius: number;
  /** Fraction of dark pixels in the flagged cell, in [0, 1]. */
  ink_density: number;
}

// ── Detector tuning (FP=0 gated; see detect-unexplained-ink.test.ts) ──
//
// Calibrated so a correctly + fully declared DENSE molecule (paclitaxel,
// the A004H_hires fixture, 62 atoms) yields 0 unexplained regions while a
// 6-atom fragment of the same molecule yields ≥3. Measured margins on the
// committed fixture: full-declare → 0 unexplained / 82 ink cells (robust to
// ±6px coord jitter across seeds); 6-atom fragment → 68 unexplained.
//
//   GRID_SIZE_PX        — cell side in pixels.
//   INK_DENSITY_FLOOR   — min dark-pixel fraction for a cell to count as ink.
//   PROXIMITY_BOND_MULT — a cell is "explained" if a declared atom lies
//                         within this multiple of the declared median bond
//                         length of the cell center. Scaling by bond length
//                         makes the radius image-resolution-relative: in a
//                         correct molecule every ink pixel is within ~1 bond
//                         length of some vertex (bonds connect vertices), so
//                         only genuinely-missed ink survives the proximity
//                         test.
const GRID_SIZE_PX = 80;
const INK_DENSITY_FLOOR = 0.03;
const PROXIMITY_BOND_MULT = 1.25;
const DARK_PIXEL_CUTOFF = 200; // grayscale < this counts as ink (drawn stroke)
// Fallback proximity radius (px) when there are too few declared atoms to
// estimate a bond length (e.g. a 1-atom draft). Generous so a sparse but
// correct draft is not over-flagged; the TP signal comes from dense cores.
const PROXIMITY_FALLBACK_PX = 120;

/**
 * Median nearest-neighbor distance among declared atoms — a proxy for the
 * drawing's bond length in pixel space, without needing the bond list.
 */
function medianNearestNeighbor(atoms: DeclaredAtomCoord[]): number {
  if (atoms.length < 2) return 0;
  const nn: number[] = [];
  for (let i = 0; i < atoms.length; i++) {
    let best = Infinity;
    for (let j = 0; j < atoms.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(atoms[i].x - atoms[j].x, atoms[i].y - atoms[j].y);
      if (d < best) best = d;
    }
    if (Number.isFinite(best)) nn.push(best);
  }
  if (nn.length === 0) return 0;
  nn.sort((a, b) => a - b);
  return nn[nn.length >> 1];
}

/**
 * Direction B of the bidirectional pixel pass: find regions of ink in the
 * source image that NO declared atom explains.
 *
 * Grids the image into `GRID_SIZE_PX` cells, computes ink density per cell,
 * and flags a cell as "unexplained" when it has ink density ≥
 * `INK_DENSITY_FLOOR` AND no declared atom lies within
 * `PROXIMITY_BOND_MULT × medianBondLength` of the cell center.
 *
 * This is the pixels→declarations authority: unexplained ink marks a region
 * the agent may have missed. ADVISORY ONLY — the caller emits these as crop
 * targets; nothing here blocks a build or hard-fails.
 *
 * FP=0 GATE: a correctly + fully declared molecule (including dense cores)
 * returns []. Tuning constants are gated by detect-unexplained-ink.test.ts.
 */
export async function detectUnexplainedInkRegions(
  imagePath: string,
  declaredAtoms: DeclaredAtomCoord[],
): Promise<UnexplainedInkRegion[]> {
  const { data, info } = await sharp(imagePath)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;

  const med = medianNearestNeighbor(declaredAtoms);
  const proximityR =
    med > 0 ? PROXIMITY_BOND_MULT * med : PROXIMITY_FALLBACK_PX;

  const regions: UnexplainedInkRegion[] = [];
  const cols = Math.ceil(W / GRID_SIZE_PX);
  const rows = Math.ceil(H / GRID_SIZE_PX);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * GRID_SIZE_PX;
      const y0 = cy * GRID_SIZE_PX;
      const x1 = Math.min(W, x0 + GRID_SIZE_PX);
      const y1 = Math.min(H, y0 + GRID_SIZE_PX);
      let dark = 0;
      let total = 0;
      for (let y = y0; y < y1; y++) {
        const rowBase = y * W;
        for (let x = x0; x < x1; x++) {
          total++;
          if (data[(rowBase + x) * ch] < DARK_PIXEL_CUTOFF) dark++;
        }
      }
      if (total === 0) continue;
      const density = dark / total;
      if (density < INK_DENSITY_FLOOR) continue;

      const ccx = (x0 + x1) / 2;
      const ccy = (y0 + y1) / 2;
      let explained = false;
      for (const a of declaredAtoms) {
        if (Math.hypot(a.x - ccx, a.y - ccy) <= proximityR) {
          explained = true;
          break;
        }
      }
      if (explained) continue;

      regions.push({
        x_center: ccx,
        y_center: ccy,
        bbox_radius: GRID_SIZE_PX / 2,
        ink_density: density,
      });
    }
  }
  return regions;
}

/**
 * Count connected dark components in an Otsu-binarized source image
 * via 4-connected flood fill. Components below MIN_AREA (25 px) are
 * dropped as noise.
 */
export async function countConnectedComponents(
  imagePath: string,
  blackThreshold: number,
): Promise<number> {
  const { data, info } = await sharp(imagePath)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const fg = new Uint8Array(W * H);
  const cutoff = Math.floor(blackThreshold * 255);
  for (let i = 0; i < W * H; i++) {
    fg[i] = data[i * info.channels] < cutoff ? 1 : 0;
  }
  const visited = new Uint8Array(W * H);
  const MIN_AREA = 25;
  let components = 0;
  const stack: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (!fg[idx] || visited[idx]) continue;
      let area = 0;
      stack.push(idx);
      visited[idx] = 1;
      while (stack.length > 0) {
        const cur = stack.pop()!;
        area++;
        const cx = cur % W;
        const cy = (cur - cx) / W;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const nidx = ny * W + nx;
          if (fg[nidx] && !visited[nidx]) {
            visited[nidx] = 1;
            stack.push(nidx);
          }
        }
      }
      if (area >= MIN_AREA) components++;
    }
  }
  return components;
}
