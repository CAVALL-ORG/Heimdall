import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTools } from '../../src/mcp/tools/validate';
import {
  readSessionTrace,
  readUnresolvedTargets,
} from '../../src/mcp/tools/row-state';

const validateTool = validateTools[0];

function ringGraph(n: number) {
  const atoms = Array.from({ length: n }, (_, i) => ({
    id: i,
    element: 'C',
    drawn_H: null as number | null,
    charge: 0,
    radical: 0 as 0,
    ring: 'r',
  }));
  const bonds = Array.from({ length: n }, (_, i) => ({
    a: i,
    b: (i + 1) % n,
    order: 1 as 1,
    wedge: null,
    wedge_from: null,
  }));
  return {
    version: 1,
    atoms,
    bonds,
    rings: [
      {
        id: 'r',
        atoms: atoms.map((a) => a.id),
        kind: 'aliphatic' as const,
      },
    ],
    counts: { heavy: n, rings: 1, heteroatoms: {} },
  };
}

describe('validate_graph sidecar wiring (T1 / T1b / T2)', () => {
  const cleanups: string[] = [];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'validate-trace-'));
    cleanups.push(dir);
  });

  afterEach(() => {
    for (const d of cleanups) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    cleanups.length = 0;
  });

  it('writes _unresolved_targets.json on every call (even on ok runs)', async () => {
    await validateTool.run({} as never, {
      graph: ringGraph(6),
      rowId: 'r',
      outputDir: dir,
    });
    const sidecar = readUnresolvedTargets(dir);
    expect(sidecar).not.toBeNull();
    expect(sidecar?.ok).toBe(true);
    expect(sidecar?.targets).toHaveLength(0);
  });

  it('appends a validate_graph event with graph_hash to the session trace', async () => {
    await validateTool.run({} as never, {
      graph: ringGraph(6),
      rowId: 'r',
      outputDir: dir,
    });
    const trace = readSessionTrace(dir);
    expect(trace).toHaveLength(1);
    expect(trace[0].tool).toBe('validate_graph');
    expect(trace[0].result?.ok).toBe(true);
    expect(typeof trace[0].result?.graph_hash).toBe('string');
  });

  it('increments round counter across successive validate calls', async () => {
    await validateTool.run({} as never, {
      graph: ringGraph(6),
      rowId: 'r',
      outputDir: dir,
    });
    await validateTool.run({} as never, {
      graph: ringGraph(6),
      rowId: 'r',
      outputDir: dir,
    });
    const sidecar = readUnresolvedTargets(dir);
    expect(sidecar?.round).toBe(2);
  });
});

// Removed: shape_advisory diagnostic dropped (non-actionable warning that
// tripped on every paclitaxel-class row). Auto-routing still lives in
// build.ts; the validate-side warning emission was pure noise.
