/**
 * Dense-stereo advisory — TIER 2 (offline, fixture-free).
 *
 *   assertNoUndefinedStereoPostBuild faithfulness + graceful-down, with
 *   Indigo's HTTP surface stubbed (fetch) and a fake runtime. Proves the
 *   assert RETURNS the perceived-undefined-AND-skipped set (does NOT throw
 *   when every such center is an explicit skip), still THROWS on an
 *   unaccounted center (the existing gate is untouched), and returns [] when
 *   Indigo is mocked-down / perceives nothing.
 *
 * (TIER 1, the buildStereoAdvisory pure-mapper replay over
 * outputs/dense-stereo-replay/data/graphs.json, was removed: it read a
 * gitignored fixture and red-failed on every fresh clone.)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNoUndefinedStereoPostBuild } from '../../src/adapter/graph-intent/translator';
import { BuildFromGraphError } from '../../src/adapter/graph-intent/errors';
import type { GraphIntent } from '../../src/types/graph-intent';
import type { KetcherRuntime } from '../../src/mcp/runtime';

// ── TIER 2 — assertNoUndefinedStereoPostBuild with Indigo HTTP stubbed ──────

/**
 * Minimal fake runtime: exportMolfile returns a fixed non-empty molfile (its
 * CONTENT is irrelevant — Indigo is stubbed), getState returns a canvas whose
 * atom-array ORDER defines the Indigo-0-based-idx → canvasId mapping.
 */
function makeRuntime(canvasIds: number[]): KetcherRuntime {
  return {
    async exportMolfile() {
      return 'MOCK\nMOLFILE\n';
    },
    async getState() {
      return {
        smiles: null,
        ket: null,
        molfile: null,
        isEmpty: false,
        isReaction: false,
        hasExportFailure: false,
        exportErrorMessage: null,
        atoms: canvasIds.map((id) => ({ id, label: 'C' })),
        bonds: [],
      };
    },
  } as unknown as KetcherRuntime;
}

/**
 * Stub fetch: route Indigo /indigo/check to a fixed stereo message (drives the
 * perceived 0-based idx list), and /indigo/convert (the W5 CIP call) to an
 * empty struct so the W5 path degrades silently. `checkImpl` may throw to
 * simulate Indigo-down on the perception call.
 */
function stubIndigo(checkImpl: () => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/indigo/check')) return Promise.resolve(checkImpl());
      // /indigo/convert (W5 CIP labels) — return a struct with no CIP SGROUPs.
      return Promise.resolve(
        new Response(JSON.stringify({ struct: 'M  V30 END CTAB\nM  END\n' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
}

function stereoMsg(idxs0Based: number[]): Response {
  return new Response(
    JSON.stringify({
      stereo: `Structure contains stereocenters with undefined stereo configuration: (${idxs0Based.join(',')})`,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

// A minimal dense-enough graph is NOT needed here — the assert is gate-agnostic
// (the dense gate lives in buildStereoAdvisory). We only need atoms carrying the
// stereo_unknown skip flag and an atomIdMap.
function graphWithSkip(intentId: number, skip: boolean): GraphIntent {
  return {
    version: 1,
    atoms: [
      {
        id: intentId,
        element: 'C',
        drawn_H: null,
        charge: 0,
        radical: 0,
        ring: null,
        ...(skip ? { stereo_unknown: true } : {}),
      },
    ],
    bonds: [],
    rings: [],
    counts: { heavy: 1, rings: { value: 0 }, heteroatoms: {} },
  } as unknown as GraphIntent;
}

describe('assertNoUndefinedStereoPostBuild — faithfulness + graceful-down (TIER 2)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the perceived set (no throw) when every undefined center is an explicit skip', async () => {
    // Indigo perceives atom idx 0 undefined; canvas atom[0].id = 100; atomIdMap
    // 26→100 ⇒ intentId 26, which the graph marks stereo_unknown.
    stubIndigo(() => stereoMsg([0]));
    const runtime = makeRuntime([100]);
    const out = await assertNoUndefinedStereoPostBuild(
      runtime,
      graphWithSkip(26, true),
      { 26: 100 },
    );
    expect(out).toEqual([26]);
  });

  it('still THROWS stereo_transfer_failed on an UNACCOUNTED center (existing gate untouched)', async () => {
    stubIndigo(() => stereoMsg([0]));
    const runtime = makeRuntime([100]);
    await expect(
      assertNoUndefinedStereoPostBuild(runtime, graphWithSkip(26, false), {
        26: 100,
      }),
    ).rejects.toMatchObject({
      // BuildFromGraphError with code 'stereo_transfer_failed'.
      code: 'stereo_transfer_failed',
    });
    // and it is the right error class
    await expect(
      assertNoUndefinedStereoPostBuild(runtime, graphWithSkip(26, false), {
        26: 100,
      }),
    ).rejects.toBeInstanceOf(BuildFromGraphError);
  });

  it('returns [] (no throw) when Indigo is mocked-down on the perception call', async () => {
    delete process.env.KETCHER_REQUIRE_FIX1;
    stubIndigo(() => {
      throw new Error('fetch failed');
    });
    const runtime = makeRuntime([100]);
    const out = await assertNoUndefinedStereoPostBuild(
      runtime,
      graphWithSkip(26, true),
      { 26: 100 },
    );
    expect(out).toEqual([]);
  });

  it('returns [] when Indigo perceives nothing undefined', async () => {
    stubIndigo(
      () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const runtime = makeRuntime([100]);
    const out = await assertNoUndefinedStereoPostBuild(
      runtime,
      graphWithSkip(26, true),
      { 26: 100 },
    );
    expect(out).toEqual([]);
  });
});
