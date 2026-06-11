/**
 * Test-only client for `test-daemon.ts`. Drop-in replacement for
 * `new KetcherRuntime()` inside test tsx scripts — but instead of spawning
 * a fresh Chromium + Ketcher (which costs ~2.2s), it connects to the
 * already-running daemon and reuses one of its persistent runtime slots.
 *
 * Usage in a subagent tsx script:
 *
 *   import { RuntimeClient } from '/abs/path/server/scripts/test-daemon-client';
 *   const rt = new RuntimeClient({ slot: Number(process.env.KETCHER_SLOT ?? 0) });
 *   await rt.connect();
 *   await rt.callBridge('clearCanvas');
 *   await rt.callBridge('loadSmiles', 'c1ccccc1');
 *   console.log('SMILES:', await rt.exportSmiles());
 *   await rt.disconnect();
 */
import * as net from 'node:net';

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type RuntimeClientOptions = {
  slot?: number;
  socket?: string;
};

export class RuntimeClient {
  private sock!: net.Socket;
  private slot: number;
  private socketPath: string;
  private nextId = 1;
  private pending = new Map<number, PendingResolver>();
  private rxBuf = '';

  constructor(opts: RuntimeClientOptions = {}) {
    this.slot = opts.slot ?? Number(process.env.KETCHER_SLOT ?? 0);
    this.socketPath = opts.socket ?? process.env.KETCHER_DAEMON_SOCKET ?? '/tmp/ketcher-daemon.sock';
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const s = net.connect(this.socketPath, () => resolve());
      s.on('error', (err) => {
        if (this.pending.size === 0) reject(err);
        else this.failAll(err);
      });
      s.on('data', (chunk) => this.onData(chunk.toString('utf8')));
      s.on('close', () => this.failAll(new Error('daemon connection closed')));
      this.sock = s;
    });
  }

  private onData(chunk: string): void {
    this.rxBuf += chunk;
    let nl: number;
    while ((nl = this.rxBuf.indexOf('\n')) !== -1) {
      const line = this.rxBuf.slice(0, nl);
      this.rxBuf = this.rxBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: { id: number; ok: boolean; result?: unknown; error?: string; details?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const pend = this.pending.get(msg.id);
      if (!pend) continue;
      this.pending.delete(msg.id);
      if (msg.ok) pend.resolve(msg.result);
      else {
        const err = new Error(msg.error ?? 'daemon error');
        (err as unknown as { details?: unknown }).details = msg.details;
        pend.reject(err);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private async send(method: string, args: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(JSON.stringify({ id, slot: this.slot, method, args }) + '\n');
    });
  }

  // ---- KetcherRuntime-compatible surface ----

  async callBridge<T>(methodName: string, ...args: unknown[]): Promise<T> {
    return (await this.send('callBridge', [methodName, ...args])) as T;
  }

  async getState(includeMolfile = false): Promise<unknown> {
    return await this.send('getState', [includeMolfile]);
  }

  async getAnnotatedState(): Promise<unknown> {
    return await this.send('getAnnotatedState', []);
  }

  async exportSmiles(): Promise<string | null> {
    return (await this.send('exportSmiles', [])) as string | null;
  }

  async getLastDenseExportCertificate(): Promise<unknown> {
    return await this.send('getLastDenseExportCertificate', []);
  }

  async getLastDensePhase1Certificate(): Promise<unknown> {
    return await this.send('getLastDensePhase1Certificate', []);
  }

  async getLastDenseEvidenceEnvelope(): Promise<unknown> {
    return await this.send('getLastDenseEvidenceEnvelope', []);
  }

  async exportKet(): Promise<string | null> {
    return (await this.send('exportKet', [])) as string | null;
  }

  async exportMolfile(): Promise<string | null> {
    return (await this.send('exportMolfile', [])) as string | null;
  }

  async listRecentEvents(limit = 20): Promise<unknown> {
    return await this.send('listRecentEvents', [limit]);
  }

  /**
   * Convenience: build_from_graph wrapped in applyMutation. Optional
   * `forensics` carries per-call overrides for the
   * `KETCHER_BUILD_DUMP_DIR` / `KETCHER_FINGERPRINT_DUMP_DIR` /
   * `KETCHER_BUILD_DUMP_ROW_ID` env vars (the render-diff layer was
   * deleted along with its `KETCHER_RENDER_DIFF_DUMP_DIR`). Pass these
   * when running under the test daemon — concurrent
   * slot builds share daemon process env and would otherwise race on
   * the row-id prefix used in the fingerprint sidecar filenames.
   *
   * Optional `sourceImageRef` (Stage R.4) routes the image-fixture
   * path or bytes through to `TranslatorOptions.sourceImageRef`.
   * Non-image rows pass undefined.
   */
  async buildFromGraph(
    graph: unknown,
    forensics?: {
      rowId?: string;
      buildDumpDir?: string;
      fingerprintDumpDir?: string;
    },
    sourceImageRef?:
      | { kind: 'path'; value: string }
      | { kind: 'bytes'; value: Uint8Array },
  ): Promise<unknown> {
    if (sourceImageRef !== undefined) {
      return await this.send('buildFromGraph', [graph, forensics ?? null, sourceImageRef]);
    }
    if (forensics !== undefined) {
      return await this.send('buildFromGraph', [graph, forensics]);
    }
    return await this.send('buildFromGraph', [graph]);
  }

  async disconnect(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sock.end(() => resolve());
    });
  }

  /** Convenience: ping the daemon to verify connectivity. */
  async ping(): Promise<string> {
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as string),
        reject,
      });
      this.sock.write(JSON.stringify({ id, ping: true }) + '\n');
    });
  }

  /** Send an explicit shutdown command to the daemon. */
  async requestShutdown(): Promise<void> {
    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        reject,
      });
      this.sock.write(JSON.stringify({ id, shutdown: true }) + '\n');
    });
  }
}
