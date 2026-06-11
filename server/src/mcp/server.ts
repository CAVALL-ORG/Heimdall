import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { KetcherRuntime, RuntimeMutationError } from './runtime';
import { ingestTools } from './tools/ingest';
import { canonicalTools } from './tools/canonical';
import { exportTools } from './tools/export';
import { verifyTools } from './tools/verify';
import { renderTools } from './tools/render';
import { buildTools } from './tools/build';
import { cropTools } from './tools/crop';
import { pdfTools } from './tools/pdf';
import { validateTools } from './tools/validate';
import { refuseTools } from './tools/refuse';
import { toMcpTextResult, type ToolDefinition, type ToolExecutionResult } from './tools/types';
import {
  evaluateWatchdog,
  renameImageHandle,
  resolveRowState,
} from './tools/row-state';
import {
  CanvasAnchorError,
  resolveCanvasRouting,
} from './canvas-multiplex';
import { spawn } from 'node:child_process';
import {
  resolveIndigoMode,
  indigoPython,
  INDIGO_DEGRADE_ADVISORY,
} from './indigo-bootstrap';

// T6 — per-row source-image path indirection. Default ON in Phase 2.
const PATH_INDIRECTION_ENABLED = () =>
  process.env.KETCHER_PATH_INDIRECTION !== '0';

const PATH_INDIRECTION_TOOLS = new Set([
  'crop_source_image',
  'validate_graph',
]);

// Image-rebuild tools whose schemas accept optional `rowId` / `outputDir`.
// server.ts resolves both fields via `resolveRowState` before zod parsing
// so production agents (no orchestrator to inject these) get a stable
// session-scoped row directory.
const ARGS_DEFAULT_TOOLS = new Set([
  'validate_graph',
  'crop_source_image',
  'build_from_graph',
  'render_canvas',
  'export_smiles',
  'refuse',
]);

// Strict canvas-anchor enforcement. OFF by default so single-canvas and
// sequential sessions (incl. the test harness driving many rowIds through one
// persistent server over time) are byte-identical to today. A parallel
// orchestrator launches the server with KETCHER_STRICT_CANVAS_ANCHOR=1 to
// force every canvas call to carry an explicit rowId.
const STRICT_CANVAS_ANCHOR = () =>
  process.env.KETCHER_STRICT_CANVAS_ANCHOR === '1';

const DEFAULT_LOCAL_REMOTE_STRUCT_API = process.env.KETCHER_REMOTE_API_PATH ?? 'http://127.0.0.1:8002/v2/';
const modeEnv = process.env.KETCHER_AGENT_MODE ?? 'auto';

function normalizeApiPath(apiPath: string) {
  return apiPath.endsWith('/') ? apiPath : `${apiPath}/`;
}

async function isRemoteApiReachable(apiPath: string): Promise<boolean> {
  const normalized = normalizeApiPath(apiPath);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${normalized}info`, {
      method: 'GET',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveRuntimeStartOptions() {
  if (modeEnv === 'standalone') {
    return {};
  }
  const remoteApiPath = normalizeApiPath(DEFAULT_LOCAL_REMOTE_STRUCT_API);
  if (modeEnv === 'remote') {
    return {
      mode: 'remote' as const,
      remoteApiPath,
    };
  }
  // Auto mode: prefer local remote API for OCR, otherwise fall back to standalone.
  if (await isRemoteApiReachable(remoteApiPath)) {
    return {
      mode: 'remote' as const,
      remoteApiPath,
    };
  }
  return {};
}

// Plan 2 Task 4 — true exactly when the effective runtime mode is standalone
// (no Indigo backend). Export tools append INDIGO_DEGRADE_ADVISORY when set.
export let indigoDegraded = false;

/**
 * Compose the wheel probe (indigo-bootstrap, source B) with the already-running
 * remote probe (isRemoteApiReachable, source A). Runs in main() BEFORE
 * resolveRuntimeStartOptions(). If a remote is already up or the epam.indigo
 * wheel is importable (and the shim binds) we stay in remote (not degraded);
 * otherwise we degrade. Fully defensive: any spawn/probe failure sets
 * indigoDegraded=true and never throws — the image path must still boot.
 */
async function startIndigoIfAvailable(): Promise<void> {
  try {
    if (modeEnv === 'remote') {
      indigoDegraded = false;
      return;
    }
    if (modeEnv === 'standalone') {
      indigoDegraded = true;
      return;
    }
    // auto / unset.
    const remoteApiPath = normalizeApiPath(DEFAULT_LOCAL_REMOTE_STRUCT_API);
    // (A) A remote Indigo is already running (docker / LAN). Existing
    // resolveRuntimeStartOptions will pick remote; nothing to spawn.
    if (await isRemoteApiReachable(remoteApiPath)) {
      indigoDegraded = false;
      return;
    }
    // (B) No remote up — probe the bundled epam.indigo wheel.
    const r = await resolveIndigoMode('auto');
    if (r.mode === 'standalone') {
      indigoDegraded = true;
      return;
    }
    // Wheel importable — spawn the shim so the remote becomes reachable.
    const shimPath = new URL('../../scripts/indigo-shim.py', import.meta.url).pathname;
    const shim = spawn(indigoPython(), [shimPath], {
      stdio: 'ignore',
      detached: false,
    });
    shim.on('error', () => {
      indigoDegraded = true;
    });
    process.env.KETCHER_REMOTE_API_PATH ||= 'http://127.0.0.1:8002/v2/';
    // Give the shim a moment to bind its socket before the runtime probes it.
    await new Promise((res) => setTimeout(res, 800));
    indigoDegraded = false;
  } catch {
    // Never let Indigo bootstrap take down the server — the image path
    // (standalone) must still boot. Degrade defensively.
    indigoDegraded = true;
  }
}

const runtime = new KetcherRuntime();
export const toolDefinitions: ToolDefinition[] = [
  ...ingestTools,
  ...buildTools,
  ...canonicalTools,
  ...exportTools,
  ...verifyTools,
  ...validateTools,
  ...cropTools,
  ...refuseTools,
  ...renderTools,
  ...pdfTools,
];

const toolMap = new Map(toolDefinitions.map((tool) => [tool.name, tool]));

// Lazy runtime bootstrap. The MCP transport connects immediately so the
// `initialize` handshake clears Claude Code's 30s timeout; the browser runtime
// (Indigo probe, HTTP server, headless Chromium, Ketcher page load) — including
// any first-run Chromium download, which takes minutes — warms up here in the
// background. Memoized: concurrent tool calls join one in-flight bootstrap, and
// a failure resets the handle so the next tool call retries from scratch.
let bootstrapPromise: Promise<void> | null = null;
let bootstrapError: string | null = null;

function startBootstrap(): void {
  if (bootstrapPromise) return;
  bootstrapPromise = (async () => {
    await startIndigoIfAvailable();
    await runtime.start(await resolveRuntimeStartOptions());
    // Clear a prior failure ONLY on success — otherwise a hard failure (e.g.
    // Chromium can't launch) must stay visible across retries instead of being
    // masked by the next "still initializing" message.
    bootstrapError = null;
  })().catch((error) => {
    bootstrapError = error instanceof Error ? error.message : String(error);
    bootstrapPromise = null;
  });
}

// Plan 2 Task 4 — export tools that carry the degrade advisory when no Indigo
// backend is present. Additive only: the advisory rides alongside the data and
// never alters the exported SMILES/molfile/KET string itself.
const EXPORT_TOOLS = new Set(['export_smiles', 'export_ket', 'export_molfile']);

function withDegradeAdvisory(
  toolName: string,
  result: ToolExecutionResult,
): ToolExecutionResult {
  if (indigoDegraded && EXPORT_TOOLS.has(toolName) && result?.ok) {
    // toMcpTextResult JSON-stringifies the whole result, so an extra top-level
    // field surfaces in the emitted text content.
    return { ...result, advisory: INDIGO_DEGRADE_ADVISORY };
  }
  return result;
}

const server = new Server(
  {
    name: 'heimdall',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
  return {
    tools: toolDefinitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const tool = toolMap.get(request.params.name);
  if (!tool) {
    return toMcpTextResult({
      ok: false,
      error: {
        code: 'UNKNOWN_TOOL',
        message: `Unknown tool: ${request.params.name}`,
      },
    });
  }

  // Runtime readiness gate. Until the background bootstrap has the browser +
  // Ketcher page live, every tool needs the runtime, so answer with a clear,
  // retryable signal instead of blocking the call (a first-run Chromium download
  // can exceed a tool-call timeout). Idempotent: kicks off the bootstrap if it
  // isn't already running.
  if (!runtime.isReady()) {
    startBootstrap();
    return toMcpTextResult({
      ok: false,
      error: {
        code: 'BROWSER_INITIALIZING',
        message: bootstrapError
          ? `Heimdall runtime failed to start: ${bootstrapError}. Retry to attempt again.`
          : 'Heimdall is starting its browser runtime. The first run downloads '
            + 'Chromium (~2-5 min); later starts are quick. Retry shortly.',
      },
    });
  }

  try {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // Classify for canvas routing from the RAW caller args, BEFORE the
    // resolveRowState write-back below backfills rowId. Pure + unit-tested
    // (tests/unit/canvas-multiplex.test.ts).
    const routing = resolveCanvasRouting(
      tool.name,
      args,
      STRICT_CANVAS_ANCHOR(),
    );

    // T4 — silent watchdog. Image-rebuild-relevant tools only.
    const watchdog = evaluateWatchdog(tool.name, {
      rowId: args.rowId,
      outputDir: args.outputDir,
      sourceImagePath: args.sourceImagePath,
    });
    if (watchdog) {
      return toMcpTextResult(watchdog);
    }

    // Production-first server defaults — resolve rowId + outputDir via
    // resolveRowState and write them back to args BEFORE zod parsing, so
    // image-rebuild tools (whose schemas mark both fields optional) get a
    // stable session-scoped row directory even when the agent omits them.
    // T6 path indirection (per-row source-image symlink) is folded in
    // here for tools in PATH_INDIRECTION_TOOLS so the resolved outputDir
    // is reused across both side effects.
    if (ARGS_DEFAULT_TOOLS.has(tool.name)) {
      const resolved = resolveRowState({
        rowId: args.rowId,
        outputDir: args.outputDir,
        sourceImagePath: args.sourceImagePath,
      });
      args.outputDir = resolved.outputDir;
      // Solution #2 (enforce rowId): do NOT backfill args.rowId. Every
      // canvas tool now requires rowId at the schema layer, so a missing
      // rowId must reach zod and be rejected — backfilling it here would
      // mask the omission and re-open the shared-default-canvas race. The
      // outputDir backfill above still rides the caller's rowId (resolved
      // via the rowId-only branch of resolveRowState).
      if (
        PATH_INDIRECTION_ENABLED() &&
        PATH_INDIRECTION_TOOLS.has(tool.name) &&
        typeof args.sourceImagePath === 'string'
      ) {
        args.sourceImagePath = renameImageHandle(
          args.sourceImagePath,
          resolved.outputDir,
        );
      }
    }

    const validatedArgs = tool.inputValidator.parse(args);
    // Canvas-free tools touch no shared canvas state — run directly, off the
    // serialization queue, so parallel zoom loops don't block on canvas bursts.
    if (routing.isCanvasFree) {
      const result = await tool.run(runtime, validatedArgs);
      return toMcpTextResult(withDegradeAdvisory(tool.name, result));
    }
    // Canvas tools: serialize against the shared page (B3) and bind the call's
    // canvas key (page-in its molecule) before running. The union narrows
    // here (isCanvasFree === false ⇒ routing.bind is defined).
    const result = await runtime.runExclusive(async () => {
      await runtime.bindCanvas(routing.bind.requestedKey, {
        explicit: routing.bind.explicit,
        strict: routing.bind.strict,
      });
      return tool.run(runtime, validatedArgs);
    });
    return toMcpTextResult(withDegradeAdvisory(tool.name, result));
  } catch (error) {
    if (error instanceof RuntimeMutationError) {
      return toMcpTextResult({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }

    if (error instanceof CanvasAnchorError) {
      return toMcpTextResult({
        ok: false,
        error: {
          code: 'canvas_anchor_required',
          message: error.message,
          details: { attemptedKey: error.attemptedKey },
        },
      });
    }

    if (error instanceof ZodError) {
      const tool = toolMap.get(request.params.name);
      const exampleMatch = tool?.description.match(/Example:\s*(\{[\s\S]*?\})\s*$/);
      return toMcpTextResult({
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Tool input validation failed',
          details: {
            issues: error.issues,
            expected_schema: tool?.inputSchema ?? null,
            example: exampleMatch ? JSON.parse(exampleMatch[1]) : null,
          },
        },
      });
    }

    return toMcpTextResult({
      ok: false,
      error: {
        code: 'TOOL_EXECUTION_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

async function main() {
  // Connect the MCP transport FIRST so the `initialize` handshake responds well
  // inside Claude Code's 30s timeout. The browser runtime — Indigo probe, HTTP
  // server, headless Chromium (with a possible multi-minute first-run download),
  // Ketcher page load — warms up in the background via startBootstrap() and is
  // gated per tool call through runtime.isReady(); tools answer with
  // BROWSER_INITIALIZING until it's live.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  startBootstrap();
}

main().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start Ketcher MCP server:', error);
  await runtime.stop().catch(() => undefined);
  process.exit(1);
});

process.on('SIGINT', async () => {
  await runtime.stop().catch(() => undefined);
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await runtime.stop().catch(() => undefined);
  process.exit(0);
});
