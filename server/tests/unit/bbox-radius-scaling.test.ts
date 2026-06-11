import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTools } from '../../src/mcp/tools/validate';
import { readUnresolvedTargets } from '../../src/mcp/tools/row-state';

const validateTool = validateTools[0];

// Build a chain of N carbons with mean bond length = `bondLen` along the x-axis.
// One atom has drawn_H_confidence='needs_zoom' + matching unresolved[] entry so
// extractTargets fires and writes a sidecar with bbox_radius.
function chainGraphWithUnresolved(bondLen: number, n = 6) {
  const atoms = Array.from({ length: n }, (_, i) => ({
    id: i,
    element: 'C',
    drawn_H: null as number | null,
    charge: 0,
    radical: 0 as 0,
    ring: null as string | null,
    x: i * bondLen,
    y: 0,
    ...(i === 0 ? { drawn_H_confidence: 'needs_zoom' as const } : {}),
  }));
  const bonds = Array.from({ length: n - 1 }, (_, i) => ({
    a: i,
    b: i + 1,
    order: 1 as 1,
    wedge: null,
    wedge_from: null,
  }));
  return {
    version: 1 as const,
    atoms,
    bonds,
    rings: [] as Array<{ id: string; atoms: number[]; kind: 'kekule' | 'aromatic' | 'aliphatic' }>,
    counts: { heavy: n, rings: 0, heteroatoms: {} },
    unresolved: [
      {
        field: 'drawn_H' as const,
        record_id: 'atom:0',
        note: 'unclear H count',
        state: 'needs_zoom' as const,
      },
    ],
  };
}

describe('extractTargets bbox_radius scaling (Task C)', () => {
  const cleanups: string[] = [];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bbox-radius-'));
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

  it('floors bbox_radius at 50 for tight clusters (mean bond length ~30 px)', async () => {
    await validateTool.run({} as never, {
      graph: chainGraphWithUnresolved(30),
      rowId: 'r',
      outputDir: dir,
    });
    const sidecar = readUnresolvedTargets(dir);
    expect(sidecar?.targets).toHaveLength(1);
    expect(sidecar?.targets[0].bbox_radius).toBe(50);
  });

  it('scales bbox_radius to 75 for standard structures (mean bond length ~50 px)', async () => {
    await validateTool.run({} as never, {
      graph: chainGraphWithUnresolved(50),
      rowId: 'r',
      outputDir: dir,
    });
    const sidecar = readUnresolvedTargets(dir);
    expect(sidecar?.targets).toHaveLength(1);
    expect(sidecar?.targets[0].bbox_radius).toBe(75);
  });

  it('scales bbox_radius to 150 for sparse structures (mean bond length ~100 px)', async () => {
    await validateTool.run({} as never, {
      graph: chainGraphWithUnresolved(100),
      rowId: 'r',
      outputDir: dir,
    });
    const sidecar = readUnresolvedTargets(dir);
    expect(sidecar?.targets).toHaveLength(1);
    expect(sidecar?.targets[0].bbox_radius).toBe(150);
  });
});
