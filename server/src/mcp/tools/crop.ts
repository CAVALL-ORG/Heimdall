/**
 * LOCK 1 — `crop_source_image` MCP tool.
 *
 * Writes a deterministic PNG crop of the source image and returns its
 * absolute path. The multimodal agent then `Read`s that path to see the
 * region at higher effective attention.
 *
 * Crop dimensions (LOCK 1):
 *   - Square N×N.
 *   - N ∈ [150, 800] (printed). Hand-drawn input (LOCK 26) gets the same
 *     range but a 10-crop cap instead of 6 (enforced at orchestrator layer
 *     via grader iteration_budget_gate, LOCK 2).
 *   - Out-of-bounds regions pad with white (do not clamp center).
 *
 * Upsample handling:
 *   - source `min(w, h) < 300px` → return source_too_small error;
 *     agent refuses with `source_resolution_too_low` (LOCK 21 reason 11).
 *   - upsample bicubic when `requestedN < 1000` (captured real-source px
 *     below target); output is 1000×1000 with filename suffix `_up.png`.
 *     Old dual-gate (ratio < 0.6 AND requestedN < 600) had a magnification
 *     cliff: large-source / large-crop combos got no magnification. New
 *     policy: any crop capturing fewer than 1000 real source pixels is
 *     upsampled to 1000. Tile budget bills captured pixels, not output size.
 *
 * Error partition (LOCK 25):
 *   - agent_input_error: coords out of bounds, N out of [150, 800], non-square.
 *     These count toward LOCK 2's 6-crop cap (grader enforces).
 *   - backend_internal_error: sharp OOM, disk failure, source file missing.
 *     Tool retries once silently; second failure returns `tool_unavailable`
 *     with `count_consumed: false`.
 *
 * Pure side-effect (file write). No canvas state mutation. No runtime state.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import type { ToolDefinition } from './types';
import {
  appendSessionEvent,
  nearestTarget,
  proximityHit,
  readUnresolvedTargets,
  scrubAgentText,
  SCRUB_TELEMETRY_ENABLED,
} from './row-state';
import { computeInkRecenter } from './crop-recenter';

// T1 — crop-after-validate enforcement. Default ON in Phase 2.
const CROP_AFTER_VALIDATE_ENABLED = () =>
  process.env.KETCHER_CROP_AFTER_VALIDATE !== '0';

const cropInputSchema = z.object({
  rowId: z.string().min(1),
  sourceImagePath: z.string().min(1),
  outputDir: z.string().min(1).optional(),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  w: z.number().int().min(1).optional(),
  h: z.number().int().min(1).optional(),
  width: z.number().int().min(1).optional(),
  height: z.number().int().min(1).optional(),
});

const MIN_N = 150;
const MAX_N = 1200;

/**
 * Coerce an agent's crop-dimension request into a single valid square side N.
 * Forgiving by design (C1): accepts width/height aliases for w/h, auto-squares a
 * non-square request to min, and clamps to [MIN_N, MAX_N]. Pure + unit-tested.
 */
export function coerceCropDims(args: {
  w?: number;
  h?: number;
  width?: number;
  height?: number;
}): { n: number; coerced: string | null } {
  const w = args.w ?? args.width;
  const h = args.h ?? args.height;
  if (w === undefined || h === undefined) {
    throw new Error('crop requires w/h (or width/height)');
  }
  const notes: string[] = [];
  let n = Math.min(w, h);
  if (w !== h) notes.push(`auto-squared w=${w} h=${h} -> ${n}`);
  const clamped = Math.max(MIN_N, Math.min(MAX_N, n));
  if (clamped !== n) notes.push(`clamped ${n} -> ${clamped} (valid range [${MIN_N},${MAX_N}])`);
  n = clamped;
  return { n, coerced: notes.length ? notes.join('; ') : null };
}

const LOWRES_HARD_FLOOR = 300; // < 300 → refuse
// Phase 1 Task A (revised): upsample whenever the captured real-source
// pixels are below the target. Old dual-gate (ratio < 0.6 AND requestedN <
// 600) had a magnification cliff: large sources with a large-but-fractional
// crop (e.g. 4000px source, 800px crop) got zero magnification because
// requestedN >= old UPSAMPLE_TARGET even though 800px is still too small for
// a dense polycycle. New policy: upsample = capturedRealPx < UPSAMPLE_TARGET
// where capturedRealPx = requestedN (the real source pixels captured by the
// crop window). Output side = UPSAMPLE_TARGET.
const UPSAMPLE_TARGET = 1000;
const TILE_BUDGET_PER_ROW = 50; // LOCK 30 — simple-row over-crop backstop
// Dense-gated cap. The flat 50 is a runaway/over-crop backstop, NOT a
// correctness gate — but it is too tight for a fused polycyclic core and does
// not scale with structure. The dense protocol legitimately prescribes ONE
// whole-core survey crop (~ceil(1400/200)²≈49 tiles on a large hires core) PLUS
// one crop per ring (~7×9≈63) PLUS one per-center stereo crop (~12×6≈72) ≈ 184
// legitimate tiles. Under the flat 50, that demand is cut off mid-Stage-B and
// the agent is forced to guess an unread wedge (the A004H "C5" flip,
// agent-orch-<run-id>). Dense rows get a budget sized to that demand
// (~184 → 200 with margin); simple rows keep 50. The runtime session watchdog
// (not this counter) is the ultimate runaway net.
const TILE_BUDGET_DENSE = 200;

// Cap is dense-gated off the `dense` flag the validate sidecar already persists
// (isDenseCandidate: heavy >= 18, LATCHED across rounds). Read fresh each crop so
// the cap tracks the latest draft.
function tileBudgetCapFor(outputDir: string): number {
  return readUnresolvedTargets(outputDir)?.dense
    ? TILE_BUDGET_DENSE
    : TILE_BUDGET_PER_ROW;
}

// LOCK 30 sidecar — per-row cumulative tile-count counter. Lives in the same
// crops directory the agent already writes to. Single line: integer.
const TILE_BUDGET_SIDECAR = '_tile_budget.txt';

function readTileBudget(outputDir: string): number {
  const path = join(outputDir, TILE_BUDGET_SIDECAR);
  if (!existsSync(path)) return 0;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeTileBudget(outputDir: string, total: number): void {
  const path = join(outputDir, TILE_BUDGET_SIDECAR);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${total}\n`, 'utf8');
}

type CropResult =
  | {
      kind: 'ok';
      path: string;
      upsampled: boolean;
      tile_count: number;
      tile_budget_used: number;
      tile_budget_remaining: number;
      dimensions: { n: number; sourceWidth: number; sourceHeight: number };
      // Source-frame window this crop captured. (x,y) is the CENTER of the
      // crop, so left/top = centerX/Y − floor(N/2). The FULL window is
      // reported (NOT clamped to source bounds): left/top MAY be negative
      // when the window runs off the source — that region is the white pad,
      // and the back-map stays exact. Back-map a crop pixel (px,py) to source:
      //   source_x = left + px·(capturedN/outputN)
      //   source_y = top  + py·(capturedN/outputN)
      window: { left: number; top: number; right: number; bottom: number };
      capturedN: number; // real source pixels captured per side (== requestedN)
      outputN: number; // emitted PNG side (finalN: 1000 if upsampled, else N)
      // F3 (dense-gated): ink centroid of the captured window in source coords,
      // and whether the window was recentered on it. Absent on non-dense rows.
      ink_centroid_source?: { x: number; y: number };
      ink_fraction?: number;
      recentered?: boolean;
      // C1 coercion advisory: non-null when w/h were aliased, non-square, or
      // out of range and were silently corrected. Absent when no coercion occurred.
      coerced_to?: string;
    }
  | {
      kind: 'agent_input_error';
      reason: string;
      message: string;
    }
  | {
      kind: 'backend_internal_error';
      reason: string;
      message: string;
      count_consumed: false;
    }
  | {
      kind: 'source_too_small';
      message: string;
      sourceWidth: number;
      sourceHeight: number;
    }
  | {
      kind: 'tile_budget_exhausted';
      message: string;
      tile_budget_used: number;
      tile_count_requested: number;
      count_consumed: false;
    }
  | {
      kind: 'crop_before_validate';
      message: string;
    }
  | {
      kind: 'crop_target_not_named';
      message: string;
      details: { x: number; y: number; w: number; h: number };
    }
  | {
      kind: 'no_pending_targets';
      message: string;
    };

async function readSourceMetadata(
  sourceImagePath: string,
): Promise<{ width: number; height: number }> {
  const meta = await sharp(sourceImagePath).metadata();
  if (!meta.width || !meta.height) {
    throw new Error(`source image missing metadata: ${sourceImagePath}`);
  }
  return { width: meta.width, height: meta.height };
}

async function executeCrop(
  // rowId/outputDir are schema-optional but guaranteed present here: the run
  // handler casts to Required after server.ts's ARGS_DEFAULT_TOOLS write-back.
  // w/h are optional in the schema (aliased from width/height); coerceCropDims
  // resolves the final square side N before any geometry work.
  args: z.infer<typeof cropInputSchema> & { outputDir: string; rowId: string },
): Promise<CropResult> {
  if (!isAbsolute(args.sourceImagePath)) {
    return {
      kind: 'agent_input_error',
      reason: 'non_absolute_source_path',
      message: `sourceImagePath must be absolute: ${args.sourceImagePath}`,
    };
  }
  if (!isAbsolute(args.outputDir)) {
    return {
      kind: 'agent_input_error',
      reason: 'non_absolute_output_dir',
      message: `outputDir must be absolute: ${args.outputDir}`,
    };
  }
  let dimCoercion: string | null;
  let requestedN: number;
  try {
    ({ n: requestedN, coerced: dimCoercion } = coerceCropDims(args));
  } catch (err) {
    return {
      kind: 'agent_input_error',
      reason: 'missing_crop_dimensions',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let sourceMeta: { width: number; height: number };
  try {
    sourceMeta = await readSourceMetadata(args.sourceImagePath);
  } catch (err) {
    return {
      kind: 'backend_internal_error',
      reason: 'source_metadata_read_failed',
      message: err instanceof Error ? err.message : String(err),
      count_consumed: false,
    };
  }

  const minSourceDim = Math.min(sourceMeta.width, sourceMeta.height);
  if (minSourceDim < LOWRES_HARD_FLOOR) {
    const message = SCRUB_TELEMETRY_ENABLED()
      ? 'Source image resolution is too low for reliable crops. Refuse this row with source_resolution_too_low via the refuse tool.'
      : `source image min(w,h)=${minSourceDim} < ${LOWRES_HARD_FLOOR}; agent must refuse with source_resolution_too_low (LOCK 27)`;
    return {
      kind: 'source_too_small',
      message,
      sourceWidth: sourceMeta.width,
      sourceHeight: sourceMeta.height,
    };
  }

  // Compute crop extraction window (with white padding when out of bounds).
  // F3 may recenter (dense rows only), so the center + window are mutable.
  let centerX = args.x;
  let centerY = args.y;
  const half = Math.floor(requestedN / 2);

  // Window + clamped visible region for a given center. Sharp extract requires
  // an in-bounds rectangle; the rest runs off into white pad.
  const windowFor = (cx: number, cy: number) => {
    const wLeft = cx - half;
    const wTop = cy - half;
    const vLeft = Math.max(0, wLeft);
    const vTop = Math.max(0, wTop);
    const vRight = Math.min(sourceMeta.width, wLeft + requestedN);
    const vBottom = Math.min(sourceMeta.height, wTop + requestedN);
    return {
      left: wLeft,
      top: wTop,
      right: wLeft + requestedN,
      bottom: wTop + requestedN,
      visibleLeft: vLeft,
      visibleTop: vTop,
      visibleW: Math.max(0, vRight - vLeft),
      visibleH: Math.max(0, vBottom - vTop),
    };
  };

  let win = windowFor(centerX, centerY);
  if (win.visibleW === 0 || win.visibleH === 0) {
    return {
      kind: 'agent_input_error',
      reason: 'crop_outside_source',
      message: `crop center (${centerX},${centerY}) and N=${requestedN} produce no overlap with source ${sourceMeta.width}x${sourceMeta.height}`,
    };
  }

  // F3 — ink-centroid recenter (DENSE rows only, via the sidecar dense flag).
  // On a dense fused core the agent's per-center/stereo crops cram the feature
  // into a corner at quartered magnification (crop-centering report 2026-06-02);
  // recentering on the ink restores readable framing and raises wedge-polarity
  // read accuracy. FULLY dense-gated: sparse/easy rows skip this block entirely
  // (no compute, byte-identical). Recenter fires only on the crammed-corner
  // signature (small ink fraction AND off-center centroid; see crop-recenter).
  let inkCentroidSource: { x: number; y: number } | undefined;
  let inkFraction: number | undefined;
  let recentered = false;
  const dense = args.outputDir
    ? readUnresolvedTargets(args.outputDir)?.dense === true
    : false;
  if (dense) {
    try {
      const { data: gray, info } = await sharp(args.sourceImagePath)
        .extract({
          left: win.visibleLeft,
          top: win.visibleTop,
          width: win.visibleW,
          height: win.visibleH,
        })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const dec = computeInkRecenter(
        gray,
        info.width,
        info.height,
        win.visibleLeft,
        win.visibleTop,
        centerX,
        centerY,
        requestedN,
      );
      inkCentroidSource = dec.inkCentroidSource ?? undefined;
      inkFraction = dec.inkFraction;
      if (dec.recenter) {
        const moved = windowFor(dec.recenter.centerX, dec.recenter.centerY);
        if (moved.visibleW > 0 && moved.visibleH > 0) {
          centerX = dec.recenter.centerX;
          centerY = dec.recenter.centerY;
          win = moved;
          recentered = true;
        }
      }
    } catch {
      // F3 is best-effort; on any sharp failure fall back to the requested
      // window (no recenter). The main extract below still runs.
    }
  }

  const { left, top, right, bottom, visibleLeft, visibleTop, visibleW, visibleH } = win;

  // Phase 1 Task A (revised): upsample whenever captured real-source pixels
  // are below UPSAMPLE_TARGET. The old dual-gate checked both a ratio
  // threshold and a raw-pixel ceiling, creating a magnification cliff for
  // large sources (e.g. 4000px source + 800px crop: ratio=0.2 passes but
  // requestedN=800 >= old 600 ceiling → no upsample). Drop both gates;
  // the only question is whether the raw captured pixels are below target.
  const upsample = requestedN < UPSAMPLE_TARGET;
  const finalN = upsample ? UPSAMPLE_TARGET : requestedN;

  const suffix = upsample ? '_up' : '';
  const filename = `${args.x}_${args.y}_${requestedN}_${requestedN}${suffix}.png`;
  const outputPath = `${args.outputDir}/${filename}`;

  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    // Extract the visible portion at native resolution, then composite onto
    // a white N×N background at the correct offset relative to the crop
    // window. Finally upsample if low-res.
    const visiblePortion = await sharp(args.sourceImagePath)
      .extract({
        left: visibleLeft,
        top: visibleTop,
        width: visibleW,
        height: visibleH,
      })
      .png()
      .toBuffer();

    const offsetX = visibleLeft - left; // where visible portion sits in the N×N canvas
    const offsetY = visibleTop - top;

    // BAKE the composite to a real raster (png().toBuffer()) BEFORE resizing.
    // sharp applies operations in a FIXED internal order (resize BEFORE
    // composite) regardless of chain order, so a single chained
    // create→composite→resize pipeline resizes the empty white base first and
    // then drops the UN-scaled visiblePortion at offset(0,0) — landing it 1:1
    // in the top-left requestedN-px corner instead of filling the frame
    // (agent-orch-<run-id> A011 bug). The round-trip flattens the
    // composite into a real requestedN×requestedN image so the subsequent
    // resize scales the whole composited frame.
    const composited = await sharp({
      create: {
        width: requestedN,
        height: requestedN,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .composite([{ input: visiblePortion, left: offsetX, top: offsetY }])
      .png()
      .toBuffer();

    let pipeline = sharp(composited);
    if (upsample) {
      pipeline = pipeline.resize(finalN, finalN, { kernel: 'cubic' });
    }

    await pipeline.png().toFile(outputPath);
  } catch (err) {
    return {
      kind: 'backend_internal_error',
      reason: 'sharp_pipeline_failed',
      message: err instanceof Error ? err.message : String(err),
      count_consumed: false,
    };
  }

  // Tile budget bills real source pixels captured (requestedN), not the
  // upsampled output size (finalN). Upsampling adds no new information —
  // it only stretches existing pixels — so billing finalN would
  // artificially penalise large-source crops that need magnification.
  const capturedRealPx = requestedN;
  const tile_count = Math.ceil(capturedRealPx / 200) * Math.ceil(capturedRealPx / 200);

  return {
    kind: 'ok',
    path: outputPath,
    upsampled: upsample,
    tile_count,
    tile_budget_used: 0, // filled in by caller after sidecar update
    tile_budget_remaining: 0, // filled in by caller after sidecar update
    dimensions: {
      n: finalN,
      sourceWidth: sourceMeta.width,
      sourceHeight: sourceMeta.height,
    },
    // FULL crop window (left/top are centerX/Y − half; NOT the clamped
    // visibleLeft/visibleTop). May be negative off-source — that is correct;
    // the negative region is white pad and the back-map stays exact.
    window: { left, top, right, bottom },
    capturedN: requestedN,
    outputN: finalN,
    // F3 fields appear only when computed (dense rows); spreads keep the
    // non-dense response byte-identical.
    ...(inkCentroidSource ? { ink_centroid_source: inkCentroidSource } : {}),
    ...(inkFraction !== undefined ? { ink_fraction: inkFraction } : {}),
    ...(recentered ? { recentered: true } : {}),
    ...(dimCoercion ? { coerced_to: dimCoercion } : {}),
  };
}

function checkCropAfterValidate(
  args: z.infer<typeof cropInputSchema> & { outputDir: string; rowId: string },
): CropResult | null {
  if (!CROP_AFTER_VALIDATE_ENABLED()) return null;
  const sidecar = readUnresolvedTargets(args.outputDir);
  if (!sidecar) {
    return {
      kind: 'crop_before_validate',
      message:
        'crop_source_image requires a preceding validate_graph round. ' +
        'Submit the current draft to validate_graph first; the validator ' +
        'will name the regions you may then crop.',
    };
  }
  // Dense-vision (plan 2026-05-31 §4.3). On a fused polycyclic core the agent
  // self-directs zoom-verify crops, so once a validate round has run we skip
  // the `no_pending_targets` (clean draft) and `crop_target_not_named`
  // (proximity) branches below. `crop_before_validate` above and the tile
  // budget in executeWithRetry still bound it. Strict gate for non-dense rows.
  if (sidecar.dense) return null;
  if (sidecar.ok && sidecar.targets.length === 0) {
    return {
      kind: 'no_pending_targets',
      message:
        'The most recent validate_graph round reported ok with no unresolved ' +
        'targets. There is nothing to crop; submit the draft to build_from_graph.',
    };
  }
  // Resolve the coerced N for proximity check (w/h may be aliases or non-square).
  let n: number;
  try {
    ({ n } = coerceCropDims(args));
  } catch {
    // Missing dims — proximity check skipped; executeCrop will handle the error.
    return null;
  }
  const targets = sidecar.targets;
  const hit = proximityHit(targets, args.x, args.y, n, n);
  if (!hit) {
    const hint = nearestTarget(targets, args.x, args.y);
    return {
      kind: 'crop_target_not_named',
      message:
        'crop center does not match a region validate_graph named. ' +
        (hint
          ? `nearest named target: record ${hint.record_id}:${hint.field} at (${hint.x_center},${hint.y_center}) r=${hint.bbox_radius} — center your crop there.`
          : 'no named targets pending.'),
      details: { x: args.x, y: args.y, w: n, h: n },
    };
  }
  return null;
}

async function executeWithRetry(
  args: z.infer<typeof cropInputSchema> & { outputDir: string; rowId: string },
): Promise<CropResult> {
  const gateRejection = checkCropAfterValidate(args);
  if (gateRejection) return gateRejection;

  // LOCK 30 — pre-check the cumulative tile budget BEFORE spending sharp
  // cycles. Tile budget bills captured real-source pixels (requestedN), not
  // the upsampled output size, so the pre-check is exact (no pessimism
  // needed — the billing is deterministic from args alone).
  const tileBudgetUsed = readTileBudget(args.outputDir);
  const cap = tileBudgetCapFor(args.outputDir);
  // Use coerceCropDims for the tile pre-check so w/h aliases + clamping are
  // consistent with what executeCrop will bill. Fall back to MIN_N if dims
  // are missing (executeCrop will return agent_input_error before billing).
  let preCheckN: number;
  try {
    ({ n: preCheckN } = coerceCropDims(args));
  } catch {
    preCheckN = MIN_N;
  }
  const pessimisticTile =
    Math.ceil(preCheckN / 200) * Math.ceil(preCheckN / 200);
  if (tileBudgetUsed + pessimisticTile > cap) {
    const message = SCRUB_TELEMETRY_ENABLED()
      ? 'This source region has been zoomed too many times to remain useful. Either complete the draft and submit to build_from_graph, or call refuse if you cannot transcribe the molecule.'
      : `cumulative tile budget would exceed ${cap}: used=${tileBudgetUsed} requested=${pessimisticTile}. Re-issue with smaller N, or refuse with budget_exhausted (LOCK 21).`;
    return {
      kind: 'tile_budget_exhausted',
      message,
      tile_budget_used: tileBudgetUsed,
      tile_count_requested: pessimisticTile,
      count_consumed: false,
    };
  }

  const first = await executeCrop(args);
  if (first.kind === 'backend_internal_error') {
    const second = await executeCrop(args);
    if (second.kind !== 'ok') return second;
    const newTotal = tileBudgetUsed + second.tile_count;
    writeTileBudget(args.outputDir, newTotal);
    return {
      ...second,
      tile_budget_used: newTotal,
      tile_budget_remaining: cap - newTotal,
    };
  }
  if (first.kind !== 'ok') return first;
  const newTotal = tileBudgetUsed + first.tile_count;
  writeTileBudget(args.outputDir, newTotal);
  return {
    ...first,
    tile_budget_used: newTotal,
    tile_budget_remaining: cap - newTotal,
  };
}

export const cropTools: ToolDefinition[] = [
  {
    name: 'crop_source_image',
    description:
      'Write a deterministic PNG crop of the source image and return its absolute path. ' +
      'Square crop with side length in pixels; pads with white when the crop window exceeds source bounds. ' +
      '(x,y) is the CENTER of the crop, not a corner. ' +
      'Sources under 300 px are refused with source_too_small. Crops capturing fewer than 1000 real source pixels are upsampled bicubic to 1000 px before write. ' +
      'Backend errors retry silently once. ' +
      'The response returns the source-frame window {left,top,right,bottom} (left/top = x/y − floor(N/2); may be negative when the window runs off-source — that region is white pad), capturedN (real source pixels per side), and outputN (emitted PNG side). ' +
      'To map a pixel (px,py) in the returned crop back to source coordinates: source_x = left + px*(capturedN/outputN), source_y = top + py*(capturedN/outputN). ' +
      'Example: { "rowId": "mol-1", "sourceImagePath": "/abs/path/to/source.png", "x": 420, "y": 380, "w": 200, "h": 200 }',
    inputSchema: {
      type: 'object',
      properties: {
        rowId: { type: 'string' },
        sourceImagePath: { type: 'string' },
        outputDir: { type: 'string' },
        x: { type: 'integer', minimum: 0 },
        y: { type: 'integer', minimum: 0 },
        w: { type: 'integer', minimum: 1 },
        h: { type: 'integer', minimum: 1 },
        width: { type: 'integer', minimum: 1 },
        height: { type: 'integer', minimum: 1 },
      },
      required: ['sourceImagePath', 'x', 'y', 'rowId'],
      additionalProperties: true,
    },
    inputValidator: cropInputSchema,
    run: async (_runtime, args) => {
      // Schema marks rowId + outputDir as optional so production agents
      // can call this tool with only the functional args. server.ts's
      // ARGS_DEFAULT_TOOLS write-back guarantees both fields are present
      // by the time `tool.run` executes, so the cast is sound.
      // w/h are optional (aliased from width/height); coerceCropDims resolves
      // the final side N inside executeCrop / executeWithRetry.
      const parsed = cropInputSchema.parse(args) as z.infer<typeof cropInputSchema> & {
        outputDir: string;
        rowId: string;
      };
      const result = await executeWithRetry(parsed);
      // T2 trace plumbing: refusal classifier needs to see crop attempts
      // (including failures) when deciding `unreadable_topology` /
      // `source_resolution_too_low` / `budget_exhausted`.
      appendSessionEvent(parsed.outputDir, {
        tool: 'crop_source_image',
        rowId: parsed.rowId,
        ts: Date.now(),
        args: { x: parsed.x, y: parsed.y, w: parsed.w ?? parsed.width, h: parsed.h ?? parsed.height },
        result: {
          ok: result.kind === 'ok',
          error_code: result.kind === 'ok' ? undefined : result.kind,
        },
      });
      if (result.kind === 'ok') {
        if (SCRUB_TELEMETRY_ENABLED()) {
          const degraded =
            result.tile_budget_used / tileBudgetCapFor(parsed.outputDir) > 0.7;
          return {
            ok: true,
            data: {
              kind: 'ok',
              path: result.path,
              upsampled: result.upsampled,
              degraded,
              dimensions: result.dimensions,
              // Source-frame window + scale so the agent back-maps crop
              // pixels exactly instead of guessing (x,y) is a top-left corner.
              window: result.window,
              capturedN: result.capturedN,
              outputN: result.outputN,
              // F3 advisory (dense rows only): the window above is already
              // recentered on the ink when `recentered` is true. Conditional
              // spreads keep the non-dense response byte-identical.
              ...(result.ink_centroid_source
                ? { ink_centroid_source: result.ink_centroid_source }
                : {}),
              ...(result.recentered ? { recentered: true } : {}),
              ...(result.coerced_to ? { coerced_to: result.coerced_to } : {}),
            },
          };
        }
        return { ok: true, data: result };
      }
      return {
        ok: false,
        error: {
          code: result.kind,
          message: scrubAgentText(result.message),
          // Details preserve raw telemetry for operator forensics.
          details: result,
        },
      };
    },
  },
];
