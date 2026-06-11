/**
 * Task 7B — production-MCP-path standing CI smoke.
 *
 * Two independent assertions run on every CI pass to catch the class of
 * divergence where tests are green but the daemon bundle is stale (the
 * concrete failure was agent-orch-<run-id> running a 36h-stale bundle
 * that pre-dated several translator surfaces, producing silently-wrong builds).
 *
 * ASSERTION 1 — daemon-bundle freshness + smoke-token grep (hermetic, no Chromium)
 * ─────────────────────────────────────────────────────────────────────────────────
 * Design choice: rebuild + grep rather than mtime comparison.
 *
 * An mtime check is cheap but unreliable: symlinking dist/ (as this repo's
 * agent worktrees do) makes mtime comparisons meaningless, and a bundle from a
 * different branch silently has a "fresh" mtime relative to the current src.
 * Rebuilding is authoritative — esbuild's content cache makes it ~1 s when
 * nothing changed, so the cost is negligible. After rebuild, the three tokens
 * from CLAUDE.md prereq §4 are grepped to confirm the critical translator
 * surfaces are compiled into the bundle.
 *
 *   - translateGraphIntent  — main translator entry (graph→canvas)
 *   - unsureRegion          — Task-5A escape-box field (present as unsureRegionSchema)
 *   - validateGraph         — matches validateGraphIntent (pure preflight entry)
 *
 * This test runs WITHOUT RUN_KETCHER_E2E so CI can run it on every push, not
 * just the full e2e gate.
 *
 * ASSERTION 2 — one real build on the production MCP path (requires Chromium)
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds benzene via the same entry the MCP build_from_graph tool uses
 * (buildTools[0].run), which calls translateGraphIntent internally on a live
 * KetcherRuntime. Asserts atom count = 6 and SMILES contains "c1ccccc1".
 * Gated on RUN_KETCHER_E2E=1 to match the rest of runtime-e2e.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KetcherRuntime } from '../../src/mcp/runtime';
import { buildTools } from '../../src/mcp/tools/build';
import type { GraphIntent } from '../../src/types/graph-intent';

// ─── helpers ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the repo root: runtime-e2e → tests → server → repo (3 ups). */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** Absolute path to the daemon bundle produced by build:daemon */
const DAEMON_BUNDLE = resolve(__dirname, '..', '..', 'dist', 'scripts', 'test-daemon.mjs');

/** The three smoke tokens from CLAUDE.md prereq §4 */
const SMOKE_TOKENS = ['translateGraphIntent', 'unsureRegion', 'validateGraph'] as const;

function minimalBenzene(): GraphIntent {
  return {
    version: 1,
    label: 'benzene',
    atoms: [1, 2, 3, 4, 5, 6].map((id) => ({
      id,
      element: 'C' as const,
      drawn_H: null,
      charge: 0,
      radical: 0 as const,
      ring: 'r1',
    })),
    bonds: [
      { a: 1, b: 2, order: 2, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 3, b: 4, order: 2, wedge: null, wedge_from: null },
      { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
      { a: 5, b: 6, order: 2, wedge: null, wedge_from: null },
      { a: 6, b: 1, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [{ id: 'r1', atoms: [1, 2, 3, 4, 5, 6], kind: 'kekule' }],
    counts: { heavy: 6, rings: 1, heteroatoms: {} },
  };
}

// ─── Assertion 1: daemon-bundle freshness + smoke-token grep ─────────────────

describe('daemon-bundle freshness (hermetic — no Chromium required)', () => {
  it('rebuilds test-daemon.mjs and finds all three smoke tokens', () => {
    // Rebuild. esbuild content-cache makes this ~1 s when nothing changed.
    const result = spawnSync(
      'npm',
      ['run', 'build:daemon', '-w', 'server'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 120_000,
      },
    );

    if (result.error) {
      throw new Error(`build:daemon failed to spawn: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `build:daemon exited ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    }

    // Grep the bundle for each smoke token.
    const bundle = readFileSync(DAEMON_BUNDLE, 'utf8');
    for (const token of SMOKE_TOKENS) {
      expect(
        bundle.includes(token),
        `smoke token "${token}" missing from daemon bundle — src/bundle divergence`,
      ).toBe(true);
    }
  }, 150_000); // 2.5 min ceiling for first-cold build
});

// ─── Assertion 2: one real build on the production MCP path ──────────────────

const runE2E = process.env.RUN_KETCHER_E2E === '1';
const describeE2E = runE2E ? describe : describe.skip;

describeE2E('production MCP path — real build_from_graph call (requires Chromium)', () => {
  const runtime = new KetcherRuntime();

  // Disable T1b build-after-validate gate so the tool handler runs without a
  // preceding validate_graph round in the session trace (same pattern as
  // the "Task 2C" suite in build-from-graph.e2e.test.ts).
  beforeAll(async () => {
    process.env.KETCHER_BUILD_AFTER_VALIDATE = '0';
    await runtime.start();
  }, 180_000);

  afterAll(async () => {
    delete process.env.KETCHER_BUILD_AFTER_VALIDATE;
    await runtime.stop();
  });

  it('builds benzene via buildTools[0].run and gets c1ccccc1 SMILES', async () => {
    const buildTool = buildTools[0]; // build_from_graph tool
    expect(buildTool.name).toBe('build_from_graph'); // sanity

    const args = {
      graph: minimalBenzene(),
      validate_counts: true,
      layout: 'auto' as const,
    };

    const result = (await buildTool.run(runtime, args)) as {
      ok: boolean;
      smiles?: string;
      atom_count?: number;
    };

    expect(result.ok, 'build_from_graph returned ok:false').toBe(true);

    // Verify via getState — Ketcher is the source of truth for the canvas.
    const state = await runtime.getState(false);
    expect(state.atoms.length).toBe(6);

    // SMILES must contain the aromatic benzene ring token emitted by Ketcher.
    const smiles = state.smiles ?? '';
    expect(smiles.toLowerCase()).toContain('c1ccccc1');
  });
});
