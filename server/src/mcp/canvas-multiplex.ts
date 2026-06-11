/**
 * Per-canvas-key multiplex policy for the shared Ketcher page.
 *
 * Pure (no I/O, no Chromium): given a requested key and whether the caller
 * anchored it explicitly, decide whether the runtime should switch the live
 * canvas, leave it (noop), or reject the call (strict-anchor violation). The
 * runtime performs the actual KET save/restore based on this decision.
 *
 * `canvasKey` is the caller-supplied work-unit id (the image-rebuild `rowId`).
 * It is deliberately a plain string, not an MCP transport session id — stdio
 * has no session concept and HTTP session ids are non-standard, so a
 * caller-supplied id is the portable key across agentic frameworks.
 */

export const DEFAULT_CANVAS_KEY = '__default_canvas__';

/** State paged per key. `visionFingerprint` is opaque here (typed in runtime). */
export interface CanvasState {
  ket: string | null;
  visionFingerprint: unknown;
  smilesExportErrored: boolean;
}

export type BindDecision =
  | { kind: 'noop' }
  | { kind: 'reject'; key: string }
  | { kind: 'switch'; key: string; evictKey: string | null };

/**
 * Thrown when a canvas-touching call in a strict (parallel) session did not
 * carry an explicit key and would otherwise inherit whatever row is currently
 * bound — the silent cross-row contamination footgun.
 */
export class CanvasAnchorError extends Error {
  constructor(public readonly attemptedKey: string) {
    super(
      'Canvas access in a strict (parallel) session requires an explicit rowId anchor; ' +
        'this call carried none and was rejected to prevent cross-row canvas contamination. ' +
        'Pass rowId on every build_from_graph / render_canvas / export_smiles / refuse call.',
    );
    this.name = 'CanvasAnchorError';
  }
}

export class CanvasMultiplex {
  private _currentKey: string | null = null;

  get currentKey(): string | null {
    return this._currentKey;
  }

  /**
   * Decide the bind action. Does NOT mutate currentKey — the runtime calls
   * `commit(key)` after a successful page-in so a mid-swap failure leaves the
   * policy pointing at the last good key.
   */
  next(
    requestedKey: string | null,
    explicit: boolean,
    strict: boolean,
  ): BindDecision {
    if (strict && !explicit) {
      const attempted = requestedKey ?? this._currentKey ?? DEFAULT_CANVAS_KEY;
      return { kind: 'reject', key: attempted };
    }
    const effectiveKey =
      requestedKey ?? this._currentKey ?? DEFAULT_CANVAS_KEY;
    if (this._currentKey === effectiveKey) {
      return { kind: 'noop' };
    }
    return { kind: 'switch', key: effectiveKey, evictKey: this._currentKey };
  }

  commit(key: string): void {
    this._currentKey = key;
  }
}

/**
 * Tools that do NOT touch the shared Ketcher canvas — pure preflight, file
 * writes, or static lookups. They take `_runtime` and never read or mutate the
 * canvas or runtime mutable state; their only side effects are per-row atomic
 * sidecar writes (row-state.ts `writeAtomic`), which are concurrency-safe. So
 * they skip BOTH canvas binding and the serialization queue. Everything NOT
 * listed here is treated as a canvas tool (binds by key) so a new/unlisted tool
 * fails safe (bound) rather than unbound. The allowlist is the contract: if a
 * future tool added here DOES touch the canvas, the queue-bypass corrupts.
 * (load_canonical mutates the canvas via loadSmiles — it is deliberately NOT
 * here.)
 */
export const CANVAS_FREE_TOOLS = new Set<string>([
  'validate_graph',
  'crop_source_image',
  'refuse',
  'list_canonical',
  'render_pdf_region',
  'crop_molecule',
]);

export type CanvasRouting =
  | { isCanvasFree: true }
  | {
      isCanvasFree: false;
      bind: { requestedKey: string | null; explicit: boolean; strict: boolean };
    };

/**
 * Classify an incoming tool call for canvas routing. Pure — captures the
 * CALLER's explicit rowId from the RAW args (call this BEFORE any server-side
 * resolveRowState backfill) so an inherited/defaulted rowId is correctly
 * treated as non-explicit under strict mode.
 */
export function resolveCanvasRouting(
  toolName: string,
  rawArgs: Record<string, unknown>,
  strict: boolean,
): CanvasRouting {
  if (CANVAS_FREE_TOOLS.has(toolName)) {
    return { isCanvasFree: true };
  }
  const callerRowId =
    typeof rawArgs.rowId === 'string' && rawArgs.rowId.length > 0
      ? rawArgs.rowId
      : null;
  return {
    isCanvasFree: false,
    bind: { requestedKey: callerRowId, explicit: callerRowId !== null, strict },
  };
}
