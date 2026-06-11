import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import type { GraphIntent } from '../../src/types/graph-intent';

// Phase 0 of the image-harness-grading-correctness plan. The grader's
// un-blinded stereo gate (Phase 1) reads a per-row on-disk GraphIntent at
// `<rowDir>/<rowId>.graph.json`. That gate is INERT until this deterministic
// dump is guaranteed on every image build. This test pins the deterministic
// filename + the FLAT (un-nested) GraphIntent shape the resolver expects.

// Minimal fake KetcherRuntime — records bridge calls and synthesizes ids,
// the same shape build-from-graph.test.ts uses to drive the translator
// without a browser. The deterministic dump fires inside dumpGraphIntent on
// both the success and error translator paths, so the assertion holds
// regardless of whether the 2-atom stereo build itself completes.
function makeFakeRuntime() {
  let nextAtomId = 100;
  let nextBondId = 200;
  const atoms: Array<{ id: number; label: string }> = [];
  const bonds: Array<{
    id: number;
    beginAtomId: number;
    endAtomId: number;
    order: number;
    stereo: number;
  }> = [];
  const rt: any = {
    callBridge: async (method: string, ...args: unknown[]) => {
      if (method === 'addFragment') {
        const id = nextAtomId++;
        atoms.push({ id, label: (args[0] as string).replace(/[\[\]]/g, '') });
        return { atomId: id };
      }
      if (method === 'addAtomWithSingleBond') {
        const id = nextAtomId++;
        const bondId = nextBondId++;
        atoms.push({ id, label: args[1] as string });
        bonds.push({ id: bondId, beginAtomId: args[0] as number, endAtomId: id, order: 1, stereo: 0 });
        return { beginAtomId: args[0], endAtomId: id, bondId };
      }
      if (method === 'addBond') {
        const bondId = nextBondId++;
        bonds.push({
          id: bondId,
          beginAtomId: args[0] as number,
          endAtomId: args[1] as number,
          order: args[2] as number,
          stereo: 0,
        });
        return { beginAtomId: args[0], endAtomId: args[1], bondId };
      }
      return undefined;
    },
    getState: async () => ({
      smiles: null,
      ket: null,
      molfile: null,
      isEmpty: atoms.length === 0,
      isReaction: false,
      hasExportFailure: false,
      exportErrorMessage: null,
      atoms: atoms.map((a) => ({ id: a.id, label: a.label, charge: 0, radical: 0, x: 0, y: 0 })),
      bonds,
    }),
  };
  return rt;
}

// 2-atom graph carrying one bond-level hashed wedge.
function hashedWedgeIntent(): GraphIntent {
  return {
    version: 1,
    label: 'hashed-wedge-2atom',
    atoms: [
      { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null },
      { id: 2, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null },
    ],
    bonds: [{ a: 1, b: 2, order: 1, wedge: 'hashed', wedge_from: 2 }],
    rings: [],
    counts: { heavy: 2, rings: 0, heteroatoms: { O: 1 } },
  };
}

describe('deterministic per-row GraphIntent dump', () => {
  let prevDir: string | undefined;
  let prevRow: string | undefined;
  let dumpDir: string;

  beforeEach(() => {
    prevDir = process.env.KETCHER_BUILD_DUMP_DIR;
    prevRow = process.env.KETCHER_BUILD_DUMP_ROW_ID;
    dumpDir = mkdtempSync(join(tmpdir(), 'build-dump-canonical-'));
    process.env.KETCHER_BUILD_DUMP_DIR = dumpDir;
    process.env.KETCHER_BUILD_DUMP_ROW_ID = 'ROWX';
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.KETCHER_BUILD_DUMP_DIR;
    else process.env.KETCHER_BUILD_DUMP_DIR = prevDir;
    if (prevRow === undefined) delete process.env.KETCHER_BUILD_DUMP_ROW_ID;
    else process.env.KETCHER_BUILD_DUMP_ROW_ID = prevRow;
  });

  it('writes <rowId>.graph.json with a flat GraphIntent (bonds[0].wedge preserved)', async () => {
    const rt = makeFakeRuntime();
    // The build may throw on the 2-atom stereo compile; the deterministic
    // dump must still land (it fires on the translator error path too).
    try {
      await translateGraphIntent(rt as any, hashedWedgeIntent(), {
        validate_counts: false,
        layout: 'preserve',
      });
    } catch {
      // expected — assert the dump regardless of build outcome.
    }

    const canonical = join(dumpDir, 'ROWX.graph.json');
    expect(existsSync(canonical)).toBe(true);

    const parsed = JSON.parse(readFileSync(canonical, 'utf8'));
    // FLAT — atoms/bonds at the TOP LEVEL, NOT nested under `.graph`.
    expect(parsed.graph).toBeUndefined();
    expect(Array.isArray(parsed.atoms)).toBe(true);
    expect(Array.isArray(parsed.bonds)).toBe(true);
    expect(parsed.bonds[0].wedge).toBe('hashed');
    expect(parsed.bonds[0].wedge_from).toBe(2);
  });
});
