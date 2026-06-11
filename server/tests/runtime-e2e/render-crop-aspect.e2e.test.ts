/**
 * render_canvas cropToContent must preserve the molecule's aspect ratio.
 *
 * Regression guard for a dormant bug (fixed 2026-06-08): when `cropToContent`
 * was set but no explicit width/height was passed, the rasterizer kept the
 * fixed full-canvas clientRect dims (~1176x638, ar 1.84) for EVERY molecule —
 * the content viewBox was then scaled into that fixed 1.84:1 frame, stretching
 * a square molecule horizontally. The bug stayed hidden because the only live
 * caller (MCP render_canvas) does not expose cropToContent, and the render-diff
 * scripts that did use it passed explicit dims (which still win).
 *
 * Contract: with cropToContent and no explicit dims, the PNG aspect ratio
 * tracks the molecule's drawn bbox. A wide molecule (long alkane chain) renders
 * markedly wider than a compact one (benzene); neither pins to the old 1.84.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { KetcherRuntime } from '../../src/mcp/runtime';

const runE2E = process.env.RUN_KETCHER_E2E === '1';
const describeE2E = runE2E ? describe : describe.skip;

async function renderAspect(rt: KetcherRuntime, smiles: string): Promise<number> {
  await rt.callBridge('clearCanvas');
  await rt.callBridge('loadSmiles', smiles);
  const b64 = await rt.callBridge<string>('renderCanvas', {
    format: 'png',
    cropToContent: true,
  });
  const meta = await sharp(Buffer.from(b64, 'base64')).metadata();
  if (!meta.width || !meta.height) throw new Error('render produced no dimensions');
  return meta.width / meta.height;
}

describeE2E('render_canvas cropToContent preserves aspect (no fixed-canvas stretch)', () => {
  const rt = new KetcherRuntime();
  beforeAll(async () => {
    await rt.start();
  }, 180000);
  afterAll(async () => {
    await rt.stop();
  });

  it('wide molecule renders wider than a compact one, and neither pins to the old 1.84', async () => {
    const wide = await renderAspect(rt, 'CCCCCCCCCCCC'); // dodecane — long horizontal zigzag
    const compact = await renderAspect(rt, 'c1ccccc1'); // benzene — roughly square

    // The long chain must be clearly landscape.
    expect(wide).toBeGreaterThan(2.0);
    // The compact ring must NOT be pinned to the old fixed-canvas 1.84 — that
    // was the bug's signature (every molecule came out 1.84 regardless).
    expect(compact).toBeLessThan(1.6);
    // And the two must differ by a real margin (pre-fix they were identical).
    expect(wide - compact).toBeGreaterThan(0.6);
  }, 180000);
});
