import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import { SnapshotStore } from '../adapter/snapshot';
import { diffState } from '../adapter/diff';
import {
  CanvasMultiplex,
  CanvasAnchorError,
  type CanvasState,
} from './canvas-multiplex';
// AgentState is the TRUTHFUL serialized canvas shape the bridge returns
// (atoms carry x/y; molfile/hasExportFailure/exportErrorMessage present).
// diff.ts declares a narrower local shape for diffState's params only; the
// bridge superset is assignable to it, so diffState(state) still typechecks.
import type { AgentState } from '../ui/bridge';
import {
  computeVisionCheckCandidate,
  type FingerprintAtom,
  type FingerprintBond,
  type VisionCheckCandidate,
} from '../adapter/graph-intent/vision-fingerprint';

const execFileAsync = promisify(execFile);

/**
 * Download the Chromium build this package's Playwright dep expects. Resolves
 * the CLI bundled with THAT exact Playwright (via its package.json) and runs it
 * with the current Node binary — never `npx playwright`, which resolves from
 * PATH / the npx cache and can fetch a mismatched revision or fight an in-flight
 * `__dirlock`. Called lazily from `launchChromium` on the slow first-run path so
 * the npm install can stay light enough to clear Claude Code's 30s MCP timeout.
 */
async function installChromium(): Promise<void> {
  const require = createRequire(import.meta.url);
  const cliDir = path.dirname(require.resolve('playwright/package.json'));
  const cli = path.join(cliDir, 'cli.js');
  await execFileAsync(process.execPath, [cli, 'install', 'chromium'], {
    // The download streams progress to stdout/stderr for minutes; default 1 MB
    // maxBuffer would abort it. 64 MB is ample headroom.
    maxBuffer: 64 * 1024 * 1024,
  });
}

type EventRecord = {
  type: string;
  timestamp: string;
  detail?: string;
};

type RuntimeMode = 'standalone' | 'remote';

type RuntimeStartOptions = {
  mode?: RuntimeMode;
  remoteApiPath?: string;
};

export type RuntimeMutationResult = {
  operation: string;
  params: Record<string, unknown>;
  before: AgentState;
  after: AgentState;
  beforeSnapshotId: string;
  afterSnapshotId: string;
  beforeKetHash: string;
  afterKetHash: string;
  /**
   * Flat summary from `diffState(before, after)` — use `updatedAtoms` / `updatedBonds` /
   * `createdAtomIds` / … not a nested `{ atoms: { updated } }` shape.
   */
  diff: ReturnType<typeof diffState>;
  events: EventRecord[];
};

type PublicAgentState = AgentState & {
  ket: string | null;
  molfile: string | null;
};

export type RuntimeMutationFailure = {
  operation: string;
  params: Record<string, unknown>;
  beforeSnapshotId: string;
  beforeKetHash: string;
  rollbackAttempted: boolean;
  rollbackSucceeded: boolean;
  events: EventRecord[];
  cause: string;
};

export class RuntimeMutationError extends Error {
  readonly code = 'MUTATION_FAILED';
  readonly details: RuntimeMutationFailure;

  constructor(message: string, details: RuntimeMutationFailure) {
    super(message);
    this.name = 'RuntimeMutationError';
    this.details = details;
  }
}

export class RuntimeStructuralValidationError extends Error {
  readonly code = 'EXPORT_VALIDATION_FAILED';
  readonly details: unknown;

  constructor(message: string, details: unknown) {
    super(message);
    this.name = 'RuntimeStructuralValidationError';
    this.details = details;
  }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const DENSE_POLICY_INVALIDATING_BRIDGE_METHODS = new Set([
  'clearCanvas',
  'setMolecule',
  'loadMolfile',
  'setBondOrder',
  'setAtomCharge',
  'setAtomRadical',
  'setAtomElement',
  'setBondStereo',
  'setWedgeBond',
  'setAtomImplicitHCount',
  'setAtomExplicitValence',
  'addAtomWithSingleBond',
  'deleteAtom',
  'addBond',
  'deleteBond',
  'layout',
  'clean',
  'aromatize',
  'dearomatize',
  'resetToSnapshot',
]);

function isAgentState(value: unknown): value is AgentState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.atoms) &&
    Array.isArray(candidate.bonds) &&
    typeof candidate.isEmpty === 'boolean' &&
    typeof candidate.isReaction === 'boolean'
  );
}

function validateStateHasBlockingErrors(checks: unknown): boolean {
  if (checks == null) return false;
  if (typeof checks === 'boolean') return checks === false;
  if (typeof checks === 'string') {
    const text = checks.trim();
    if (!text || /^ok$/i.test(text)) return false;
    return /\berror\b|\binvalid\b|unusual valence|valence overflow|overflow/i.test(text);
  }
  if (Array.isArray(checks)) {
    return checks.some((entry) => validateStateHasBlockingErrors(entry));
  }
  if (typeof checks !== 'object') return false;

  const record = checks as Record<string, unknown>;
  if (record.valid === false || record.ok === false) return true;
  if (record.fatal === true) return true;
  if (Array.isArray(record.errors) && record.errors.length > 0) return true;
  if (typeof record.error === 'string' && record.error.trim().length > 0) return true;
  if (Array.isArray(record.error) && record.error.length > 0) return true;
  if (
    typeof record.severity === 'string' &&
    /error|fatal/i.test(record.severity)
  ) {
    return true;
  }
  if (typeof record.level === 'string' && /error|fatal/i.test(record.level)) {
    return true;
  }
  if (typeof record.type === 'string' && /error|fatal/i.test(record.type)) {
    return true;
  }
  if (typeof record.message === 'string') {
    return validateStateHasBlockingErrors(record.message);
  }
  if (Array.isArray(record.issues)) {
    return record.issues.some((entry) => validateStateHasBlockingErrors(entry));
  }
  return false;
}

function fingerprintFromAnnotatedState(
  annotatedState: unknown,
  canonicalSmiles?: string | null,
): VisionCheckCandidate | null {
  if (!annotatedState || typeof annotatedState !== 'object') return null;
  const annotatedObj = annotatedState as {
    atoms?: Array<{ id: number; label: string; charge?: number }>;
    bonds?: Array<{
      id: number;
      beginAtomId: number;
      endAtomId: number;
      order?: number;
      stereo?: number;
      aromatic?: boolean;
      inRing?: boolean;
    }>;
  };
  if (!Array.isArray(annotatedObj.atoms) || !Array.isArray(annotatedObj.bonds)) {
    return null;
  }
  const atoms: FingerprintAtom[] = annotatedObj.atoms.map((atom) => ({
    id: atom.id,
    label: atom.label,
    charge: atom.charge ?? 0,
  }));
  const bonds: FingerprintBond[] = annotatedObj.bonds.map((bond) => ({
    id: bond.id,
    beginAtomId: bond.beginAtomId,
    endAtomId: bond.endAtomId,
    order: bond.order ?? 1,
    stereo: bond.stereo ?? 0,
    aromatic: bond.aromatic === true,
    inRing: bond.inRing === true,
  }));
  return computeVisionCheckCandidate({
    atoms,
    bonds,
    drawnHAtomIds: [],
    canonicalSmiles,
  });
}

function areDenseFingerprintsStable(
  expected: VisionCheckCandidate | null,
  actual: VisionCheckCandidate | null,
): boolean {
  if (!expected || !actual) return expected === actual;
  const project = (value: VisionCheckCandidate) => ({
    heavy: value.heavy,
    rings: value.rings,
    ring_connectivity: value.ring_connectivity,
    wedges: value.wedges,
    cis_trans_count: value.cis_trans_count,
    charges: value.charges,
    arene_substitution_pattern: value.arene_substitution_pattern,
    ring_heteroatom_positions: value.ring_heteroatom_positions,
    ring_atom_walks: value.ring_atom_walks,
  });
  return JSON.stringify(project(expected)) === JSON.stringify(project(actual));
}

const API_PROXY_PREFIX = '/__api/';

function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  remoteApiPath: string,
) {
  const targetPath = (req.url ?? '/').slice(API_PROXY_PREFIX.length);
  const targetUrl = new URL(targetPath, remoteApiPath);
  const doRequest = targetUrl.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers = { ...req.headers, host: targetUrl.host };
  delete headers['origin'];
  delete headers['referer'];

  const proxyReq = doRequest(
    targetUrl,
    { method: req.method, headers },
    (proxyRes) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    },
  );

  proxyReq.on('error', () => {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: 'Indigo API unreachable' }));
  });

  req.pipe(proxyReq, { end: true });
}

export class KetcherRuntime {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private baseUrl: string | null = null;
  // Serialization queue for concurrent tool calls. The Ketcher canvas is a
  // single shared resource — interleaving e.g. one client's loadSmiles with
  // another client's atom-id-based mutation triggers "Atom N was not found"
  // errors (see scientific-test-suite-run/evaluation.md B3). The queue runs
  // tasks strictly FIFO, one at a time, on the runtime instance.
  private taskQueue: Promise<unknown> = Promise.resolve();
  readonly snapshots = new SnapshotStore();
  // Per-key canvas virtualization. The single shared Ketcher page is paged
  // per canvasKey: `canvasStore` holds each evicted key's KET + poison flags,
  // `canvasMultiplex` tracks the live key and the bind/anchor decision.
  private readonly canvasStore = new Map<string, CanvasState>();
  private readonly canvasMultiplex = new CanvasMultiplex();
  // Last successful canvas fingerprint. Retained for HISTORY safeguard 2 —
  // canvas-derived candidate features fed to the advisory
  // `vision_fingerprint_gate` in the grader. Cleared on any canvas-mutating
  // bridge call.
  private lastVisionFingerprint: VisionCheckCandidate | null = null;
  // Narrowed redaction invariant (replaces the deleted dense-export
  // certificate chain). When `true`, the most recent `export_smiles`
  // attempt errored — `exportPublicMolfile` and `exportPublicKet` must
  // also fail-closed on the same canvas to prevent the "wash through
  // molfile/KET and leak it back out" failure class (HISTORY 0.b).
  // Cleared on any canvas-mutating bridge call.
  private lastSmilesExportErrored = false;

  /**
   * Run a task with exclusive access to the runtime. Tasks are serialized
   * FIFO. Task failures don't poison the queue — subsequent tasks still run.
   */
  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.taskQueue.then(() => task(), () => task());
    // Ensure a rejection in `task` doesn't break the chain for later callers.
    this.taskQueue = result.catch(() => undefined);
    return result;
  }

  async start(options: RuntimeStartOptions = {}) {
    if (this.page) return;

    // A previous start() can fail AFTER binding the HTTP server — most likely on
    // the first run, where launchChromium downloads Chromium for minutes and the
    // bootstrap is retried. Close any stale server before re-binding so a retry
    // doesn't leak a listener or fight for the port.
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }

    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const distDir = path.resolve(currentDir, '../../dist/ui');
    const remoteApiPath = options.remoteApiPath;
    this.httpServer = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        if (remoteApiPath && req.url?.startsWith(API_PROXY_PREFIX)) {
          if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
            res.writeHead(204);
            res.end();
            return;
          }
          proxyRequest(req, res, remoteApiPath);
          return;
        }
        const requestPath = req.url && req.url !== '/' ? req.url : '/index.html';
        const normalizedPath = (requestPath.split('?')[0] || '/index.html').replace(
          /^\/+/,
          '',
        );
        const filePath = path.join(distDir, normalizedPath);
        try {
          const body = await readFile(filePath);
          const ext = path.extname(filePath);
          res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
          res.end(body);
        } catch {
          try {
            const html = await readFile(path.join(distDir, 'index.html'));
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(html);
          } catch {
            res.statusCode = 500;
            res.end('UI bundle is missing. Run `npm run build:ui -w server` first.');
          }
        }
      },
    );

    await new Promise<void>((resolve) => {
      this.httpServer?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve runtime HTTP address');
    }
    const params = new URLSearchParams();
    if (options.mode === 'remote') {
      params.set('mode', 'remote');
      params.set('api_path', API_PROXY_PREFIX);
    }
    const query = params.toString();
    this.baseUrl = `http://127.0.0.1:${address.port}${query ? `?${query}` : ''}`;

    this.browser = await this.launchChromium();
    this.page = await this.browser.newPage();
    await this.page.addInitScript(() => {
      if (typeof (globalThis as any).process === 'undefined') {
        (globalThis as any).process = { env: {}, version: '', platform: '' };
      }
    });
    await this.page.goto(this.baseUrl, { waitUntil: 'networkidle' });
    await this.page.waitForFunction(
      () => typeof window.ketcher !== 'undefined' && typeof window.__ketcherAgent !== 'undefined',
      null,
      { timeout: 120000 },
    );

    let state: Awaited<ReturnType<typeof this.getState>> | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        state = await this.getState();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    // B5: Defensively clear any leftover canvas state. This matters when the
    // Playwright page persists between MCP server lifecycles (rare with the
    // current architecture, but observed in N004 of the test suite).
    if (state && !state.isEmpty) {
      try {
        await this.callBridge('clearCanvas');
        state = await this.getState();
      } catch {
        // Best-effort — if the reset fails, fall through with whatever state we have.
      }
    }
    if (state?.ket) {
      this.snapshots.create(state.ket, 'runtime-start');
    }
  }

  /**
   * True once the browser + Ketcher page are live and tools can run. The MCP
   * layer polls this to answer tool calls with BROWSER_INITIALIZING while the
   * background bootstrap (and any first-run Chromium download) is still warming.
   */
  isReady(): boolean {
    return this.page !== null;
  }

  /**
   * Launch headless Chromium, self-healing the first-run case where the browser
   * binary was never downloaded (the npm install skips it to keep the MCP
   * handshake fast). On "Executable doesn't exist" we download Chromium once via
   * the bundled CLI and retry. Any other launch failure is surfaced verbatim —
   * the old webkit fallback only masked the real cause, since webkit is never
   * installed for npm users.
   */
  private async launchChromium(): Promise<Browser> {
    try {
      return await chromium.launch({ headless: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Executable doesn't exist/i.test(message)) {
        // Honor the documented opt-out: with HEIMDALL_SKIP_BROWSER=1 the user
        // pre-seeds the cache themselves (offline / CI), so never auto-download —
        // fail clearly instead.
        if (process.env.HEIMDALL_SKIP_BROWSER === '1') {
          throw new Error(
            'Chromium is not installed and HEIMDALL_SKIP_BROWSER=1 is set. '
              + 'Run `npm run setup` (or `npx playwright install chromium`) to '
              + 'pre-seed the browser, or unset HEIMDALL_SKIP_BROWSER.',
          );
        }
        await installChromium();
        return await chromium.launch({ headless: true });
      }
      throw new Error(`Chromium failed to launch: ${message}`);
    }
  }

  async stop() {
    await this.page?.close();
    await this.browser?.close();
    this.page = null;
    this.browser = null;
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer?.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      this.httpServer = null;
    }
  }

  private ensurePage(): Page {
    if (!this.page) {
      throw new Error('Runtime is not started');
    }
    return this.page;
  }

  async callBridge<T>(methodName: string, ...args: unknown[]): Promise<T> {
    const page = this.ensurePage();
    const result = (await page.evaluate(
      ([name, payload]) => {
        const bridge = window.__ketcherAgent as unknown as Record<string, (...toolArgs: unknown[]) => unknown>;
        const methodName = String(name);
        if (!bridge || typeof bridge[methodName] !== 'function') {
          throw new Error(`Bridge method "${name}" is unavailable`);
        }
        return bridge[methodName](...(payload as unknown[]));
      },
      [methodName, args],
    )) as T;
    if (DENSE_POLICY_INVALIDATING_BRIDGE_METHODS.has(methodName)) {
      this.lastVisionFingerprint = null;
      this.lastSmilesExportErrored = false;
    }
    return result;
  }

  async getState(includeMolfile = false): Promise<AgentState & { ket: string | null; molfile: string | null }> {
    const state = await this.callBridge<unknown>('getState', includeMolfile);
    if (!isAgentState(state)) {
      const preview = JSON.stringify(state)?.slice(0, 300) ?? 'undefined';
      throw new Error(`Unexpected bridge state payload: ${preview}`);
    }
    const typed = state as AgentState & { ket: string | null; molfile: string | null };
    return typed;
  }

  // Narrowed redaction invariant. The dense state machine's
  // certificate-chain redaction is gone, but the "wash it through
  // molfile/KET and leak it back out" defense survives (HISTORY 0.b).
  // If `export_smiles` ever errored on the current canvas, the same
  // canvas also fails-closed on `export_molfile` / `export_ket`.
  // Any canvas-mutating bridge call clears the flag (new canvas, fresh start).
  getPublicMutationResult(result: RuntimeMutationResult): RuntimeMutationResult {
    return result;
  }

  async getPublicState(includeMolfile = false): Promise<PublicAgentState> {
    return await this.getState(includeMolfile);
  }

  async exportSmiles(): Promise<string | null> {
    try {
      const state = await this.getState(false);
      const smiles = state.smiles;
      if (smiles) {
        try {
          await this.callBridge('validateSmilesString', smiles);
        } catch (error) {
          this.lastSmilesExportErrored = true;
          throw new RuntimeStructuralValidationError(
            'exported SMILES failed self-parse; aborting export',
            { smiles, cause: error instanceof Error ? error.message : String(error) },
          );
        }
      }
      this.lastSmilesExportErrored = false;
      return smiles;
    } catch (err) {
      this.lastSmilesExportErrored = true;
      throw err;
    }
  }

  async exportKet(): Promise<string | null> {
    const state = await this.getState(false);
    return state.ket;
  }

  async exportMolfile(): Promise<string | null> {
    return await this.callBridge<string | null>('exportMolfile');
  }

  private assertSerializedExportNotPoisoned(surface: 'ket' | 'molfile'): void {
    if (!this.lastSmilesExportErrored) return;
    throw new RuntimeStructuralValidationError(
      `${surface} export blocked on the current canvas because export_smiles previously errored; mutate the canvas to re-enable.`,
      { surface, reason: 'smiles_export_poisoned_canvas' },
    );
  }

  async exportPublicKet(): Promise<string | null> {
    this.assertSerializedExportNotPoisoned('ket');
    return await this.exportKet();
  }

  async exportPublicMolfile(): Promise<string | null> {
    this.assertSerializedExportNotPoisoned('molfile');
    return await this.exportMolfile();
  }

  /**
   * Bind the shared canvas to `requestedKey` before a canvas-touching tool
   * runs. Snapshots the outgoing key's live state (KET + poison flags) into
   * `canvasStore` and restores the incoming key's. Idempotent on a repeated
   * key (fast path). MUST be called inside `runExclusive` so the swap is
   * atomic with the tool body.
   *
   * @throws CanvasAnchorError when `strict` and the call is not explicitly
   *   anchored (parallel-session contamination guard).
   */
  async bindCanvas(
    requestedKey: string | null,
    opts: { explicit: boolean; strict: boolean },
  ): Promise<void> {
    const decision = this.canvasMultiplex.next(
      requestedKey,
      opts.explicit,
      opts.strict,
    );
    if (decision.kind === 'noop') return;
    if (decision.kind === 'reject') {
      throw new CanvasAnchorError(decision.key);
    }

    // kind === 'switch'. Evict the outgoing key (snapshot live state).
    if (decision.evictKey !== null) {
      this.canvasStore.set(decision.evictKey, {
        ket: await this.exportKet(),
        visionFingerprint: this.lastVisionFingerprint,
        smilesExportErrored: this.lastSmilesExportErrored,
      });
    }

    // Page in the incoming key.
    const incoming = this.canvasStore.get(decision.key);
    this.canvasStore.delete(decision.key); // now live, re-stored on next evict
    if (incoming === undefined) {
      // Cold key -> blank canvas. Skip the clear on the very first bind
      // (start() already cleared the page); clear when switching off a row.
      if (decision.evictKey !== null) {
        await this.callBridge('clearCanvas');
      }
      this.lastVisionFingerprint = null;
      this.lastSmilesExportErrored = false;
    } else {
      // Warm key -> restore its KET + flags. resetToSnapshot / clearCanvas are
      // in DENSE_POLICY_INVALIDATING_BRIDGE_METHODS, so they reset the flags;
      // we then overwrite with the saved values for this key.
      if (incoming.ket && incoming.ket.length > 0) {
        await this.callBridge('resetToSnapshot', incoming.ket);
      } else {
        await this.callBridge('clearCanvas');
      }
      this.lastVisionFingerprint =
        incoming.visionFingerprint as typeof this.lastVisionFingerprint;
      this.lastSmilesExportErrored = incoming.smilesExportErrored;
    }

    this.canvasMultiplex.commit(decision.key);
  }

  async loadMolfile(molfile: string): Promise<void> {
    await this.callBridge<void>('loadMolfile', molfile);
  }

  async getAnnotatedState(): Promise<unknown> {
    return await this.callBridge<unknown>('getAnnotatedState');
  }

  async validateState(): Promise<unknown> {
    return await this.callBridge<unknown>('validateState');
  }


  async listRecentEvents(limit = 20): Promise<EventRecord[]> {
    return await this.callBridge<EventRecord[]>('listRecentEvents', limit);
  }

  async applyMutation(
    operation: string,
    params: Record<string, unknown>,
    mutation: () => Promise<unknown>,
  ): Promise<RuntimeMutationResult> {
    const before = await this.getState(false);
    if (!before.ket) {
      throw new Error('Unable to snapshot state before mutation: KET export failed');
    }
    const beforeSnapshot = this.snapshots.create(before.ket, `${operation}:before`);

    try {
      await mutation();
      const after = await this.getState(false);
      if (!after.ket) {
        throw new Error('Unable to snapshot state after mutation: KET export failed');
      }
      const afterSnapshot = this.snapshots.create(after.ket, `${operation}:after`);
      return {
        operation,
        params,
        before,
        after,
        beforeSnapshotId: beforeSnapshot.id,
        afterSnapshotId: afterSnapshot.id,
        beforeKetHash: beforeSnapshot.ketHash,
        afterKetHash: afterSnapshot.ketHash,
        diff: diffState(before, after),
        events: await this.listRecentEvents(25),
      };
    } catch (error) {
      const mutationMessage = error instanceof Error ? error.message : String(error);
      let rollbackSucceeded = false;
      try {
        await this.callBridge('resetToSnapshot', before.ket);
        rollbackSucceeded = true;
      } catch {
        rollbackSucceeded = false;
      }

      throw new RuntimeMutationError(`Mutation "${operation}" failed: ${mutationMessage}`, {
        operation,
        params,
        beforeSnapshotId: beforeSnapshot.id,
        beforeKetHash: beforeSnapshot.ketHash,
        rollbackAttempted: true,
        rollbackSucceeded,
        events: await this.listRecentEvents(25),
        cause: mutationMessage,
      });
    }
  }
}
