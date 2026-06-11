/**
 * Fix B+C — ratchet-failure remediation pass.
 *
 * Three coupled invariants tested here:
 *   1. Watchdog default cap raised 30 → 50 (dense polycycle headroom).
 *   2. `refuse` removed from WATCHDOG_COUNTED_TOOLS — escape terminal
 *      stays callable even after the cap binds.
 *   3. `evaluateWatchdog` records a `session_terminated` event in the
 *      session trace BEFORE returning the error, so the refusal
 *      classifier can recognize watchdog-terminated sessions via the
 *      new `session_capped` class (which bypasses the
 *      evidence-anchoring gate).
 *
 * Closes hi-res ratchet failure mode S-B (cap binding + refuse trap):
 * agent-orch-<run-id> A009/A011 used 35/36 ops before completing
 * the validate-zoom loop on K=9-10 dense rings, hit the cap, and could
 * not honestly refuse because refuse was itself capped.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateWatchdog,
  readSessionTrace,
  WATCHDOG_COUNTED_TOOLS,
  WATCHDOG_DEFAULT_CAP,
  appendSessionEvent,
  writeUnresolvedTargets,
} from '../../src/mcp/tools/row-state';
import { classifyRefusal } from '../../src/adapter/refusal-classifier';

describe('watchdog cap + refuse-as-escape (Fix B+C)', () => {
  const cleanups: string[] = [];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wd-refuse-'));
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
    delete process.env.KETCHER_WATCHDOG;
    delete process.env.KETCHER_AGENT_TURN_CAP;
  });

  it('WATCHDOG_DEFAULT_CAP is 50', () => {
    expect(WATCHDOG_DEFAULT_CAP).toBe(50);
  });

  it('WATCHDOG_COUNTED_TOOLS does NOT include "refuse"', () => {
    expect(WATCHDOG_COUNTED_TOOLS).not.toContain('refuse');
    // Sanity: the other 5 tools are still counted — only refuse is excluded.
    expect(WATCHDOG_COUNTED_TOOLS).toEqual(
      expect.arrayContaining([
        'validate_graph',
        'crop_source_image',
        'build_from_graph',
        'render_canvas',
        'export_smiles',
      ]),
    );
  });

  it('refuse is callable after watchdog has terminated a session', () => {
    process.env.KETCHER_WATCHDOG = '1';
    process.env.KETCHER_AGENT_TURN_CAP = '2';

    // Burn through cap on a counted tool.
    expect(
      evaluateWatchdog('validate_graph', { rowId: 'r', outputDir: dir }),
    ).toBeNull();
    expect(
      evaluateWatchdog('validate_graph', { rowId: 'r', outputDir: dir }),
    ).toBeNull();
    const terminated = evaluateWatchdog('validate_graph', {
      rowId: 'r',
      outputDir: dir,
    });
    expect(terminated?.error.code).toBe('session_terminated');

    // refuse must remain callable — evaluateWatchdog returns null because
    // refuse is not in the counted set, so the server proceeds to invoke
    // the refusal classifier normally.
    const refuseGate = evaluateWatchdog('refuse', {
      rowId: 'r',
      outputDir: dir,
    });
    expect(refuseGate).toBeNull();
  });

  it('evaluateWatchdog records session_terminated event in _session_trace.json', () => {
    process.env.KETCHER_WATCHDOG = '1';
    process.env.KETCHER_AGENT_TURN_CAP = '1';

    // First call — under cap, no trace entry from the watchdog itself.
    evaluateWatchdog('validate_graph', { rowId: 'r', outputDir: dir });
    const beforeTermination = readSessionTrace(dir);
    expect(
      beforeTermination.some(
        (e) => e.result?.error_code === 'session_terminated',
      ),
    ).toBe(false);

    // Second call — exceeds cap. evaluateWatchdog must record the
    // terminated event before returning.
    const terminated = evaluateWatchdog('validate_graph', {
      rowId: 'r',
      outputDir: dir,
    });
    expect(terminated?.error.code).toBe('session_terminated');

    const trace = readSessionTrace(dir);
    expect(trace.length).toBeGreaterThan(0);
    const last = trace[trace.length - 1];
    expect(last.result?.error_code).toBe('session_terminated');
    expect(last.tool).toBe('validate_graph');
    expect(last.rowId).toBe('r');
  });

  it('classifier emits session_capped when trace shows watchdog termination', () => {
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: Date.now(),
      args: {},
      result: { ok: false, error_code: 'session_terminated' },
    });

    const verdict = classifyRefusal({
      outputDir: dir,
      pixel_evidence:
        'session was terminated by the runtime before reaching a clean build path',
    });

    expect(verdict.accepted).toBe(true);
    if (verdict.accepted) {
      expect(verdict.classification).toBe('session_capped');
    }
  });

  it('session_capped bypasses evidence-anchoring gate', () => {
    // Seed an unresolved target so the anchoring gate would normally
    // engage and reject evidence that cites no anchor token.
    const anchorTarget = {
      record_id: 'worksheet_node:n7',
      field: 'segment_endpoint',
      x_center: 500,
      y_center: 500,
      bbox_radius: 0,
      round: 1,
    };
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: Date.now(),
      args: {},
      result: { ok: false, unresolved_count: 1 },
    });
    // Write the unresolved sidecar directly so collectAnchorTokens picks
    // up the n7 anchor.
    writeUnresolvedTargets(dir, {
      ok: false,
      round: 1,
      rowId: 'r',
      targets: [anchorTarget],
    });

    // Then watchdog terminates AFTER targets were set.
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: Date.now() + 1,
      args: {},
      result: { ok: false, error_code: 'session_terminated' },
    });

    // Evidence cites NO record_id, NO n<int>, NO (x,y). Normally this
    // would be rejected as refusal_evidence_unanchored. With
    // session_capped placed before the anchoring gate, the classifier
    // accepts.
    const verdict = classifyRefusal({
      outputDir: dir,
      pixel_evidence:
        'cannot continue — runtime killed the session before targets cleared',
    });

    expect(verdict.accepted).toBe(true);
    if (verdict.accepted) {
      expect(verdict.classification).toBe('session_capped');
    }
  });
});
