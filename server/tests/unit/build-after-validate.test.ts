import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTools } from '../../src/mcp/tools/build';
import {
  appendSessionEvent,
  stableHash,
} from '../../src/mcp/tools/row-state';

const buildTool = buildTools[0];

function smallGraph() {
  return {
    version: 1 as const,
    atoms: [
      { id: 0, element: 'C', drawn_H: null, charge: 0, radical: 0 as 0, ring: null },
      { id: 1, element: 'O', drawn_H: null, charge: 0, radical: 0 as 0, ring: null },
    ],
    bonds: [{ a: 0, b: 1, order: 1 as 1, wedge: null, wedge_from: null }],
    rings: [],
    counts: { heavy: 2, rings: 0, heteroatoms: { O: 1 } },
  };
}

const NEVER_CALL_RUNTIME = new Proxy(
  {},
  {
    get() {
      throw new Error('runtime should not be called when gate rejects');
    },
  },
) as never;

describe('T1b build-after-validate gate (KETCHER_BUILD_AFTER_VALIDATE=1)', () => {
  const cleanups: string[] = [];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bav-'));
    cleanups.push(dir);
    process.env.KETCHER_BUILD_AFTER_VALIDATE = '1';
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
    delete process.env.KETCHER_BUILD_AFTER_VALIDATE;
  });

  it('rejects build_without_validate when no prior validate event exists', async () => {
    const result = await buildTool.run(NEVER_CALL_RUNTIME, {
      graph: smallGraph(),
      rowId: 'r',
      outputDir: dir,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('build_without_validate');
  });

  it('rejects build_graph_differs_from_validated when hashes mismatch', async () => {
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: 1,
      result: { ok: true, graph_hash: 'deadbeefdeadbeef' },
    });
    const result = await buildTool.run(NEVER_CALL_RUNTIME, {
      graph: smallGraph(),
      rowId: 'r',
      outputDir: dir,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('build_graph_differs_from_validated');
  });

  it('passes the gate when the most-recently-validated graph hash matches', async () => {
    const graph = smallGraph();
    const hash = stableHash(graph);
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: 1,
      result: { ok: true, graph_hash: hash },
    });
    // Gate passes — but build proceeds to translateGraphIntent, which
    // needs a real runtime. We assert that the gate did not short-circuit
    // by checking that the proxy throw is reached (any other error means
    // the gate rejected and the proxy was never called).
    let threwFromRuntime = false;
    try {
      await buildTool.run(NEVER_CALL_RUNTIME, {
        graph,
        rowId: 'r',
        outputDir: dir,
      });
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes('runtime should not be called when gate rejects')
      ) {
        threwFromRuntime = true;
      } else {
        throw err;
      }
    }
    expect(threwFromRuntime).toBe(true);
  });

  it('gate is a no-op when env flag explicitly disabled (build attempts runtime call immediately)', async () => {
    process.env.KETCHER_BUILD_AFTER_VALIDATE = '0';
    let threwFromRuntime = false;
    try {
      await buildTool.run(NEVER_CALL_RUNTIME, {
        graph: smallGraph(),
        rowId: 'r',
        outputDir: dir,
      });
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes('runtime should not be called when gate rejects')
      ) {
        threwFromRuntime = true;
      } else {
        throw err;
      }
    }
    expect(threwFromRuntime).toBe(true);
  });
});
