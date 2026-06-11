// server/src/adapter/ink-segmentation.ts
//
// Pure connected-component ink segmentation for PDF molecule cropping.
// No I/O. Operates on raw pixel buffers + plain typed arrays so every
// function is exhaustively unit-testable on hand-built synthetic rasters.

export function binarize(
  data: Uint8Array, width: number, height: number, channels: number, threshold: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  const cc = Math.min(3, channels); // ignore alpha
  for (let p = 0; p < width * height; p++) {
    const i = p * channels;
    let ink = false;
    for (let c = 0; c < cc; c++) { if (data[i + c] < threshold) { ink = true; break; } }
    out[p] = ink ? 1 : 0;
  }
  return out;
}

export function dilate(bin: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return bin.slice();
  const tmp = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(width - 1, x + radius);
      let v = 0;
      for (let xx = x0; xx <= x1; xx++) { if (bin[row + xx]) { v = 1; break; } }
      tmp[row + x] = v;
    }
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - radius), y1 = Math.min(height - 1, y + radius);
      let v = 0;
      for (let yy = y0; yy <= y1; yy++) { if (tmp[yy * width + x]) { v = 1; break; } }
      out[y * width + x] = v;
    }
  }
  return out;
}

export function labelComponents(
  bin: Uint8Array, width: number, height: number, conn: 4 | 8 = 8,
): { labels: Int32Array; count: number } {
  const labels = new Int32Array(width * height); // 0 = background
  const neigh = conn === 8
    ? [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]]
    : [[0,-1],[-1,0],[1,0],[0,1]];
  const stack: number[] = [];
  let current = 0;
  for (let s = 0; s < width * height; s++) {
    if (bin[s] === 0 || labels[s] !== 0) continue;
    current++;
    labels[s] = current;
    stack.length = 0; stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % width, py = (p / width) | 0;
      for (let n = 0; n < neigh.length; n++) {
        const dx = neigh[n][0], dy = neigh[n][1];
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (bin[np] === 1 && labels[np] === 0) { labels[np] = current; stack.push(np); }
      }
    }
  }
  return { labels, count: current };
}

export function seedComponents(
  labels: Int32Array, width: number, height: number, seedsPx: { x: number; y: number }[],
  tolerancePx = 0,
): Set<number> {
  const target = new Set<number>();
  for (const s of seedsPx) {
    const x = Math.round(s.x), y = Math.round(s.y);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const lbl = labels[y * width + x];
    if (lbl !== 0) {
      target.add(lbl);
    } else if (tolerancePx > 0) {
      // Snap: search the square window for the nearest labeled pixel within true radius
      const r = tolerancePx;
      const r2 = r * r;
      let bestDist2 = r2 + 1;
      let bestLbl = 0;
      const x0 = Math.max(0, x - r), x1 = Math.min(width - 1, x + r);
      const y0 = Math.max(0, y - r), y1 = Math.min(height - 1, y + r);
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0; nx <= x1; nx++) {
          const dx = nx - x, dy = ny - y;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const nl = labels[ny * width + nx];
          if (nl !== 0 && d2 < bestDist2) { bestDist2 = d2; bestLbl = nl; }
        }
      }
      if (bestLbl !== 0) target.add(bestLbl);
    }
  }
  return target;
}

export function maskFromComponents(
  labels: Int32Array, width: number, height: number, target: Set<number>,
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) out[p] = target.has(labels[p]) ? 1 : 0;
  return out;
}

export function bboxOfMask(
  mask: Uint8Array, width: number, height: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let p = 0; p < width * height; p++) {
    if (!mask[p]) continue;
    const x = p % width, y = (p / width) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return maxX < 0 ? null : { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

export function resampleMaskRegion(
  mask: Uint8Array, srcW: number, srcH: number,
  rect: { x0: number; y0: number; x1: number; y1: number }, // normalized [0,1] over src
  outW: number, outH: number,
): Uint8Array {
  const out = new Uint8Array(outW * outH);
  for (let oy = 0; oy < outH; oy++) {
    const ny = rect.y0 + ((oy + 0.5) / outH) * (rect.y1 - rect.y0);
    const sy = Math.min(srcH - 1, Math.max(0, Math.floor(ny * srcH)));
    for (let ox = 0; ox < outW; ox++) {
      const nx = rect.x0 + ((ox + 0.5) / outW) * (rect.x1 - rect.x0);
      const sx = Math.min(srcW - 1, Math.max(0, Math.floor(nx * srcW)));
      out[oy * outW + ox] = mask[sy * srcW + sx];
    }
  }
  return out;
}

export function compositeWhiteWhereZero(
  data: Uint8Array, width: number, height: number, channels: number, keep: Uint8Array,
): Uint8Array {
  const out = data.slice();
  for (let p = 0; p < width * height; p++) {
    if (keep[p]) continue;
    const i = p * channels;
    for (let c = 0; c < channels; c++) out[i + c] = 255;
  }
  return out;
}

export interface SegmentOpts {
  threshold?: number;
  dilationPx?: number;
  connectivity?: 4 | 8;
  withinPx?: { x0: number; y0: number; x1: number; y1: number } | null;
  seedTolerancePx?: number;
}
export interface SegmentResult {
  keep: Uint8Array;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  targetCount: number;
  maskedOut: number;
  error?: 'NO_INK_AT_SEED' | 'WITHIN_CLIPS_ALL';
}

export function segmentToKeep(
  data: Uint8Array, width: number, height: number, channels: number,
  seedsPx: { x: number; y: number }[], opts: SegmentOpts = {},
): SegmentResult {
  const { threshold = 180, dilationPx = 6, connectivity = 8, withinPx = null, seedTolerancePx = 0 } = opts;
  const bin = binarize(data, width, height, channels, threshold);
  const dil = dilate(bin, width, height, dilationPx);
  const { labels } = labelComponents(dil, width, height, connectivity);
  const target = seedComponents(labels, width, height, seedsPx, seedTolerancePx);
  if (target.size === 0) {
    return { keep: new Uint8Array(width * height), bbox: null, targetCount: 0, maskedOut: 0, error: 'NO_INK_AT_SEED' };
  }
  const keep = maskFromComponents(labels, width, height, target);
  if (withinPx) {
    for (let p = 0; p < width * height; p++) {
      if (!keep[p]) continue;
      const x = p % width, y = (p / width) | 0;
      if (x < withinPx.x0 || x > withinPx.x1 || y < withinPx.y0 || y > withinPx.y1) keep[p] = 0;
    }
    if (!keep.some(v => v !== 0)) {
      return { keep, bbox: null, targetCount: target.size, maskedOut: 0, error: 'WITHIN_CLIPS_ALL' };
    }
  }
  const bbox = bboxOfMask(keep, width, height);
  // maskedOut = distinct non-target ink components that have ≥1 pixel INSIDE the kept bbox
  // (foreign blobs that overlapped the crop frame; blobs entirely outside are irrelevant)
  const seen = new Set<number>();
  for (let y = bbox!.y0; y <= bbox!.y1; y++) {
    for (let x = bbox!.x0; x <= bbox!.x1; x++) {
      const p = y * width + x;
      const l = labels[p];
      if (bin[p] === 1 && l !== 0 && !target.has(l)) seen.add(l);
    }
  }
  const maskedOut = seen.size;
  return { keep, bbox, targetCount: target.size, maskedOut };
}
