/**
 * Parallel == solo on the runtime pool — the committed form of the
 * pool-vs-multiplex parallelism proof.
 *
 * Model under test: `scripts/test-daemon.ts --slots 3` — one daemon process,
 * three isolated KetcherRuntime instances (own Chromium + Ketcher page each),
 * addressed by slot via `RuntimeClient`. This is the production parallelism
 * path the agent-orch runbook uses; the daemon is spawned here from TS source
 * via tsx, so the test always runs current code (bundle freshness is covered
 * separately by production-mcp-smoke.e2e.test.ts).
 *
 * Method: replay three PROVEN vision-transcribed GraphIntents
 * (tests/fixtures/parallel-pool/, see its README for provenance):
 *   phase 1 — each graph built + exported ALONE on its slot   → solo SMILES
 *   phase 2 — all three built CONCURRENTLY, all canvases live
 *             at once, then all exported                       → conc SMILES
 * Identical inputs make this a pure INTERFERENCE test: any solo/concurrent
 * delta is cross-row contamination, not vision variance. Replaying a
 * transcribed GraphIntent is the Ketcher-authored path — the test types no
 * SMILES; every string comes out of exportSmiles.
 *
 * Asserts:
 *   1. concurrent SMILES === solo SMILES, string-exact, per row (dep-free);
 *   2. the three builds genuinely overlapped in time (builds run 12–31 s; no
 *      overlap would mean the daemon serialized them — a pool regression);
 *   3. coexistence: mid-flight, each slot holds its own molecule (heavy-atom
 *      counts match that row's solo build and are pairwise distinct);
 *   4. A004 InChIKey == RCINICONZNJXQF-MZXODVADSA-N — the handoff §1 solo
 *      stereo bar (11 stereocenters) — via RDKit, skipped if RDKit absent.
 *
 * Prerequisites + graceful degradation (fresh machines must not go red):
 *   - RUN_KETCHER_E2E=1            else whole suite skips (repo convention);
 *   - remote Indigo at KETCHER_REMOTE_API_PATH (default
 *     http://127.0.0.1:8002/v2/)   else whole suite skips with a hint —
 *     stereo rows need remote mode (docker indigo_service or the userspace
 *     Indigo shim);
 *   - python3 + rdkit              else only the InChIKey-bar test skips.
 *
 * Run:
 *   (cd ketcher-agent && RUN_KETCHER_E2E=1 npx vitest run tests/runtime-e2e/parallel-pool.e2e.test.ts)
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RuntimeClient } from '../../scripts/test-daemon-client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TSX_BIN = resolve(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const DAEMON_SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'test-daemon.ts');
const FIXTURE_DIR = resolve(__dirname, '..', 'fixtures', 'parallel-pool');
const SOCKET = `/tmp/ketcher-parallel-pool-e2e-${process.pid}.sock`;

const REMOTE = process.env.KETCHER_REMOTE_API_PATH ?? 'http://127.0.0.1:8002/v2/';
const A004_BAR = 'RCINICONZNJXQF-MZXODVADSA-N';
const ROW_IDS = ['A004', 'A009', 'A011'] as const;
type RowId = (typeof ROW_IDS)[number];

const runE2E = process.env.RUN_KETCHER_E2E === '1';

async function probeIndigo(base: string): Promise<boolean> {
  try {
    const res = await fetch(new URL('info', base), { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

const INDIGO_UP = runE2E ? await probeIndigo(REMOTE) : false;
if (runE2E && !INDIGO_UP) {
  console.warn(
    `[parallel-pool] SKIPPED: no Indigo service at ${REMOTE} — stereo rows need remote mode. ` +
      `Start it with \`docker start indigo_service\` (or the userspace Indigo shim).`,
  );
}

const HAS_RDKIT =
  runE2E && INDIGO_UP
    ? spawnSync('python3', ['-c', 'import rdkit'], { timeout: 15000 }).status === 0
    : false;
if (runE2E && INDIGO_UP && !HAS_RDKIT) {
  console.warn('[parallel-pool] python3+rdkit not available — InChIKey-bar test will skip.');
}

/** SMILES → InChIKey via RDKit (stereo-aware). */
function inchiKey(smiles: string): string {
  return execFileSync(
    'python3',
    [
      '-c',
      'import sys;from rdkit import Chem;m=Chem.MolFromSmiles(sys.argv[1]);print(Chem.MolToInchiKey(m) if m else "RDKIT_PARSE_FAIL")',
      smiles,
    ],
    { encoding: 'utf8', timeout: 30000 },
  ).trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * clear → build → export on one slot, retrying up to 3 attempts. The retry
 * absorbs the known intermittent BUILD_FROM_GRAPH_STEREO_TRANSFER_FAILED
 * translator noise (pre-existing, hit solo runs too — handoff §5 #6); a third
 * consecutive failure is a real failure and propagates.
 */
async function buildExportWithRetry(
  client: RuntimeClient,
  rowId: string,
  graph: unknown,
  onBuilt?: () => void,
): Promise<{ smiles: string; heavy: number; attempts: number }> {
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await client.callBridge('clearCanvas');
      await client.buildFromGraph(graph, { rowId: `${rowId}-att${attempt}` });
      onBuilt?.();
      const st = (await client.getState(false)) as { atoms?: unknown[] };
      const heavy = Array.isArray(st.atoms) ? st.atoms.length : -1;
      const smiles = await client.exportSmiles();
      if (!smiles) throw new Error('exportSmiles returned empty');
      if (attempt > 1) console.warn(`[parallel-pool] ${rowId}: succeeded on attempt ${attempt}`);
      return { smiles, heavy, attempts: attempt };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      console.warn(`[parallel-pool] ${rowId} attempt ${attempt} failed: ${lastErr}`);
      await sleep(150);
    }
  }
  throw new Error(`[${rowId}] build+export failed after 3 attempts: ${lastErr}`);
}

const describePool = runE2E && INDIGO_UP ? describe : describe.skip;

describePool('parallel pool — N slots, parallel == solo', () => {
  const graphs = Object.fromEntries(
    ROW_IDS.map((id) => [id, JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${id}.graph.json`), 'utf8'))]),
  ) as Record<RowId, unknown>;

  let daemon: ChildProcess;
  let daemonExited = false;
  const clients: RuntimeClient[] = [];
  const solo = {} as Record<RowId, { smiles: string; heavy: number }>;
  const conc = {} as Record<RowId, { smiles: string }>;

  beforeAll(async () => {
    daemon = spawn(TSX_BIN, [DAEMON_SCRIPT, '--slots', '3', '--socket', SOCKET, '--mode', 'remote'], {
      env: { ...process.env, KETCHER_REMOTE_API_PATH: REMOTE },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    daemon.on('exit', () => {
      daemonExited = true;
    });

    for (const i of [0, 1, 2]) clients.push(new RuntimeClient({ slot: i, socket: SOCKET }));

    // 3 Chromium+Ketcher startups; poll until the socket answers.
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      if (daemonExited) throw new Error('daemon exited before its socket came up');
      try {
        await clients[0].connect();
        await clients[0].ping();
        ready = true;
      } catch {
        await sleep(1000);
      }
    }
    if (!ready) throw new Error('daemon socket never became ready (120s)');
    await clients[1].connect();
    await clients[2].connect();
  }, 240000);

  afterAll(async () => {
    try {
      await clients[0]?.requestShutdown();
      await sleep(500);
    } catch {
      /* daemon may already be gone */
    }
    for (const c of clients) await c.disconnect().catch(() => {});
    if (daemon && !daemonExited) daemon.kill('SIGTERM');
    try {
      unlinkSync(SOCKET);
    } catch {
      /* ignore */
    }
  }, 30000);

  it(
    'solo baseline: each fixture builds + exports alone on its slot',
    async () => {
      for (let i = 0; i < ROW_IDS.length; i++) {
        const rowId = ROW_IDS[i];
        const r = await buildExportWithRetry(clients[i], `${rowId}-solo`, graphs[rowId]);
        solo[rowId] = { smiles: r.smiles, heavy: r.heavy };
        // Leave slots clean so phase 2 starts from blank canvases.
        await clients[i].callBridge('clearCanvas');
      }
      // Distinct sizes are what give the coexistence check its power.
      const heavies = ROW_IDS.map((id) => solo[id].heavy);
      expect(new Set(heavies).size).toBe(3);
    },
    360000,
  );

  it(
    'concurrent: 3 rows live at once — overlap, coexistence, exports == solo',
    async () => {
      expect(Object.keys(solo)).toHaveLength(3); // solo phase must have completed

      const t0 = Date.now();
      const timeline: { rowId: RowId; startMs: number; endMs: number }[] = [];

      // Fire all three builds at once — each client has its own socket and its
      // own slot, so the daemon services them concurrently. Capture each
      // build's interval; export only after ALL builds landed so the three
      // molecules are simultaneously live (maximum interference window).
      const results = await Promise.all(
        ROW_IDS.map((rowId, i) => {
          const startMs = Date.now() - t0;
          return buildExportWithRetry(clients[i], `${rowId}-conc`, graphs[rowId], () =>
            timeline.push({ rowId, startMs, endMs: Date.now() - t0 }),
          );
        }),
      );

      // (2) true concurrency: at least one pair of build intervals overlapped.
      // These builds take 12–31 s each and all start within milliseconds; if
      // they did NOT overlap the daemon serialized them.
      const overlapped = timeline.some((a) =>
        timeline.some((b) => a.rowId !== b.rowId && a.startMs < b.endMs && b.startMs < a.endMs),
      );
      expect(overlapped, `build intervals did not overlap: ${JSON.stringify(timeline)}`).toBe(true);

      // (3) coexistence: with all three canvases still live, each slot holds
      // its own molecule — same heavy count as that row's solo build, all
      // three pairwise distinct.
      const counts = await Promise.all(
        clients.map(async (c) => {
          const st = (await c.getState(false)) as { atoms?: unknown[] };
          return Array.isArray(st.atoms) ? st.atoms.length : -1;
        }),
      );
      ROW_IDS.forEach((rowId, i) => expect(counts[i], `${rowId} slot heavy count`).toBe(solo[rowId].heavy));
      expect(new Set(counts).size).toBe(3);

      // (1) the core regression: concurrent export == solo export, exactly.
      ROW_IDS.forEach((rowId, i) => {
        conc[rowId] = { smiles: results[i].smiles };
        expect(results[i].smiles, `${rowId}: concurrent SMILES != solo SMILES (interference)`).toBe(
          solo[rowId].smiles,
        );
      });
    },
    360000,
  );

  it.skipIf(!HAS_RDKIT)(
    'A004 stereo bar: solo and concurrent InChIKey == RCINICONZNJXQF-MZXODVADSA-N',
    () => {
      expect(solo.A004?.smiles, 'solo phase must have completed').toBeTruthy();
      expect(conc.A004?.smiles, 'concurrent phase must have completed').toBeTruthy();
      expect(inchiKey(solo.A004.smiles)).toBe(A004_BAR);
      expect(inchiKey(conc.A004.smiles)).toBe(A004_BAR);
    },
    60000,
  );
});
