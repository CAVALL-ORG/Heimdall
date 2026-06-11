#!/usr/bin/env tsx
/**
 * Test-only Ketcher runtime daemon. Spawns N persistent KetcherRuntime
 * instances (each owns a Chromium + Ketcher page) and exposes them on a
 * Unix socket. Subagents' tsx scripts connect via `test-daemon-client.ts`
 * and reuse the slot's runtime — no per-script Chromium spawn cost.
 *
 * Wire protocol (newline-delimited JSON):
 *   request:  {"id": <int>, "slot": <int>, "method": "callBridge"|"getState"|"exportSmiles"|... , "args": [...]}
 *   response: {"id": <int>, "ok": true,  "result": ...}
 *           | {"id": <int>, "ok": false, "error": "<message>"}
 *
 * Lifecycle:
 *   tsx server/scripts/test-daemon.ts --slots 3 --socket /tmp/ketcher-daemon.sock
 *   # ... tests run ...
 *   send SIGTERM (or send {"id":0,"shutdown":true} on the socket)
 *
 * NOTE: this daemon is for the test harness ONLY. The MCP server in
 * src/mcp/server.ts is the production runtime path; we do not modify it.
 */
import * as net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BuildFromGraphError } from '../src/adapter/graph-intent/errors';
import { KetcherRuntime, RuntimeMutationError } from '../src/mcp/runtime';
import { translateGraphIntent } from '../src/adapter/graph-intent/translator';
import { buildMethylWedgeAdvisory } from '../src/adapter/graph-intent/stereo-advisory';

type Req = {
  id: number;
  slot?: number;
  method?: string;
  args?: unknown[];
  shutdown?: boolean;
  ping?: boolean;
};

type Res =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; details?: unknown };

// Dense manifest row classification + the legacy session-carrier
// detection were deleted 2026-05-26 with the dense state machine. All
// rows now take the same one-shot build path; the daemon's buildFromGraph
// dispatch (below) mirrors the simplified src/mcp/tools/build.ts shape.

function parseArgs(): { slots: number; socket: string; mode: 'standalone' | 'remote' } {
  const argv = process.argv.slice(2);
  let slots = 6;
  let socket = '/tmp/ketcher-daemon.sock';
  let mode: 'standalone' | 'remote' = 'standalone';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--slots') slots = Number(argv[++i]);
    else if (argv[i] === '--socket') socket = argv[++i];
    else if (argv[i] === '--mode') mode = argv[++i] as 'standalone' | 'remote';
  }
  return { slots, socket, mode };
}

async function main() {
  const { slots, socket, mode } = parseArgs();
  console.error(`[daemon] spawning ${slots} runtime slot(s) (mode=${mode})...`);

  // When mode=remote, the Ketcher UI routes structService calls (parse
  // SMILES / molfile / canonical SMILES) through KetcherRuntime's HTTP
  // proxy. The proxy only forwards when `remoteApiPath` is set on start.
  // Pre-2026-05-21 the daemon omitted this — the UI configured
  // `?mode=remote&api_path=/__api/` but the proxy fell through to file-
  // serve, returning index.html and breaking every parse with
  // "Unexpected token '<' is not valid JSON". Set it explicitly.
  const remoteApiPath =
    mode === 'remote'
      ? process.env.KETCHER_REMOTE_API_PATH ?? 'http://127.0.0.1:8002/v2/'
      : undefined;
  const runtimes: KetcherRuntime[] = [];
  for (let i = 0; i < slots; i++) {
    const rt = new KetcherRuntime();
    await rt.start({ mode, remoteApiPath });
    runtimes.push(rt);
    console.error(`[daemon] slot ${i}: ready`);
  }

  try {
    await fs.unlink(socket);
  } catch {
    /* ignore */
  }

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let req: Req;
        try {
          req = JSON.parse(line);
        } catch (e) {
          conn.write(JSON.stringify({ id: 0, ok: false, error: `bad json: ${(e as Error).message}` } satisfies Res) + '\n');
          continue;
        }
        if (req.ping) {
          conn.write(JSON.stringify({ id: req.id, ok: true, result: 'pong' } satisfies Res) + '\n');
          continue;
        }
        if (req.shutdown) {
          conn.write(JSON.stringify({ id: req.id, ok: true, result: 'bye' } satisfies Res) + '\n');
          server.close();
          (async () => {
            for (let i = 0; i < runtimes.length; i++) {
              try { await runtimes[i].stop(); } catch { /* ignore */ }
            }
            process.exit(0);
          })();
          return;
        }
        const slot = req.slot ?? 0;
        const rt = runtimes[slot];
        if (!rt) {
          conn.write(JSON.stringify({ id: req.id, ok: false, error: `invalid slot ${slot}` } satisfies Res) + '\n');
          continue;
        }
        try {
          const result = await dispatch(rt, req.method ?? '', req.args ?? []);
          conn.write(JSON.stringify({ id: req.id, ok: true, result } satisfies Res) + '\n');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const details =
            err instanceof RuntimeMutationError
              ? err.details
              : typeof err === 'object' && err !== null && 'details' in err
                ? (err as { details?: unknown }).details
                : undefined;
          conn.write(JSON.stringify({ id: req.id, ok: false, error: msg, details } satisfies Res) + '\n');
        }
      }
    });
    conn.on('error', (err) => console.error('[daemon] conn error:', err.message));
  });

  server.listen(socket, () => {
    console.error(`[daemon] listening on ${socket}`);
  });

  const shutdown = async () => {
    console.error('[daemon] shutdown signal');
    server.close();
    for (const rt of runtimes) {
      try { await rt.stop(); } catch { /* ignore */ }
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export async function dispatch(
  rt: KetcherRuntime,
  method: string,
  args: unknown[],
): Promise<unknown> {
  switch (method) {
    case 'callBridge':
      return await rt.callBridge(String(args[0]), ...args.slice(1));
    case 'getState':
      return await (rt.getPublicState?.(Boolean(args[0])) ??
        rt.getState(Boolean(args[0])));
    case 'getAnnotatedState':
      return await rt.getAnnotatedState();
    case 'exportSmiles':
      return await rt.exportSmiles();
    case 'getLastDenseExportCertificate':
    case 'getLastDensePhase1Certificate':
    case 'getLastDenseEvidenceEnvelope':
      // Dense getters deleted 2026-05-26. Returning null for back-compat with
      // any caller still asking; subagent templates no longer invoke these.
      return null;
    case 'exportKet':
      return await rt.exportPublicKet();
    case 'exportMolfile':
      return await rt.exportPublicMolfile();
    case 'listRecentEvents':
      return await rt.listRecentEvents(Number(args[0] ?? 20));
    case 'buildFromGraph': {
      // Simplified 2026-05-26 — mirrors src/mcp/tools/build.ts. Accepts a
      // direct GraphIntent (the one input shape). No session state, no
      // route decision, no dense gating. Forensics is optional positional
      // arg 2. (render-diff plumbing removed 2026-05-29 / Task 1A.2.)
      const forensics =
        (args[1] as {
          rowId?: string;
          buildDumpDir?: string;
          fingerprintDumpDir?: string;
        } | undefined) ?? undefined;
      let buildError: BuildFromGraphError | null = null;
      let translatorOutput: Awaited<ReturnType<typeof translateGraphIntent>> | null = null;
      try {
        const mutationResult = await rt.applyMutation(
          'build_from_graph',
          { validate_counts: true },
          async () => {
            try {
              translatorOutput = await translateGraphIntent(rt, args[0] as never, {
                validate_counts: true,
                layout: 'auto',
                forensics,
              });
            } catch (err) {
              if (err instanceof BuildFromGraphError) buildError = err;
              throw err;
            }
          },
        );
        return {
          ok: true,
          atomIdMap: translatorOutput?.atomIdMap ?? {},
          bondIdMap: translatorOutput?.bondIdMap ?? {},
          visionFingerprint: translatorOutput?.visionFingerprint ?? null,
          complexity: translatorOutput?.complexity ?? null,
          // Fusion-methyl wedge re-check (2026-06-04, A011 atom10 lever). The
          // daemon mirrors build.ts but is a separate dispatch, so the advisory
          // must be surfaced here too or it never reaches the agent-orch agent.
          // Dense-gated + empty-suppressed → null on sparse/no-findings.
          methylWedgeAdvisory: buildMethylWedgeAdvisory(args[0] as never),
          ...mutationResult,
        };
      } catch (err) {
        if (buildError) {
          const failure = err instanceof RuntimeMutationError ? err.details : undefined;
          const forwarded = new Error(buildError.message);
          forwarded.name = buildError.name;
          (forwarded as Error & { details?: unknown; code?: string }).code =
            `BUILD_FROM_GRAPH_${buildError.code.toUpperCase()}`;
          (forwarded as Error & { details?: unknown }).details = {
            ...(buildError.details as object | undefined),
            rollbackAttempted: failure?.rollbackAttempted ?? false,
            rollbackSucceeded: failure?.rollbackSucceeded ?? false,
          };
          throw forwarded;
        }
        throw err;
      }
    }
    case 'applyMutationCallBridge': {
      // applyMutation wrapper for a single callBridge — useful for atomic edits
      const [op, params, methodName, ...rest] = args as [string, Record<string, unknown>, string, ...unknown[]];
      return await rt.applyMutation(op, params, async () => {
        await rt.callBridge(methodName, ...rest);
      });
    }
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[daemon] FATAL:', err);
    process.exit(1);
  });
}
