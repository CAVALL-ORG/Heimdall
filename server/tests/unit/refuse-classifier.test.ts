import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRefusal } from '../../src/adapter/refusal-classifier';
import {
  appendSessionEvent,
  writeUnresolvedTargets,
} from '../../src/mcp/tools/row-state';
import { refuseTools } from '../../src/mcp/tools/refuse';

const refuseTool = refuseTools[0];

describe('refusal-classifier (T2)', () => {
  const cleanups: string[] = [];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'refuse-'));
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

  it('rejects evidence < 20 chars as refusal_lacks_evidence', () => {
    const verdict = classifyRefusal({
      outputDir: dir,
      pixel_evidence: 'too short',
    });
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.reason).toBe('refusal_lacks_evidence');
  });

  it('rejects refuse after successful export_smiles as refusal_after_export', () => {
    appendSessionEvent(dir, {
      tool: 'export_smiles',
      rowId: 'r',
      ts: 1,
      result: { ok: true },
    });
    const verdict = classifyRefusal({
      outputDir: dir,
      pixel_evidence: 'attempted vertex at (200, 300) gave invalid topology',
    });
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.reason).toBe('refusal_after_export');
  });

  it('rejects evidence that cites no row-state anchor when targets exist', () => {
    writeUnresolvedTargets(dir, {
      ok: false,
      round: 1,
      rowId: 'r',
      targets: [
        {
          record_id: 'worksheet_node:n7',
          field: 'segment_endpoint',
          x_center: 500,
          y_center: 500,
          bbox_radius: 0,
          round: 1,
        },
      ],
    });
    const verdict = classifyRefusal({
      outputDir: dir,
      pixel_evidence: 'cannot transcribe this confusing image at all',
    });
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted)
      expect(verdict.reason).toBe('refusal_evidence_unanchored');
  });

  it('accepts non_structure when evidence describes a non-chemistry image', () => {
    const verdict = classifyRefusal({
      outputDir: dir,
      pixel_evidence: 'image is a photograph of a textbook page, not a chemistry diagram',
    });
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted) expect(verdict.classification).toBe('non_structure');
  });

  it('accepts source_resolution_too_low when last crop returned source_too_small', () => {
    appendSessionEvent(dir, {
      tool: 'crop_source_image',
      rowId: 'r',
      ts: 1,
      result: { ok: false, error_code: 'source_too_small' },
    });
    const verdict = classifyRefusal({
      outputDir: dir,
      pixel_evidence: 'source image only 220 px wide; vertices indistinguishable',
    });
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted)
      expect(verdict.classification).toBe('source_resolution_too_low');
  });

  it('accepts unreadable_topology when same (record_id, field) is unresolved across two rounds', () => {
    // Phase 1 Task D: the old version of this test only set
    // unresolved_count > 0 in both rounds because the classifier used a
    // count proxy. The new check requires set-intersection on the
    // (record_id, field) pairs, so the fixture now lists the same
    // worksheet_node:n3.segment_endpoint in both rounds.
    const stuckRecord = {
      record_id: 'worksheet_node:n3',
      field: 'segment_endpoint',
    };
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: 1,
      result: {
        ok: false,
        unresolved_count: 3,
        unresolved_records: [stuckRecord],
      },
    });
    appendSessionEvent(dir, {
      tool: 'validate_graph',
      rowId: 'r',
      ts: 2,
      result: {
        ok: false,
        unresolved_count: 3,
        unresolved_records: [stuckRecord],
      },
    });
    writeUnresolvedTargets(dir, {
      ok: false,
      round: 2,
      rowId: 'r',
      targets: [
        {
          record_id: 'worksheet_node:n3',
          field: 'segment_endpoint',
          x_center: 200,
          y_center: 200,
          bbox_radius: 0,
          round: 2,
        },
      ],
    });
    const verdict = classifyRefusal({
      outputDir: dir,
      pixel_evidence:
        'worksheet_node:n3 still ambiguous after two validate rounds; cannot resolve',
    });
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted)
      expect(verdict.classification).toBe('unreadable_topology');
  });

  it('accepts reaction_input when evidence mentions arrow / reactant', () => {
    const verdict = classifyRefusal({
      outputDir: dir,
      pixel_evidence: 'arrow with reactant on left and product on right',
    });
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted) expect(verdict.classification).toBe('reaction_input');
  });

  it('accepts markush_or_rgroup when evidence mentions R-group', () => {
    const verdict = classifyRefusal({
      outputDir: dir,
      pixel_evidence: 'Markush structure with R1 and R2 substituents drawn',
    });
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted)
      expect(verdict.classification).toBe('markush_or_rgroup');
  });
});

describe('refuse MCP tool (T2)', () => {
  const cleanups: string[] = [];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'refuse-tool-'));
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
    delete process.env.KETCHER_REFUSE_TOOL;
  });

  it('returns refuse_tool_disabled when env flag explicitly disabled', async () => {
    process.env.KETCHER_REFUSE_TOOL = '0';
    const result = await refuseTool.run({} as never, {
      rowId: 'r',
      outputDir: dir,
      pixel_evidence:
        'photograph of a textbook page; not a chemistry diagram at all',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('refuse_tool_disabled');
  });

  it('returns accepted + classification when flag ON and evidence valid', async () => {
    process.env.KETCHER_REFUSE_TOOL = '1';
    const result = await refuseTool.run({} as never, {
      rowId: 'r',
      outputDir: dir,
      pixel_evidence:
        'photograph of a textbook page; not a chemistry diagram at all',
    });
    expect(result.ok).toBe(true);
    expect((result.data as { classification: string }).classification).toBe(
      'non_structure',
    );
  });
});
