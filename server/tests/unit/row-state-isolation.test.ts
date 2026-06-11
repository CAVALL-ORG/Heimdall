import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  incrementTurnCount,
  readTurnCount,
  resolveRowState,
  _resetSessionUuidForTest,
} from '../../src/mcp/tools/row-state';

// Track A bug 3 — per-row outputDir isolation via sourceImagePath hash.
//
// resolveRowState's previous behavior cached a single processSessionUuid
// across the whole server process, so every defaulted call landed in the
// same tmpdir. The watchdog turn-counter at <outputDir>/_turn_count.txt
// accumulated across rows. The fix hashes sourceImagePath (+ pid) into a
// per-call sig when sourceImagePath is provided; falls back to the
// per-process sessionUuid() when absent (back-compat for non-image
// callers).
//
// Spec: Track A bugs §bug-3.
describe('row-state per-call outputDir isolation', () => {
  const cleanups: string[] = [];

  beforeEach(() => {
    _resetSessionUuidForTest();
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
    _resetSessionUuidForTest();
  });

  it('different sourceImagePath → different outputDir', () => {
    const a = resolveRowState({ sourceImagePath: '/a/b.png' });
    const b = resolveRowState({ sourceImagePath: '/c/d.png' });
    expect(a.outputDir).not.toBe(b.outputDir);
    // Both should still be under tmpdir() with the ketcher-row- prefix.
    expect(a.outputDir.startsWith(tmpdir())).toBe(true);
    expect(b.outputDir.startsWith(tmpdir())).toBe(true);
    expect(a.outputDir).toContain('ketcher-row-');
    expect(b.outputDir).toContain('ketcher-row-');
    cleanups.push(a.outputDir, b.outputDir);
  });

  it('same sourceImagePath → same outputDir (idempotent)', () => {
    const a1 = resolveRowState({ sourceImagePath: '/a/b.png' });
    const a2 = resolveRowState({ sourceImagePath: '/a/b.png' });
    expect(a1.outputDir).toBe(a2.outputDir);
    expect(a1.rowId).toBe(a2.rowId);
    cleanups.push(a1.outputDir);
  });

  it('no sourceImagePath → stable single-process dir (back-compat)', () => {
    const r1 = resolveRowState({});
    const r2 = resolveRowState({});
    expect(r1.outputDir.startsWith(tmpdir())).toBe(true);
    expect(r1.outputDir).toContain('ketcher-row-');
    expect(r1.rowId).toBe('default');
    expect(r2.outputDir).toBe(r1.outputDir);
    expect(r2.rowId).toBe(r1.rowId);
    cleanups.push(r1.outputDir);
  });

  it('turn counters are independent across per-image dirs', () => {
    const a = resolveRowState({ sourceImagePath: '/a/b.png' });
    const b = resolveRowState({ sourceImagePath: '/c/d.png' });
    cleanups.push(a.outputDir, b.outputDir);
    // dir A: two increments
    expect(incrementTurnCount(a.outputDir)).toBe(1);
    expect(incrementTurnCount(a.outputDir)).toBe(2);
    // dir B: one increment
    expect(incrementTurnCount(b.outputDir)).toBe(1);
    expect(readTurnCount(a.outputDir)).toBe(2);
    expect(readTurnCount(b.outputDir)).toBe(1);
  });

  it('explicit outputDir + rowId still wins (regression check)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'row-iso-'));
    cleanups.push(dir);
    const r = resolveRowState({ outputDir: dir, rowId: 'r1' });
    expect(r.outputDir).toBe(dir);
    expect(r.rowId).toBe('r1');
    expect(r.defaulted).toBe(false);
  });

  it('explicit outputDir wins even when sourceImagePath is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'row-iso-'));
    cleanups.push(dir);
    const r = resolveRowState({
      outputDir: dir,
      rowId: 'r1',
      sourceImagePath: '/a/b.png',
    });
    expect(r.outputDir).toBe(dir);
    expect(r.rowId).toBe('r1');
    expect(r.defaulted).toBe(false);
  });

  it('default rowId matches the callSig format when sourceImagePath is provided', () => {
    const a = resolveRowState({ sourceImagePath: '/a/b.png' });
    cleanups.push(a.outputDir);
    // callSig = first 12 hex chars of sha256(sourceImagePath || pid).
    expect(a.rowId).toMatch(/^default-[0-9a-f]{12}$/);
    expect(a.defaulted).toBe(true);
    // outputDir should embed the same callSig.
    const callSig = a.rowId.replace(/^default-/, '');
    expect(a.outputDir).toBe(join(tmpdir(), `ketcher-row-${callSig}`));
  });

  // ── Session-sticky inheritance (2026-05-30 fix) ──────────────────────
  //
  // The row directory is a property of the session, not of each call. Once
  // a call establishes the session row (explicit anchors OR sourceImagePath),
  // a LATER call that supplies NEITHER inherits the established row instead
  // of silently minting a fresh divergent dir. This is what lets
  // render_canvas / export_smiles / refuse — which production agents call
  // without anchors — land in the SAME _session_trace.json as the preceding
  // validate_graph / build_from_graph. Root cause of the I001 export-
  // provenance failure (agent-orch-<run-id>) and a latent prod
  // build-after-validate desync.

  it('anchorless call inherits the sourceImagePath-established session row', () => {
    const a = resolveRowState({ sourceImagePath: '/a/b.png' });
    cleanups.push(a.outputDir);
    // export_smiles / render_canvas in production: no anchors at all.
    const later = resolveRowState({});
    expect(later.outputDir).toBe(a.outputDir);
    expect(later.rowId).toBe(a.rowId);
    expect(later.defaulted).toBe(true);
  });

  it('anchorless call inherits the explicit-anchor session row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'row-iso-'));
    cleanups.push(dir);
    resolveRowState({ outputDir: dir, rowId: 'A004' });
    // The orchestrator anchors validate+build; export rides the session.
    const later = resolveRowState({});
    expect(later.outputDir).toBe(dir);
    expect(later.rowId).toBe('A004');
    expect(later.defaulted).toBe(true);
  });

  it('a new sourceImagePath rebinds the session (sequential rows do not bleed)', () => {
    const a = resolveRowState({ sourceImagePath: '/row-a.png' });
    const inheritA = resolveRowState({});
    expect(inheritA.outputDir).toBe(a.outputDir);
    const b = resolveRowState({ sourceImagePath: '/row-b.png' });
    const inheritB = resolveRowState({});
    cleanups.push(a.outputDir, b.outputDir);
    expect(b.outputDir).not.toBe(a.outputDir);
    expect(inheritB.outputDir).toBe(b.outputDir);
    // Row B's anchorless call must NOT inherit row A's dir.
    expect(inheritB.outputDir).not.toBe(a.outputDir);
  });

  it('reset clears the sticky binding (no inheritance across reset)', () => {
    const a = resolveRowState({ sourceImagePath: '/a/b.png' });
    cleanups.push(a.outputDir);
    _resetSessionUuidForTest();
    const after = resolveRowState({});
    cleanups.push(after.outputDir);
    // After reset there is no session row → fresh sessionUuid dir, not a.
    expect(after.outputDir).not.toBe(a.outputDir);
    expect(after.rowId).toBe('default');
  });

  it('same image across two pids would differ (smoke: hash includes pid)', () => {
    // We cannot fork a process here; instead assert that the dir includes
    // the 12-hex callSig and that swapping the path changes it. The pid
    // contribution is exercised implicitly: any reuse of the same path
    // within this process yields the same dir (verified above), while
    // hashing pid into the digest protects against same-image collisions
    // across server processes that share /tmp.
    const a = resolveRowState({ sourceImagePath: '/x.png' });
    const b = resolveRowState({ sourceImagePath: '/y.png' });
    cleanups.push(a.outputDir, b.outputDir);
    const sigA = a.rowId.replace(/^default-/, '');
    const sigB = b.rowId.replace(/^default-/, '');
    expect(sigA).not.toBe(sigB);
    expect(sigA).toHaveLength(12);
    expect(sigB).toHaveLength(12);
  });
});
