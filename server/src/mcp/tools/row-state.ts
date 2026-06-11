/**
 * Row-state primitive shared across image-rebuild MCP tools.
 *
 * Mirrors the sidecar pattern in `crop.ts` (`readTileBudget` /
 * `writeTileBudget`): single file per `outputDir`, sync I/O, atomic via
 * temp + rename, idempotent. No process state outside of the
 * session-default cache.
 *
 * Exports:
 *
 *   - `readUnresolvedTargets` / `writeUnresolvedTargets`
 *       T1 (`crop_source_image` proximity gate) sidecar.
 *
 *   - `readTurnCount` / `incrementTurnCount`
 *       T4 (silent watchdog) per-row turn counter.
 *
 *   - `appendSessionEvent` / `readSessionTrace`
 *       T1b / T2 trace log. Append-only; trimmed to bounded length.
 *
 *   - `proximityHit`
 *       T1 geometry check: `(x, y)` within `0.25 × min(w, h)` of any
 *       named target center.
 *
 *   - `resolveRowState`
 *       Server-default resolver. Returns `{ outputDir, rowId }` for
 *       every image-rebuild call, using agent-provided values when
 *       present and a session-scoped default otherwise (production
 *       agents have no orchestrator to inject these).
 *
 *   - `renameImageHandle`
 *       T6 path indirection: per-row symlink at `<outputDir>/source<ext>`
 *       so the agent's MCP-visible image handle does not leak the
 *       user-supplied filename.
 *
 *   - `WATCHDOG_COUNTED_TOOLS`
 *       The image-rebuild surfaces the watchdog counts. Pure-read /
 *       inspection tools bypass.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { BlackBoxRegion } from '../../types/graph-intent';

// ── Sidecar filenames ────────────────────────────────────────────────

const UNRESOLVED_SIDECAR = '_unresolved_targets.json';
const SESSION_TRACE_SIDECAR = '_session_trace.json';
const TURN_COUNT_SIDECAR = '_turn_count.txt';
const SOURCE_IMAGE_SIDECAR = '_source_image.txt';

const SESSION_TRACE_MAX_EVENTS = 200;

// ── Watchdog scope ────────────────────────────────────────────────────

// Refuse is deliberately NOT counted — it is the row's escape terminal
// when other tools have hit the cap. Including it would create a trap
// where a watchdog-terminated session cannot honestly refuse.
export const WATCHDOG_COUNTED_TOOLS: readonly string[] = Object.freeze([
  'validate_graph',
  'crop_source_image',
  'build_from_graph',
  'render_canvas',
  'export_smiles',
]);

// ── Public schema for unresolved targets ──────────────────────────────

export type UnresolvedTarget = {
  record_id: string;
  field: string;
  x_center: number;
  y_center: number;
  bbox_radius: number;
  round: number;
};

export type UnresolvedTargetsFile = {
  ok: boolean;
  round: number;
  rowId: string;
  targets: UnresolvedTarget[];
  // Dense-vision (plan 2026-05-31 §4.3; decoupled 2026-06-02). When the validated
  // draft is a dense candidate (isDenseCandidate: heavy >= 18, declaration-
  // independent, LATCHED across rounds), the crop-after-validate gate is relaxed so
  // the agent may self-direct zoom-verify crops. Optional + absent ⇒ the strict
  // gate is preserved (back-compat).
  dense?: boolean;
  // Tranche-B′ black box: the black_box_regions committed in THIS round,
  // persisted so the next round's validate_graph can enforce the structural
  // freeze (checkBlackBoxFreeze) — later rounds may only ADD interior. Absent ⇒
  // nothing committed yet (back-compat / non-dense rows).
  committedRegions?: BlackBoxRegion[];
  // Dense-stereo advisory (2026-06-01): the per-center stereocenter crop
  // worklist (GraphIntent intent-id space) that build_from_graph computed for
  // the LAST build of this row, persisted so the NEXT validate_graph round can
  // re-surface it as a WARNING diagnostic (option-C tail; lagged-by-one).
  // Absent ⇒ no advisory last build (back-compat / sparse / fully-wedged).
  stereoAdvisoryCenters?: number[];
};

export type SessionEvent = {
  tool: string;
  rowId: string;
  ts: number;
  args?: Record<string, unknown>;
  result?: {
    ok: boolean;
    error_code?: string;
    graph_hash?: string;
    // For tool: 'validate_graph' — full (record_id, field) list of
    // unresolved targets in the round. The refusal classifier uses
    // this to detect "same target stuck across rounds" by strict set
    // intersection, replacing the older `unresolved_count > 0` proxy.
    // Optional for back-compat with trace events emitted before the
    // overlap-check change.
    unresolved_records?: Array<{ record_id: string; field: string }>;
    [key: string]: unknown;
  };
};

// ── Atomic write helper ───────────────────────────────────────────────

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

// ── Unresolved targets sidecar (T1) ──────────────────────────────────

export function readUnresolvedTargets(
  outputDir: string,
): UnresolvedTargetsFile | null {
  const path = join(outputDir, UNRESOLVED_SIDECAR);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as UnresolvedTargetsFile;
  } catch {
    return null;
  }
}

export function writeUnresolvedTargets(
  outputDir: string,
  file: UnresolvedTargetsFile,
): void {
  const path = join(outputDir, UNRESOLVED_SIDECAR);
  writeAtomic(path, JSON.stringify(file, null, 2) + '\n');
}

// ── Turn counter sidecar (T4) ─────────────────────────────────────────

export function readTurnCount(outputDir: string): number {
  const path = join(outputDir, TURN_COUNT_SIDECAR);
  if (!existsSync(path)) return 0;
  try {
    const n = parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function incrementTurnCount(outputDir: string): number {
  const next = readTurnCount(outputDir) + 1;
  const path = join(outputDir, TURN_COUNT_SIDECAR);
  writeAtomic(path, `${next}\n`);
  return next;
}

// ── Source-image path sidecar (Task 4A) ──────────────────────────────

// `validate_graph` is stateless — the agent supplies `sourceImagePath`
// only on the call where it has it. The bidirectional pixel-grounding
// pass needs that path on EVERY call for the row, so it is persisted into
// a tiny per-row sidecar on first sight and recovered on later calls. The
// outputDir is keyed (via resolveRowState) off the same path hash, so the
// recovery is row-scoped.

export function readSourceImagePath(outputDir: string): string | null {
  const path = join(outputDir, SOURCE_IMAGE_SIDECAR);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function writeSourceImagePath(
  outputDir: string,
  sourceImagePath: string,
): void {
  const path = join(outputDir, SOURCE_IMAGE_SIDECAR);
  writeAtomic(path, `${sourceImagePath}\n`);
}

// ── Session trace sidecar (T1b / T2) ──────────────────────────────────

export function readSessionTrace(outputDir: string): SessionEvent[] {
  const path = join(outputDir, SESSION_TRACE_SIDECAR);
  if (!existsSync(path)) return [];
  try {
    const arr = JSON.parse(readFileSync(path, 'utf8')) as SessionEvent[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function appendSessionEvent(
  outputDir: string,
  event: SessionEvent,
): void {
  const events = readSessionTrace(outputDir);
  events.push(event);
  // Bound disk usage. Older events drop first.
  const trimmed =
    events.length > SESSION_TRACE_MAX_EVENTS
      ? events.slice(-SESSION_TRACE_MAX_EVENTS)
      : events;
  const path = join(outputDir, SESSION_TRACE_SIDECAR);
  writeAtomic(path, JSON.stringify(trimmed, null, 2) + '\n');
}

// ── T1 proximity geometry ─────────────────────────────────────────────

/**
 * Returns true when the crop window centered at `(x, y)` with side length
 * `min(w, h)` lies within `0.25 × min(w, h)` of any named target center.
 * The 0.25 factor matches the T1 design in the plan.
 */
export function proximityHit(
  targets: UnresolvedTarget[],
  x: number,
  y: number,
  w: number,
  h: number,
): UnresolvedTarget | null {
  const slack = 0.25 * Math.min(w, h);
  for (const t of targets) {
    const dx = t.x_center - x;
    const dy = t.y_center - y;
    if (Math.hypot(dx, dy) <= slack + t.bbox_radius) return t;
  }
  return null;
}

/**
 * Returns the nearest target to the given (x, y) by Euclidean distance,
 * or null when the list is empty. Used to produce a hint when a crop center
 * does not match any named validate_graph region.
 */
export function nearestTarget(
  targets: UnresolvedTarget[],
  x: number,
  y: number,
): UnresolvedTarget | null {
  let best: UnresolvedTarget | null = null;
  let bestD = Infinity;
  for (const t of targets) {
    const d = Math.hypot(t.x_center - x, t.y_center - y);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

// ── Session-default resolver (T1 production catch-22 fix) ─────────────

let processSessionUuid: string | null = null;

function sessionUuid(): string {
  if (processSessionUuid == null) processSessionUuid = randomUUID();
  return processSessionUuid;
}

// Session-sticky row binding. The row directory is a property of the
// session (one MCP server = one Ketcher canvas = one molecule's lifetime),
// not of each individual call. The first call that carries any anchor
// (explicit outputDir+rowId, or sourceImagePath) RECORDS the resolved row
// here; a later call that carries NONE inherits it instead of minting a
// fresh divergent dir. That is what lets render_canvas / export_smiles /
// refuse — which production agents call without anchors — write into the
// SAME _session_trace.json as the preceding validate_graph /
// build_from_graph. A new anchor (new image or new explicit dir) re-binds,
// so sequential rows sharing one persistent server do not bleed. The source
// image is carried alongside so a follow-up same-image call with no explicit
// outputDir (crop_source_image) can match-and-inherit instead of forking
// (the F5 crop_before_validate footgun).
let lastResolvedRow: {
  outputDir: string;
  rowId: string;
  sourceImagePath: string | null;
} | null = null;

/**
 * Visible only to tests: reset the process-wide session uuid AND the
 * sticky row binding so each suite starts with a clean session.
 */
export function _resetSessionUuidForTest(): void {
  processSessionUuid = null;
  lastResolvedRow = null;
}

export type RowStateArgs = {
  rowId?: unknown;
  outputDir?: unknown;
  sourceImagePath?: unknown;
};

export type ResolvedRowState = {
  outputDir: string;
  rowId: string;
  defaulted: boolean;
};

// Same-image identity for the P2 session-sticky inherit. Fast path: exact
// string equality. Fallback: canonicalize via realpathSync. The server
// rewrites a tool's sourceImagePath to a `<outputDir>/source.png` symlink
// (renameImageHandle, T6 path indirection), and validate.run RE-records THAT
// symlink into lastResolvedRow (validate.ts resolveRowState(parsed.sourceImagePath)).
// A later crop_source_image carries the ORIGINAL path, so the two differ as
// strings but resolve to the same real file — realpath makes the inherit
// survive the rewrite while keeping genuinely different images distinct. If a
// path is unresolvable (missing/broken symlink), fall back to no-match (safe:
// the call forks rather than inheriting the wrong row).
function sameImagePath(a: string | null, b: string): boolean {
  if (!a) return false;
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function resolveRowState(args: RowStateArgs): ResolvedRowState {
  const rawOutputDir = typeof args.outputDir === 'string' ? args.outputDir : '';
  const rawRowId = typeof args.rowId === 'string' ? args.rowId : '';
  const rawSourceImagePath =
    typeof args.sourceImagePath === 'string' ? args.sourceImagePath : '';
  // (1) Explicit anchors — authoritative. Record as the session row so
  //     subsequent anchorless calls (export_smiles / render_canvas /
  //     refuse) inherit it.
  if (rawOutputDir && rawRowId) {
    mkdirSync(rawOutputDir, { recursive: true });
    lastResolvedRow = {
      outputDir: rawOutputDir,
      rowId: rawRowId,
      sourceImagePath: rawSourceImagePath || null,
    };
    return { outputDir: rawOutputDir, rowId: rawRowId, defaulted: false };
  }

  // (1b) rowId present, NO explicit outputDir — derive a deterministic
  //      per-rowId dir. Solution #2 (enforce rowId): rowId is the row
  //      identity, so the dir + trace key off it just like the canvas does.
  //      rowId wins over sourceImagePath here so validate_graph(rowId,image)
  //      and build_from_graph(rowId) resolve to the SAME dir — keeping the
  //      validate→build trace gate row-scoped without a process-global. A
  //      missing outputDir is the production norm now that every canvas tool
  //      requires rowId; the racy `lastResolvedRow` inherit (branch 3) is no
  //      longer on the production path.
  if (rawRowId) {
    const sig = createHash('sha256').update(rawRowId).digest('hex').slice(0, 12);
    const outputDir = join(tmpdir(), `ketcher-row-${sig}`);
    mkdirSync(outputDir, { recursive: true });
    lastResolvedRow = {
      outputDir,
      rowId: rawRowId,
      sourceImagePath: rawSourceImagePath || null,
    };
    return { outputDir, rowId: rawRowId, defaulted: true };
  }

  // (2) sourceImagePath present — hash it with the pid into a 12-char
  //     callSig. Same image in the same process → same dir (idempotent
  //     across the row's tool sequence); different images → different
  //     dirs. Record as the session row. `defaulted` reflects whether the
  //     CALLER passed explicit outputDir+rowId (it did not, fully, here),
  //     independent of routing — so the build-dump opt-in stays test-only.
  if (rawSourceImagePath) {
    // P2 session-sticky inherit: a follow-up call carrying the SAME source
    // image but NO explicit outputDir (e.g. crop_source_image after the row's
    // validate_graph) rides the row already established for this image instead
    // of forking to a divergent source-hash dir (the F5 crop_before_validate
    // footgun). A DIFFERENT image re-binds below, so multi-image batches in one
    // process don't bleed into each other.
    if (
      !rawOutputDir &&
      lastResolvedRow &&
      sameImagePath(lastResolvedRow.sourceImagePath, rawSourceImagePath)
    ) {
      return {
        outputDir: lastResolvedRow.outputDir,
        rowId: lastResolvedRow.rowId,
        defaulted: true,
      };
    }
    const callSig = createHash('sha256')
      .update(rawSourceImagePath)
      .update(String(process.pid))
      .digest('hex')
      .slice(0, 12);
    const defaultDir = join(tmpdir(), `ketcher-row-${callSig}`);
    const outputDir = rawOutputDir || defaultDir;
    const rowId = rawRowId || `default-${callSig}`;
    mkdirSync(outputDir, { recursive: true });
    lastResolvedRow = { outputDir, rowId, sourceImagePath: rawSourceImagePath };
    return { outputDir, rowId, defaulted: !rawOutputDir || !rawRowId };
  }

  // (3) No anchors AND no sourceImagePath — inherit the session row already
  //     established by an earlier anchored call. This is the production
  //     path for export_smiles / render_canvas / refuse, which carry no
  //     anchors: they ride the row that validate_graph / build_from_graph
  //     established. Without this, they would silently fork to a fresh dir
  //     (root cause of the I001 export-provenance failure).
  if (lastResolvedRow) {
    return {
      outputDir: lastResolvedRow.outputDir,
      rowId: lastResolvedRow.rowId,
      defaulted: true,
    };
  }

  // (4) Genuinely first call with nothing set — per-process sessionUuid
  //     singleton (back-compat for single-process callers). Record it so
  //     later anchorless calls stay consistent.
  const defaultDir = join(tmpdir(), `ketcher-row-${sessionUuid()}`);
  mkdirSync(defaultDir, { recursive: true });
  lastResolvedRow = { outputDir: defaultDir, rowId: 'default', sourceImagePath: null };
  return { outputDir: defaultDir, rowId: 'default', defaulted: true };
}

// ── T6 source-image path indirection ──────────────────────────────────

/**
 * Resolve the agent-supplied `sourcePath` to a per-row symlink at
 * `<outputDir>/source<ext>`. Subsequent calls in the same row return the
 * same handle. Original file is untouched (and remains readable through
 * its original path for evaluator vision-compare).
 */
export function renameImageHandle(
  sourcePath: string,
  outputDir: string,
): string {
  if (!existsSync(sourcePath)) return sourcePath;
  const ext = extname(sourcePath) || '.png';
  const handle = join(outputDir, `source${ext}`);
  mkdirSync(outputDir, { recursive: true });
  if (existsSync(handle)) {
    try {
      const stat = lstatSync(handle);
      if (stat.isSymbolicLink()) {
        const current = readlinkSync(handle);
        if (current === sourcePath) return handle;
      }
    } catch {
      // Fall through to recreate.
    }
    return handle;
  }
  try {
    symlinkSync(sourcePath, handle);
  } catch {
    // Symlink creation may fail on some filesystems; fall back to original path.
    return sourcePath;
  }
  return handle;
}

// ── T4 watchdog helper (testable wrapper used by server.ts) ──────────

export const WATCHDOG_DEFAULT_CAP = 50;

export type WatchdogTerminated = {
  ok: false;
  error: {
    code: 'session_terminated';
    message: string;
    details: { cap: number; used: number };
  };
};

export function watchdogEnabled(): boolean {
  return process.env.KETCHER_WATCHDOG !== '0';
}

export function watchdogCap(): number {
  const raw = process.env.KETCHER_AGENT_TURN_CAP;
  if (!raw) return WATCHDOG_DEFAULT_CAP;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : WATCHDOG_DEFAULT_CAP;
}

/**
 * Increment the row's turn counter and return a terminated response if
 * the count has exceeded `watchdogCap()`. Returns null when under cap
 * or when the watchdog is disabled, in which case the caller proceeds
 * with the tool invocation normally.
 *
 * The terminated error message is invariant — no integers, no "budget"
 * / "cap" / "turn" / "LOCK" token, so the agent has no numeric signal
 * to optimize against.
 */
export function evaluateWatchdog(
  toolName: string,
  args: RowStateArgs,
  capOverride?: number,
): WatchdogTerminated | null {
  if (!watchdogEnabled()) return null;
  if (!WATCHDOG_COUNTED_TOOLS.includes(toolName)) return null;
  const { outputDir, rowId } = resolveRowState(args);
  const used = incrementTurnCount(outputDir);
  const cap = capOverride ?? watchdogCap();
  if (used > cap) {
    // Record the termination in the session trace so the refusal
    // classifier can see it and emit `session_capped` when the agent
    // calls `refuse` as the escape terminal.
    appendSessionEvent(outputDir, {
      tool: toolName,
      rowId,
      ts: Date.now(),
      args: {},
      result: { ok: false, error_code: 'session_terminated' },
    });
    return {
      ok: false,
      error: {
        code: 'session_terminated',
        message:
          'This session has been terminated by the runtime. Start a new session to continue.',
        details: { cap, used },
      },
    };
  }
  return null;
}

// ── T5 numeric-telemetry scrub ────────────────────────────────────────

export const SCRUB_TELEMETRY_ENABLED = () =>
  process.env.KETCHER_SCRUB_TELEMETRY !== '0';

/**
 * Strip LOCK tokens and numeric thresholds from agent-facing text. Used
 * on `message` / `note` / `suggestion` fields so the agent has no
 * numbers to optimize against. Telemetry remains in non-message fields
 * (e.g. `error.details`) for operator post-mortem.
 *
 * Conservative regex set; no-op when SCRUB flag is OFF so Phase 1 ships
 * dark.
 */
export function scrubAgentText(input: string): string {
  if (!SCRUB_TELEMETRY_ENABLED()) return input;
  let s = input;
  s = s.replace(/LOCK\s*\d+/gi, 'the contract');
  s = s.replace(/\b(14|13|12|10|8|6|5|4|3|2)\s+(backend\s+turns?|crops?|validate(?:_graph)?\s+rounds?|reads?)\b/gi, 'too many $2');
  s = s.replace(/\b(800|400|300|200|150)\s*px\b/gi, 'this resolution');
  s = s.replace(/min\([wh],\s*[wh]\)\s*=\s*\d+\s*</gi, 'source min dimension');
  s = s.replace(/<\s*300\b/g, 'below the supported resolution floor');
  s = s.replace(/budget|cap|tile_count|tile_budget(?:_used|_remaining)?/gi, '');
  // Collapse double spaces created by the replacements
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

// ── Stable hash for GraphIntent identity (T1b) ───────────────────────

/**
 * Deterministic SHA-256 hash of a structured value via JSON.stringify
 * with sorted keys at every level. Used to verify that the graph
 * submitted to `build_from_graph` is byte-identical to the graph
 * accepted by `validate_graph` (T1b validate-bait-and-switch defense).
 */
export function stableHash(value: unknown): string {
  const canonical = stringifyStable(value);
  return createHash('sha256').update(canonical).digest('hex');
}

function stringifyStable(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stringifyStable).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${stringifyStable(v)}`)
      .join(',')}}`;
  }
  return 'null';
}
