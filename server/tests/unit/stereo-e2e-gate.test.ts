/**
 * Task 6C — pins the shared stereo e2e gate's skip-closed predicate.
 *
 * These are FAST unit tests (no Chromium, no real Indigo): `fetch` is stubbed
 * and a fake runtime records the `start` options. They pin the gate's two
 * load-bearing guarantees independent of the live Indigo state:
 *
 *   1. Indigo reachable → gate is `ready` AND the runtime is started in
 *      REMOTE mode (never standalone). This is the actual 6C fix: by OWNING
 *      the start and forcing `mode: 'remote'`, the gate makes the
 *      "Indigo-up-but-standalone false-RED" structurally impossible for the
 *      stereo e2e blocks.
 *   2. Indigo unreachable → gate is NOT ready, the runtime is NEVER started,
 *      and `stop()` is a no-op. Down → genuine skip, not a failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  indigoReachable,
  startStereoGate,
} from '../fixtures/stereo-e2e-gate';
import type { KetcherRuntime } from '../../src/mcp/runtime';

/** Minimal fake runtime: records start options + stop calls; no browser. */
function makeFakeRuntime() {
  const startCalls: Array<{ mode?: string; remoteApiPath?: string }> = [];
  let stopCount = 0;
  const runtime = {
    async start(options: { mode?: string; remoteApiPath?: string } = {}) {
      startCalls.push(options);
    },
    async stop() {
      stopCount += 1;
    },
  };
  return {
    runtime: runtime as unknown as KetcherRuntime,
    startCalls,
    stopCount: () => stopCount,
  };
}

const BASE = 'http://indigo.test/v2/';

function stubFetch(impl: (url: string) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    return Promise.resolve(impl(url));
  }));
}

function okInfo(): Response {
  return new Response(JSON.stringify({ indigo_version: '1.43.0' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('indigoReachable', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('true when /info returns a string indigo_version', async () => {
    stubFetch(() => okInfo());
    expect(await indigoReachable(BASE)).toBe(true);
  });

  it('false on a non-2xx response', async () => {
    stubFetch(() => new Response('nope', { status: 503 }));
    expect(await indigoReachable(BASE)).toBe(false);
  });

  it('false when indigo_version is absent / non-string', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ imago_versions: ['2.0.0'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    expect(await indigoReachable(BASE)).toBe(false);
  });

  it('false (skip-closed) when fetch rejects (network down)', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    expect(await indigoReachable(BASE)).toBe(false);
  });
});

describe('startStereoGate skip-closed predicate (Task 6C)', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('Indigo reachable → ready AND runtime started in REMOTE mode', async () => {
    stubFetch(() => okInfo());
    const { runtime, startCalls, stopCount } = makeFakeRuntime();

    const gate = await startStereoGate(runtime, BASE);

    expect(gate.indigoUp).toBe(true);
    expect(gate.startedRemote).toBe(true);
    expect(gate.ready).toBe(true);
    expect(gate.skipReason).toBe('');

    // THE 6C FIX: the gate owns the start and forces remote — never standalone.
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]).toEqual({ mode: 'remote', remoteApiPath: BASE });

    await gate.stop();
    expect(stopCount()).toBe(1); // started → stop tears down
  });

  it('Indigo unreachable → NOT ready, runtime NEVER started, stop() is a no-op', async () => {
    stubFetch(() => new Response('down', { status: 502 }));
    const { runtime, startCalls, stopCount } = makeFakeRuntime();

    const gate = await startStereoGate(runtime, BASE);

    expect(gate.indigoUp).toBe(false);
    expect(gate.startedRemote).toBe(false);
    expect(gate.ready).toBe(false);
    expect(gate.skipReason).toMatch(/Indigo unreachable/);

    // No runtime started → no wasted Chromium launch; a genuine skip.
    expect(startCalls).toHaveLength(0);

    await gate.stop();
    expect(stopCount()).toBe(0); // never started → stop is a no-op
  });
});
