/**
 * Phase 1 Task D — refusal-classifier record-id overlap.
 *
 * Verifies the replacement of the old `sameUnresolvedTwice` count proxy with
 * a strict `(record_id, field)` set-intersection check between the last two
 * `validate_graph` rounds in the session trace.
 *
 * Old behavior (count proxy): two consecutive validate rounds with
 * unresolved_count > 0 → escalate to `unreadable_topology`. This
 * false-positives on agents making real progress (10 → 5 → 2 unresolved).
 *
 * New behavior (record-id overlap): escalate iff at least one
 * `(record_id, field)` pair from the previous round is STILL unresolved in
 * the latest round. Progress sessions no longer trip the escalation.
 *
 * Back-compat: trace events emitted before this change have no
 * `unresolved_records` field. Treat them conservatively as "no overlap"
 * (better to miss a stuck case than to false-positive a productive one).
 *
 * Spec: protocol-scaling-for-dense-rows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRefusal } from '../../src/adapter/refusal-classifier';
import {
  appendSessionEvent,
  writeUnresolvedTargets,
} from '../../src/mcp/tools/row-state';

describe('refusal-classifier record-id overlap (Phase 1 Task D)', () => {
  const cleanups: string[] = [];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'refuse-overlap-'));
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

  /**
   * Helper: write an unresolved-targets sidecar so evidence-anchoring passes.
   * The classifier only consults the trace events for overlap detection, but
   * the anchoring gate requires the sidecar to exist when evidence cites
   * row-state anchor tokens like n5. The anchor target itself is whichever
   * id the test wants the evidence to cite.
   */
  function seedAnchor(record_id: string): void {
    writeUnresolvedTargets(dir, {
      ok: false,
      round: 2,
      rowId: 'r',
      targets: [
        {
          record_id,
          field: 'element',
          x_center: 200,
          y_center: 200,
          bbox_radius: 0,
          round: 2,
        },
      ],
    });
  }

  it('progress (disjoint record-ids across rounds) does NOT escalate', () => {
    // Round 1 unresolved: n1.element, n2.wedge.
    // Round 2 unresolved: n5.bond_order.
    // Intersection is empty → no escalation. Real progress was made.
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: 1,
      result: {
        ok: false,
        unresolved_count: 2,
        unresolved_records: [
          { record_id: 'n1', field: 'element' },
          { record_id: 'n2', field: 'wedge' },
        ],
      },
    });
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: 2,
      result: {
        ok: false,
        unresolved_count: 1,
        unresolved_records: [{ record_id: 'n5', field: 'bond_order' }],
      },
    });
    seedAnchor('n5');

    const verdict = classifyRefusal({
      outputDir: dir,
      pixel_evidence:
        'n5 bond_order remains ambiguous after iteration; not yet stuck',
    });
    // With no overlap, unreadable_topology must NOT fire. The verdict may
    // fall through to refusal_lacks_evidence at the bottom of the ladder.
    if (verdict.accepted) {
      expect(verdict.classification).not.toBe('unreadable_topology');
    }
  });

  it('stuck (same (record_id, field) in both rounds) DOES escalate', () => {
    // Round 1 unresolved: n1.element.
    // Round 2 unresolved: n1.element + n7.wedge.
    // n1.element appears in both → escalate to unreadable_topology.
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: 1,
      result: {
        ok: false,
        unresolved_count: 1,
        unresolved_records: [{ record_id: 'n1', field: 'element' }],
      },
    });
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: 2,
      result: {
        ok: false,
        unresolved_count: 2,
        unresolved_records: [
          { record_id: 'n1', field: 'element' },
          { record_id: 'n7', field: 'wedge' },
        ],
      },
    });
    seedAnchor('n1');

    const verdict = classifyRefusal({
      outputDir: dir,
      pixel_evidence:
        'n1 element still ambiguous after two validate rounds; cannot resolve',
    });
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted) {
      expect(verdict.classification).toBe('unreadable_topology');
    }
  });

  it('same record_id but different field does NOT escalate', () => {
    // Round 1: n1.element. Round 2: n1.wedge. The record_id matches but the
    // field differs → no overlap → no escalation. Field-distinguishing
    // matters because an agent can resolve one aspect of a node and still
    // be working on another.
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: 1,
      result: {
        ok: false,
        unresolved_count: 1,
        unresolved_records: [{ record_id: 'n1', field: 'element' }],
      },
    });
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: 2,
      result: {
        ok: false,
        unresolved_count: 1,
        unresolved_records: [{ record_id: 'n1', field: 'wedge' }],
      },
    });
    seedAnchor('n1');

    const verdict = classifyRefusal({
      outputDir: dir,
      pixel_evidence:
        'n1 wedge orientation now in question after element resolved earlier',
    });
    if (verdict.accepted) {
      expect(verdict.classification).not.toBe('unreadable_topology');
    }
  });

  it('legacy trace events without unresolved_records do NOT escalate (back-compat)', () => {
    // Round 1: legacy event (no unresolved_records field, only the old
    // unresolved_count). Round 2: new-style event.
    // Conservative: no overlap can be computed → do not escalate.
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: 1,
      result: {
        ok: false,
        unresolved_count: 3,
        // no unresolved_records — legacy event
      },
    });
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: 2,
      result: {
        ok: false,
        unresolved_count: 1,
        unresolved_records: [{ record_id: 'n1', field: 'element' }],
      },
    });
    seedAnchor('n1');

    const verdict = classifyRefusal({
      outputDir: dir,
      pixel_evidence: 'n1 element value cannot be resolved from current crop',
    });
    if (verdict.accepted) {
      expect(verdict.classification).not.toBe('unreadable_topology');
    }
  });

  it('single validate round only does NOT escalate (need 2 to compare)', () => {
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: 1,
      result: {
        ok: false,
        unresolved_count: 1,
        unresolved_records: [{ record_id: 'n1', field: 'element' }],
      },
    });
    seedAnchor('n1');

    const verdict = classifyRefusal({
      outputDir: dir,
      pixel_evidence: 'n1 element still ambiguous after single validate round',
    });
    if (verdict.accepted) {
      expect(verdict.classification).not.toBe('unreadable_topology');
    }
  });
});
