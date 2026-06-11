/**
 * Template for batched-rows subagent driver. A subagent that handles K
 * image-rebuild rows in one pass writes ONE script following this shape:
 *
 *   1. Connect to the test daemon (one slot, one persistent runtime).
 *   2. For each row, run buildFromGraph → render → write PNG → exportSmiles.
 *   3. Print the per-row TRACE block + SMILES to stdout.
 *
 * Each row consumes ~0.5-1 sec of Ketcher time on the daemon (vs ~2.4 sec
 * cold-start per row in the old per-row tsx model). Net savings on a
 * 3-row batch: ~5-6 sec on Ketcher overhead + 2× tsx process startup avoided.
 *
 * Subagent fills in ROWS at the top and runs. Stdout is captured into the
 * final assistant message verbatim.
 */
import { writeFileSync } from 'node:fs';
import { RuntimeClient } from './test-daemon-client';

type RebuildRow = {
  id: string;
  /** Output PNG path for the post-build render. Subagent reads this back. */
  out_png: string;
  /** GraphIntent the subagent transcribed from the source image. */
  graph: unknown;
  /** Optional: skip the readback render for trivial rows (heavy ≤ 6, no stereo). */
  skip_render?: boolean;
};

export async function runBatch(rows: RebuildRow[], slot = 0): Promise<void> {
  if (!process.env.KETCHER_DAEMON_SOCKET) {
    throw new Error(
      'agent-orch acceptance runs require KETCHER_DAEMON_SOCKET (bundled daemon path only)',
    );
  }
  const rt = new RuntimeClient({ slot });
  await rt.connect();
  try {
    for (const row of rows) {
      console.log(`---ROW ${row.id}---`);
      try {
        await rt.callBridge('clearCanvas');
        console.log(`TRACE: clear_canvas`);

        const result = await rt.buildFromGraph(row.graph);
        console.log(`TRACE: build_from_graph`);
        // The runtime returns a RuntimeMutationResult with diff stats; log
        // a tiny summary so the agent can sanity-check counts.
        const r = result as { after?: { atoms?: unknown[]; bonds?: unknown[] } } | undefined;
        console.log(`BUILD_COUNTS: atoms=${r?.after?.atoms?.length ?? '?'} bonds=${r?.after?.bonds?.length ?? '?'}`);

        if (!row.skip_render) {
          const pngB64 = (await rt.callBridge('renderCanvas', {
            format: 'png',
            showAtomIds: true,
            backgroundColor: '#ffffff',
          })) as string;
          const clean = pngB64.replace(/^data:image\/png;base64,/, '');
          writeFileSync(row.out_png, Buffer.from(clean, 'base64'));
          // Phase 2: emit the absolute path alongside the TRACE label so
          // the evaluator can locate this PNG and skip its own
          // clear_canvas + load_smiles + render_canvas chain (the
          // canvas the runner exported the SMILES from already
          // encodes the candidate molecule).
          console.log(`TRACE: render_canvas ${row.out_png}`);
          console.log(`PNG: ${row.out_png}`);
        }

        const smi = await rt.exportSmiles();
        console.log(`TRACE: export_smiles`);
        console.log(`SMILES: ${smi}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`ERROR: ${msg}`);
        console.log(`SMILES: null`);
      }
    }
  } finally {
    await rt.disconnect();
  }
}

// --- Example usage (subagent replaces ROWS array) ---
// const ROWS: RebuildRow[] = [
//   { id: 'I001', out_png: '/abs/path/I001/rendered.png', graph: { version: 1, atoms: [...], bonds: [...], rings: [...], counts: {...} } },
//   { id: 'I002', out_png: '/abs/path/I002/rendered.png', graph: { ... } },
//   { id: 'I003', out_png: '/abs/path/I003/rendered.png', graph: { ... } },
// ];
// runBatch(ROWS, Number(process.env.KETCHER_SLOT ?? 0)).catch((e) => {
//   console.error(e);
//   process.exit(1);
// });
