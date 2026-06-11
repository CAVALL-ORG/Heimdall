/**
 * Stage A.2 (PLAN-a004-class-robustness-2026-05-22.md commit 1b) — wiring
 * tests for `visionFingerprint` field on the build_from_graph response and
 * the `KETCHER_FINGERPRINT_DUMP_DIR` sidecar dump.
 *
 * The pure-function tests for `computeVisionCheckCandidate` live in
 * vision-fingerprint.test.ts. These tests cover only the *wiring*:
 *   - translateGraphIntent attaches a non-null `visionFingerprint` when
 *     the runtime can return annotated state.
 *   - When `KETCHER_FINGERPRINT_DUMP_DIR` is set, a JSON file containing
 *     `{ts, fingerprint}` is written to that directory and parses back to
 *     a recognizable VisionCheckCandidate shape.
 *
 * Uses a minimal in-memory FakeRuntime — no Chromium, no Indigo. The fake
 * stubs only the bridge methods translator's benzene path actually hits.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { translateGraphIntent } from '../../src/adapter/graph-intent/translator';
import { BuildFromGraphError } from '../../src/adapter/graph-intent/errors';
import type { GraphIntent } from '../../src/types/graph-intent';

function benzene(): GraphIntent {
  return {
    version: 1,
    label: 'benzene',
    atoms: [1, 2, 3, 4, 5, 6].map((id) => ({
      id,
      element: 'C',
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

function fusedTwoRingGraph(): GraphIntent {
  return {
    version: 1,
    label: 'fused two ring',
    atoms: Array.from({ length: 8 }, (_, idx) => ({
      id: idx + 1,
      element: 'C',
      drawn_H: null,
      charge: 0,
      radical: 0 as const,
      ring: null,
    })),
    bonds: [
      { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
      { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
      { a: 3, b: 4, order: 1, wedge: null, wedge_from: null },
      { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
      { a: 5, b: 1, order: 1, wedge: null, wedge_from: null },
      { a: 4, b: 6, order: 1, wedge: null, wedge_from: null },
      { a: 6, b: 7, order: 1, wedge: null, wedge_from: null },
      { a: 7, b: 8, order: 1, wedge: null, wedge_from: null },
      { a: 8, b: 5, order: 1, wedge: null, wedge_from: null },
    ],
    rings: [
      { id: 'r0', atoms: [1, 2, 3, 4, 5], kind: 'aliphatic' },
      { id: 'r1', atoms: [4, 5, 8, 7, 6], kind: 'aliphatic' },
    ],
    counts: { heavy: 8, rings: 2, heteroatoms: {} },
    topologyLedger: {
      rings: [
        { id: 'r0', walk: [1, 2, 3, 4, 5] },
        { id: 'r1', walk: [4, 5, 8, 7, 6] },
      ],
      ring_connectivity: [{ ring_a: 'r0', ring_b: 'r1', kind: 'fused' }],
      unresolved: [],
    },
    coverageCheck: { heavy: 8, rings: 2, heteroatoms: {}, unresolved: [] },
  };
}

type FakeRuntime = {
  callBridge: (method: string, ...args: unknown[]) => Promise<unknown>;
  getState: () => Promise<unknown>;
  getAnnotatedState: () => Promise<unknown>;
  callLog: Array<{ method: string; args: unknown[] }>;
};

function makeFakeRuntime(annotatedStateOverride?: unknown): FakeRuntime {
  // Records every callBridge invocation; serves a canned benzene canvas
  // for getAnnotatedState. The translator runs skeleton → … → aromatize,
  // and at end-of-build queries getAnnotatedState; the post-build
  // VisionCheckCandidate is computed from THAT canvas state, so the
  // canned state must mirror a built benzene (6 carbons in 1 aromatic
  // ring, no charges, no wedges).
  const callLog: Array<{ method: string; args: unknown[] }> = [];
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

  const rt: FakeRuntime = {
    callLog,
    callBridge: async (method: string, ...args: unknown[]) => {
      callLog.push({ method, args });
      if (method === 'addFragment') {
        const id = nextAtomId++;
        atoms.push({ id, label: (args[0] as string).replace(/[\[\]]/g, '') });
        return { atomId: id };
      }
      if (method === 'addAtomWithSingleBond') {
        const id = nextAtomId++;
        const bondId = nextBondId++;
        atoms.push({ id, label: args[1] as string });
        bonds.push({
          id: bondId,
          beginAtomId: args[0] as number,
          endAtomId: id,
          order: 1,
          stereo: 0,
        });
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
    getAnnotatedState: async () =>
      annotatedStateOverride ?? {
        smiles: null,
        ket: null,
        molfile: null,
        isEmpty: atoms.length === 0,
        isReaction: false,
        atoms: atoms.map((a) => ({
          id: a.id,
          label: a.label,
          charge: 0,
          radical: 0,
          aromatic: true,
          inRing: true,
        })),
        bonds: bonds.map((b) => ({
          id: b.id,
          beginAtomId: b.beginAtomId,
          endAtomId: b.endAtomId,
          order: b.order,
          stereo: b.stereo,
          aromatic: true,
          inRing: true,
        })),
      },
  };
  return rt;
}

function disconnectedTwoRingAnnotatedState() {
  return {
    smiles: null,
    ket: null,
    molfile: null,
    isEmpty: false,
    isReaction: false,
    atoms: Array.from({ length: 8 }, (_, idx) => ({
      id: idx + 1,
      label: 'C',
      charge: 0,
      radical: 0,
      aromatic: false,
      inRing: true,
    })),
    bonds: [
      { id: 1, beginAtomId: 1, endAtomId: 2, order: 1, stereo: 0, aromatic: false, inRing: true },
      { id: 2, beginAtomId: 2, endAtomId: 3, order: 1, stereo: 0, aromatic: false, inRing: true },
      { id: 3, beginAtomId: 3, endAtomId: 4, order: 1, stereo: 0, aromatic: false, inRing: true },
      { id: 4, beginAtomId: 4, endAtomId: 1, order: 1, stereo: 0, aromatic: false, inRing: true },
      { id: 5, beginAtomId: 5, endAtomId: 6, order: 1, stereo: 0, aromatic: false, inRing: true },
      { id: 6, beginAtomId: 6, endAtomId: 7, order: 1, stereo: 0, aromatic: false, inRing: true },
      { id: 7, beginAtomId: 7, endAtomId: 8, order: 1, stereo: 0, aromatic: false, inRing: true },
      { id: 8, beginAtomId: 8, endAtomId: 5, order: 1, stereo: 0, aromatic: false, inRing: true },
    ],
  };
}

describe('vision-fingerprint wiring on translateGraphIntent', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fingerprint-dump-'));
    delete process.env.KETCHER_FINGERPRINT_DUMP_DIR;
    delete process.env.KETCHER_BUILD_DUMP_ROW_ID;
  });
  afterEach(() => {
    delete process.env.KETCHER_FINGERPRINT_DUMP_DIR;
    delete process.env.KETCHER_BUILD_DUMP_ROW_ID;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('attaches a non-null visionFingerprint when getAnnotatedState succeeds', async () => {
    const rt = makeFakeRuntime();
    const result = await translateGraphIntent(rt as any, benzene(), {
      validate_counts: false,
      layout: 'preserve',
    });
    expect(result.visionFingerprint).not.toBeNull();
    expect(typeof result.visionFingerprint).toBe('object');
    // benzene shape: 6 heavy atoms, 1 ring of size 6, no wedges, no
    // charges. SSSR identifies the ring regardless of aromaticity flag.
    expect(result.visionFingerprint?.heavy).toBe(6);
    expect(result.visionFingerprint?.rings.length).toBeGreaterThanOrEqual(1);
    expect(result.visionFingerprint?.rings[0].size).toBe(6);
    expect(result.visionFingerprint?.wedges).toEqual([]);
    expect(result.visionFingerprint?.charges).toEqual([]);
  });

  // Removed 2026-05-26: "fails closed when fingerprint topology disagrees
  // with the dense ledger". The dense ledger contract (topologyLedger /
  // coverageCheck / assertFingerprintTopologyMatchesLedger) was deleted in
  // Phase 2c; Mode C handles K>=9 via Indigo CIP perception + selective
  // V2000 solver re-apply, no ledger needed.

  it('writes a sidecar fingerprint dump when KETCHER_FINGERPRINT_DUMP_DIR is set', async () => {
    process.env.KETCHER_FINGERPRINT_DUMP_DIR = tmp;
    const rt = makeFakeRuntime();
    await translateGraphIntent(rt as any, benzene(), {
      validate_counts: false,
      layout: 'preserve',
    });
    const files = readdirSync(tmp).filter((f) => f.endsWith('.fingerprint.json'));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const dump = JSON.parse(readFileSync(join(tmp, files[0]), 'utf8'));
    expect(typeof dump.ts).toBe('string');
    expect(dump.fingerprint).toBeTruthy();
    expect(dump.fingerprint.heavy).toBe(6);
    expect(Array.isArray(dump.fingerprint.rings)).toBe(true);
    expect(Array.isArray(dump.fingerprint.wedges)).toBe(true);
  });

  it('uses KETCHER_BUILD_DUMP_ROW_ID as the sidecar filename prefix', async () => {
    process.env.KETCHER_FINGERPRINT_DUMP_DIR = tmp;
    process.env.KETCHER_BUILD_DUMP_ROW_ID = 'TEST123';
    const rt = makeFakeRuntime();
    await translateGraphIntent(rt as any, benzene(), {
      validate_counts: false,
      layout: 'preserve',
    });
    const files = readdirSync(tmp).filter((f) => f.endsWith('.fingerprint.json'));
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.every((f) => f.startsWith('TEST123-'))).toBe(true);
  });

  it('does NOT write a dump when KETCHER_FINGERPRINT_DUMP_DIR is unset', async () => {
    // env intentionally not set
    const rt = makeFakeRuntime();
    await translateGraphIntent(rt as any, benzene(), {
      validate_counts: false,
      layout: 'preserve',
    });
    const files = readdirSync(tmp);
    expect(files.length).toBe(0);
  });

  it('forensics.fingerprintDumpDir + forensics.rowId override env (test-daemon path)', async () => {
    // Env points elsewhere; the per-call forensics opt must win so the
    // test daemon can dispatch concurrent slot builds without env races.
    process.env.KETCHER_FINGERPRINT_DUMP_DIR = '/tmp/should-not-be-used';
    process.env.KETCHER_BUILD_DUMP_ROW_ID = 'ENVID';
    const rt = makeFakeRuntime();
    await translateGraphIntent(rt as any, benzene(), {
      validate_counts: false,
      layout: 'preserve',
      forensics: { fingerprintDumpDir: tmp, rowId: 'CALLID' },
    });
    const files = readdirSync(tmp).filter((f) => f.endsWith('.fingerprint.json'));
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.every((f) => f.startsWith('CALLID-'))).toBe(true);
  });

  it('forensics.buildDumpDir overrides env for the graph-intent dump (test-daemon path)', async () => {
    process.env.KETCHER_BUILD_DUMP_DIR = '/tmp/should-not-be-used';
    const rt = makeFakeRuntime();
    await translateGraphIntent(rt as any, benzene(), {
      validate_counts: false,
      layout: 'preserve',
      forensics: { buildDumpDir: tmp, rowId: 'CALLID' },
    });
    // The graph-intent dump uses .json (no .fingerprint prefix). Two files
    // share this suffix: the timestamped `CALLID-<stamp>.json` and the
    // deterministic `CALLID.graph.json` (Phase 0). Both must carry the
    // per-call forensics rowId, proving the override beat env.
    const files = readdirSync(tmp).filter(
      (f) => f.endsWith('.json') && !f.endsWith('.fingerprint.json'),
    );
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.every((f) => f.startsWith('CALLID-') || f === 'CALLID.graph.json')).toBe(true);
    delete process.env.KETCHER_BUILD_DUMP_DIR;
  });
});
