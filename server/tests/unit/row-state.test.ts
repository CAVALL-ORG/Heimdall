import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendSessionEvent,
  incrementTurnCount,
  proximityHit,
  readSessionTrace,
  readTurnCount,
  readUnresolvedTargets,
  renameImageHandle,
  resolveRowState,
  scrubAgentText,
  stableHash,
  WATCHDOG_COUNTED_TOOLS,
  writeUnresolvedTargets,
  _resetSessionUuidForTest,
} from '../../src/mcp/tools/row-state';

describe('row-state sidecar primitives', () => {
  const cleanups: string[] = [];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'row-state-'));
    cleanups.push(dir);
    _resetSessionUuidForTest();
    delete process.env.KETCHER_SCRUB_TELEMETRY;
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
    delete process.env.KETCHER_SCRUB_TELEMETRY;
  });

  it('readUnresolvedTargets returns null when sidecar absent', () => {
    expect(readUnresolvedTargets(dir)).toBeNull();
  });

  it('write/read round-trips an unresolved-targets sidecar', () => {
    writeUnresolvedTargets(dir, {
      ok: false,
      round: 2,
      rowId: 'A004',
      targets: [
        {
          record_id: 'worksheet_node:n5',
          field: 'segment_endpoint',
          x_center: 420,
          y_center: 380,
          bbox_radius: 50,
          round: 2,
        },
      ],
    });
    const out = readUnresolvedTargets(dir);
    expect(out?.round).toBe(2);
    expect(out?.targets).toHaveLength(1);
    expect(out?.targets[0].record_id).toBe('worksheet_node:n5');
  });

  it('readTurnCount returns 0 before any increment; incrementTurnCount monotonic', () => {
    expect(readTurnCount(dir)).toBe(0);
    expect(incrementTurnCount(dir)).toBe(1);
    expect(incrementTurnCount(dir)).toBe(2);
    expect(readTurnCount(dir)).toBe(2);
  });

  it('appendSessionEvent grows trace; readSessionTrace returns chronological order', () => {
    appendSessionEvent(dir, { tool: 'validate_graph', rowId: 'r', ts: 1 });
    appendSessionEvent(dir, { tool: 'crop_source_image', rowId: 'r', ts: 2 });
    const trace = readSessionTrace(dir);
    expect(trace).toHaveLength(2);
    expect(trace[0].tool).toBe('validate_graph');
    expect(trace[1].tool).toBe('crop_source_image');
  });

  it('proximityHit accepts crops within 0.25 * min(w,h) of any target center', () => {
    const target = {
      record_id: 'worksheet_node:n1',
      field: 'segment_endpoint',
      x_center: 500,
      y_center: 500,
      bbox_radius: 0,
      round: 1,
    };
    expect(proximityHit([target], 510, 490, 200, 200)).toBe(target);
    expect(proximityHit([target], 800, 800, 200, 200)).toBeNull();
  });

  it('proximityHit honors bbox_radius slack', () => {
    const target = {
      record_id: 'worksheet_node:n1',
      field: 'segment_endpoint',
      x_center: 500,
      y_center: 500,
      bbox_radius: 100,
      round: 1,
    };
    // 0.25*200 = 50 slack + 100 radius = 150 effective
    expect(proximityHit([target], 600, 600, 200, 200)?.record_id).toBe(
      'worksheet_node:n1',
    );
  });

  it('resolveRowState passes through agent-supplied outputDir+rowId', () => {
    const r = resolveRowState({ outputDir: dir, rowId: 'A004' });
    expect(r.outputDir).toBe(dir);
    expect(r.rowId).toBe('A004');
    expect(r.defaulted).toBe(false);
  });

  it('resolveRowState defaults to session-scoped path when missing', () => {
    const r = resolveRowState({});
    expect(r.outputDir.startsWith(tmpdir())).toBe(true);
    expect(r.outputDir).toContain('ketcher-row-');
    expect(r.rowId).toBe('default');
    expect(r.defaulted).toBe(true);
    const r2 = resolveRowState({});
    expect(r2.outputDir).toBe(r.outputDir);
  });

  it('renameImageHandle creates symlink at <outputDir>/source<ext>', () => {
    const src = join(dir, 'paclitaxel.png');
    writeFileSync(src, 'fake png');
    const handle = renameImageHandle(src, dir);
    expect(handle).toBe(join(dir, 'source.png'));
    expect(existsSync(handle)).toBe(true);
    expect(readlinkSync(handle)).toBe(src);
  });

  it('renameImageHandle returns source path when source missing (no symlink)', () => {
    const handle = renameImageHandle(join(dir, 'missing.png'), dir);
    expect(handle).toBe(join(dir, 'missing.png'));
  });

  it('stableHash is deterministic across key orderings', () => {
    const a = stableHash({ a: 1, b: [2, 3], c: { d: 4 } });
    const b = stableHash({ c: { d: 4 }, b: [2, 3], a: 1 });
    expect(a).toBe(b);
    const c = stableHash({ a: 1, b: [2, 3] });
    expect(c).not.toBe(a);
  });

  it('WATCHDOG_COUNTED_TOOLS includes the five counted image-rebuild surfaces (refuse excluded as escape terminal)', () => {
    expect(WATCHDOG_COUNTED_TOOLS).toContain('validate_graph');
    expect(WATCHDOG_COUNTED_TOOLS).toContain('crop_source_image');
    expect(WATCHDOG_COUNTED_TOOLS).toContain('build_from_graph');
    expect(WATCHDOG_COUNTED_TOOLS).toContain('render_canvas');
    expect(WATCHDOG_COUNTED_TOOLS).toContain('export_smiles');
    // refuse is the escape terminal — must remain callable even after cap
    expect(WATCHDOG_COUNTED_TOOLS).not.toContain('refuse');
    expect(WATCHDOG_COUNTED_TOOLS).not.toContain('get_state');
  });

  it('scrubAgentText is no-op when flag explicitly disabled', () => {
    const prev = process.env.KETCHER_SCRUB_TELEMETRY;
    process.env.KETCHER_SCRUB_TELEMETRY = '0';
    try {
      const raw = 'LOCK 9 fired: 14 backend turns left, min(w,h)=180 < 300';
      expect(scrubAgentText(raw)).toBe(raw);
    } finally {
      if (prev === undefined) delete process.env.KETCHER_SCRUB_TELEMETRY;
      else process.env.KETCHER_SCRUB_TELEMETRY = prev;
    }
  });

  it('scrubAgentText strips LOCK numbers and integer thresholds when flag ON', () => {
    process.env.KETCHER_SCRUB_TELEMETRY = '1';
    const raw = 'LOCK 9 fired: 14 backend turns left, 6 crops remaining';
    const out = scrubAgentText(raw);
    expect(out).not.toMatch(/LOCK\s*9/);
    expect(out).not.toMatch(/14 backend turns/);
    expect(out).not.toMatch(/6 crops/);
  });
});
