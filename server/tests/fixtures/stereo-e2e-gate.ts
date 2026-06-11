/**
 * Shared skip-closed gate for the Indigo-backed stereo e2e blocks
 * (mode-c-cip-selective-reapply, ez-verify, adjacent-chiral).
 *
 * WHY THIS GATE EXISTS (Task 6C — fix a real false-RED)
 * ------------------------------------------------------
 * Two distinct preconditions BOTH have to hold for a stereo build to be
 * meaningfully assertable, and BOTH have silent-no-op failure modes that
 * would turn a green into a vacuous green or a real false-RED:
 *
 *   1. Indigo must be REACHABLE at KETCHER_REMOTE_API_PATH. Mode C's CIP
 *      perception (`indigoComputeCIPLabels`) and the silent-achiral guard
 *      (`assertNoUndefinedStereoPostBuild` -> `indigoCheckStereocenters`)
 *      are direct Node `fetch` calls to that URL. When Indigo is down they
 *      throw, the translator swallows the error (best-effort), and:
 *        - Mode C records `perceivedRS: null` / `reapplied: false`, so the
 *          re-apply NEVER fires and the exported enantiomer is whatever
 *          Ketcher's auto-layout produced -- possibly the WRONG one. Verified
 *          empirically: standalone runtime + dead Indigo port on
 *          `CC(F)(Cl)Br` with `outOfPlaneNeighbor: 1, facing: 'toward'`
 *          exported `C[C@@](Br)(Cl)F` (the layout-artifact S) instead of the
 *          intended `C[C@](Br)(Cl)F` (R).
 *        - The post-build undefined-stereocenter check degrades to a pass,
 *          so a center that should have been flagged silently commits achiral.
 *      Asserting "re-apply fired" or "center is defined" against that state is
 *      vacuous, so we SKIP rather than risk a false green.
 *
 *   2. The runtime must be started in REMOTE mode. Even when Indigo is
 *      reachable as an HTTP service, a STANDALONE runtime cannot route the
 *      proxy-dependent export paths (notably canonical `export_smiles` and the
 *      molfile round-trips the V2000 re-apply leans on) through Indigo. The
 *      pre-6C gate checked ONLY Indigo reachability; a misconfigured run
 *      (e.g. `KETCHER_AGENT_MODE=standalone` in the environment, or a future
 *      refactor that lets env override the explicit `mode`) could pass the
 *      reachability probe yet exercise a standalone runtime whose Mode C
 *      silently no-ops -- observed previously as "flaky failures" on exactly
 *      this path. This gate therefore SKIP-CLOSES unless the runtime was
 *      started in remote mode AND Indigo answered, and `startStereoGate`
 *      asserts the remote start so the precondition is explicit, not implied.
 *
 * STANDALONE MODE SILENTLY NO-OPS Mode C + the silent-achiral guard -- these
 * tests REQUIRE remote mode + a reachable Indigo. The gate makes that a
 * hard, observable precondition instead of a comment nobody reads.
 *
 * The gate NEVER fails a test: it returns a `ready` boolean each `it` passes
 * to `ctx.skip(!gate.ready, ...)`. Down/standalone -> genuine SKIP; up+remote
 * -> the real assertions run.
 */

import type { KetcherRuntime } from '../../src/mcp/runtime';

export const STEREO_GATE_REMOTE_BASE =
  process.env.KETCHER_REMOTE_API_PATH ?? 'http://127.0.0.1:8002/v2/';

/** True iff RUN_KETCHER_E2E=1 -- the same posture as the runtime-e2e suite. */
export const RUN_STEREO_E2E = process.env.RUN_KETCHER_E2E === '1';

/**
 * Probe Indigo's `/info` at `STEREO_GATE_REMOTE_BASE`. Returns true only when
 * the service answers with a string `indigo_version` field. Any network error,
 * non-2xx, or non-JSON body returns false (skip-closed). This is the SAME
 * direct-URL probe the translator's perception helpers ultimately hit, so a
 * true here means perception will actually run.
 */
export async function indigoReachable(
  base: string = STEREO_GATE_REMOTE_BASE,
): Promise<boolean> {
  try {
    const res = await fetch(base + 'info');
    if (!res.ok) return false;
    const json = (await res.json()) as { indigo_version?: unknown };
    return typeof json.indigo_version === 'string';
  } catch {
    return false;
  }
}

/**
 * The live state of a stereo e2e gate after `startStereoGate` runs in
 * `beforeAll`. `ready` is the single predicate every `it` consults:
 * `ctx.skip(!gate.ready, ...)`.
 */
export interface StereoGate {
  /** Indigo answered `/info` with a version string. */
  readonly indigoUp: boolean;
  /** The runtime was started, in remote mode. */
  readonly startedRemote: boolean;
  /**
   * BOTH preconditions hold: Indigo reachable AND runtime started remote.
   * The ONLY value an `it` should branch on.
   */
  readonly ready: boolean;
  /** Human-readable skip reason when `ready` is false (for ctx.skip). */
  readonly skipReason: string;
  /** Tear the runtime down in `afterAll` (no-op if never started). */
  stop(): Promise<void>;
}

/**
 * Start `runtime` in REMOTE mode iff Indigo is reachable, and return a
 * {@link StereoGate} whose `ready` flag is true only when BOTH the remote
 * start succeeded AND Indigo answered. Call from `beforeAll`; pass
 * `gate.stop` to `afterAll`.
 *
 * Skip-closed by construction:
 *   - Indigo down -> we do NOT start the runtime (no point), `ready === false`,
 *     every gated `it` SKIPs. No false green, no wasted Chromium launch.
 *   - Indigo up -> we start in `{ mode: 'remote', remoteApiPath: base }` and,
 *     once started, set `startedRemote` so the remote precondition is
 *     explicit. `ready === true`, the real assertions run.
 *
 * NOTE: `runtime.start` honours the explicit `mode` option (it does not read
 * `KETCHER_AGENT_MODE`), so a remote start here is authoritative regardless of
 * the ambient env -- but the orchestrated test command still sets
 * `KETCHER_AGENT_MODE=remote` for the perception helpers' env-driven URL.
 */
export async function startStereoGate(
  runtime: KetcherRuntime,
  base: string = STEREO_GATE_REMOTE_BASE,
): Promise<StereoGate> {
  const indigoUp = await indigoReachable(base);
  let startedRemote = false;
  if (indigoUp) {
    await runtime.start({ mode: 'remote', remoteApiPath: base });
    startedRemote = true;
  }
  const ready = indigoUp && startedRemote;
  const skipReason = !indigoUp
    ? `Indigo unreachable at ${base} -- Mode C perception + silent-achiral guard ` +
      `silently no-op, so the stereo assertion would be vacuous (skip-closed).`
    : !startedRemote
      ? `Runtime not started in remote mode -- standalone silently no-ops Mode C; ` +
        `stereo assertion would be unreliable (skip-closed).`
      : '';

  return {
    indigoUp,
    startedRemote,
    ready,
    skipReason,
    async stop() {
      if (startedRemote) await runtime.stop();
    },
  };
}
