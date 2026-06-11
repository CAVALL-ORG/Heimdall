/**
 * F3 — ink-centroid crop assist (stereo-polarity three-lever plan).
 *
 * Pure decision helper. Given an already-extracted grayscale buffer of the
 * captured crop window (dark pixel < DARK_THRESHOLD = ink), measure the ink
 * centroid and decide whether the crop should be recentered on it.
 *
 * Recenter ONLY on the crammed-corner failure signature — a SMALL feature
 * jammed OFF-CENTER — so a well-framed crop is left untouched (byte-identical
 * output). The caller dense-gates the whole block, so this never runs on a
 * sparse/easy row. Root cause + selectivity evidence captured in the
 * crop-centering dense-stereo investigation.
 */

const DARK_THRESHOLD = 128; // grayscale value below which a pixel counts as ink
const INK_FRAC_GATE = 0.08; // recenter only when ink fills < 8% of the frame
const OFFSET_FRAC_GATE = 0.12; // …AND its centroid is > 12% of N off the center

export interface InkRecenter {
  /** Ink centroid in SOURCE coordinates, or null when the crop is blank. */
  inkCentroidSource: { x: number; y: number } | null;
  /** Fraction of the captured window that is ink (0–1). */
  inkFraction: number;
  /** New crop center (source coords) when the gate fires, else null. */
  recenter: { centerX: number; centerY: number } | null;
}

export function computeInkRecenter(
  gray: Uint8Array,
  visibleW: number,
  visibleH: number,
  visibleLeft: number,
  visibleTop: number,
  centerX: number,
  centerY: number,
  requestedN: number,
  opts?: {
    inkFracGate?: number;
    offsetFracGate?: number;
    darkThreshold?: number;
  },
): InkRecenter {
  const dark = opts?.darkThreshold ?? DARK_THRESHOLD;
  const inkFracGate = opts?.inkFracGate ?? INK_FRAC_GATE;
  const offsetFracGate = opts?.offsetFracGate ?? OFFSET_FRAC_GATE;

  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < visibleH; y++) {
    const row = y * visibleW;
    for (let x = 0; x < visibleW; x++) {
      if (gray[row + x] < dark) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }

  const area = visibleW * visibleH;
  if (n === 0 || area === 0) {
    return { inkCentroidSource: null, inkFraction: 0, recenter: null };
  }

  const cx = sx / n;
  const cy = sy / n;
  const inkCentroidSource = { x: visibleLeft + cx, y: visibleTop + cy };
  const inkFraction = n / area;

  const offset = Math.hypot(inkCentroidSource.x - centerX, inkCentroidSource.y - centerY);
  const offsetFrac = requestedN > 0 ? offset / requestedN : 0;

  const recenter =
    inkFraction < inkFracGate && offsetFrac > offsetFracGate
      ? { centerX: Math.round(inkCentroidSource.x), centerY: Math.round(inkCentroidSource.y) }
      : null;

  return { inkCentroidSource, inkFraction, recenter };
}
