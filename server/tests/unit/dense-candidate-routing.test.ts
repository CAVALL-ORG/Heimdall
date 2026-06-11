/**
 * Task 2 — dense-candidate routing: M0 gate + sidecar latch.
 *
 * Tests that `validate_graph` fires `dense_coupling_trigger` and writes
 * `dense:true` to the sidecar for ANY heavy >= 18 graph (declaration-
 * independent `isDenseCandidate`), not only for declared-fused graphs.
 * Also verifies the latch: once `dense:true` is written it is never
 * re-closed by a later degraded round.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTools } from '../../src/mcp/tools/validate';
import { readUnresolvedTargets } from '../../src/mcp/tools/row-state';

const validateTool = validateTools[0];

// ── Graph-intent helpers ───────────────────────────────────────────────

const baseAtom = (id: number, element = 'C') => ({
  id,
  element,
  drawn_H: null as number | null,
  charge: 0,
  radical: 0 as 0 | 1 | 2,
  ring: null as string | null,
});

function makeGraph(n: number) {
  const atoms = Array.from({ length: n }, (_, i) => baseAtom(i + 1));
  // Linear chain of single bonds — no rings, no fused pairs.
  const bonds = n > 1
    ? Array.from({ length: n - 1 }, (_, i) => ({
        a: i + 1,
        b: i + 2,
        order: 1 as const,
        wedge: null as 'solid' | 'hashed' | null,
        wedge_from: null as number | null,
      }))
    : [];
  return {
    version: 1 as const,
    atoms,
    bonds,
    rings: [] as Array<{ id: string; atoms: number[]; kind: 'kekule' | 'aromatic' | 'aliphatic' }>,
    counts: { heavy: n, rings: 0, heteroatoms: {} as Record<string, number> },
  };
}

// ── Suite ─────────────────────────────────────────────────────────────

describe('Task 2 — dense-candidate routing', () => {
  const cleanups: string[] = [];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cav-dense-cand-'));
    cleanups.push(dir);
  });

  afterEach(() => {
    for (const d of cleanups) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    cleanups.length = 0;
  });

  // ── Case 1: M0 advisory + dense:true for heavy=18, fusedRingPairs=0 ─

  it('case 1: heavy=18 with no fused rings fires dense_coupling_trigger and writes dense:true', async () => {
    const graph = makeGraph(18); // fusedRingPairs=0 (linear chain)
    const ret = await validateTool.run({} as never, {
      graph,
      rowId: 'r',
      outputDir: dir,
    });
    // Diagnostics are in ret.data.diagnostics
    const diagnostics = (ret as { ok: boolean; data: { diagnostics: Array<{ code: string }> } }).data.diagnostics;
    expect(diagnostics.some((d) => d.code === 'dense_coupling_trigger')).toBe(true);

    const sidecar = readUnresolvedTargets(dir);
    expect(sidecar?.dense).toBe(true);
  });

  // ── Case 2: latch — dense:true survives a later degraded round ──────

  it('case 2: latch — dense:true is not overwritten by a later heavy<18 round', async () => {
    // Round 1: dense candidate (18 atoms)
    await validateTool.run({} as never, {
      graph: makeGraph(18),
      rowId: 'r',
      outputDir: dir,
    });
    expect(readUnresolvedTargets(dir)?.dense).toBe(true);

    // Round 2: degraded (6 atoms — isDenseCandidate=false)
    await validateTool.run({} as never, {
      graph: makeGraph(6),
      rowId: 'r',
      outputDir: dir,
    });
    // Must remain true — latch never re-closes
    expect(readUnresolvedTargets(dir)?.dense).toBe(true);
  });

  // ── Case 3: fast-on-easy — heavy=6 gets no advisory and dense:false ─

  it('case 3: fast-on-easy — heavy=6 gets no dense_coupling_trigger and dense:false', async () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'cav-dense-cand-'));
    cleanups.push(freshDir);

    const ret = await validateTool.run({} as never, {
      graph: makeGraph(6),
      rowId: 'r',
      outputDir: freshDir,
    });
    const diagnostics = (ret as { ok: boolean; data: { diagnostics: Array<{ code: string }> } }).data.diagnostics;
    expect(diagnostics.some((d) => d.code === 'dense_coupling_trigger')).toBe(false);

    const sidecar = readUnresolvedTargets(freshDir);
    expect(sidecar?.dense).toBe(false);
  });
});
