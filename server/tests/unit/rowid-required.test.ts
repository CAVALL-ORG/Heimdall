import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import {
  resolveRowState,
  _resetSessionUuidForTest,
} from '../../src/mcp/tools/row-state';
import { buildTools } from '../../src/mcp/tools/build';
import { exportTools } from '../../src/mcp/tools/export';
import { renderTools } from '../../src/mcp/tools/render';
import { cropTools } from '../../src/mcp/tools/crop';
import { validateTools } from '../../src/mcp/tools/validate';
import { refuseTools } from '../../src/mcp/tools/refuse';
import type { ToolDefinition } from '../../src/mcp/tools/types';

// Solution #2 — rowId is REQUIRED on the canvas-WRITE tools that cause
// cross-row contamination: build_from_graph (the canvas write that would
// clobber a shared default key) and crop_source_image (per-row dir write +
// validate-sidecar read). Both are image-rebuild-exclusive, so requiring rowId
// there does not touch ketcher-ingest / ketcher-simple-edit.
//
// export_smiles and render_canvas are READS — a missing rowId reads the default
// canvas (self-caught: empty/mismatched own result, never another row's write).
// They are shared with ingest (export) and simple-edit (render), which call
// them anchorless, so they keep rowId OPTIONAL at the schema; the image-rebuild
// skill still mandates rowId on them for read correctness. validate_graph (pure
// preflight) and refuse (terminal) likewise stay optional.

function toolByName(arr: ToolDefinition[], name: string): ToolDefinition {
  const t = arr.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

const minimalArgs: Record<string, Record<string, unknown>> = {
  build_from_graph: { graph: { atoms: [], bonds: [], rings: [], counts: {} } },
  crop_source_image: { sourceImagePath: '/x.png', x: 1, y: 1, w: 10, h: 10 },
};

describe('rowId is required on canvas-WRITE tools (build + crop)', () => {
  const cases: Array<[string, ToolDefinition]> = [
    ['build_from_graph', toolByName(buildTools, 'build_from_graph')],
    ['crop_source_image', toolByName(cropTools, 'crop_source_image')],
  ];

  // Isolate the rowId requirement from any other field validation (e.g. the
  // GraphIntent shape on build/validate): a missing rowId must surface a
  // rowId-path issue; supplying one must clear that specific issue.
  function hasRowIdIssue(tool: ToolDefinition, args: Record<string, unknown>): boolean {
    const res = tool.inputValidator.safeParse(args);
    if (res.success) return false;
    return res.error.issues.some((i) => i.path.includes('rowId'));
  }

  for (const [name, tool] of cases) {
    it(`${name} flags a missing rowId`, () => {
      expect(hasRowIdIssue(tool, minimalArgs[name])).toBe(true);
    });

    it(`${name} has no rowId complaint once a rowId is supplied`, () => {
      expect(hasRowIdIssue(tool, { ...minimalArgs[name], rowId: 'mol-1' })).toBe(false);
    });
  }

  // Read / shared tools keep rowId OPTIONAL at the schema (skill-mandated only).
  it('export_smiles keeps rowId OPTIONAL (shared with ingest; read, self-caught)', () => {
    const e = toolByName(exportTools, 'export_smiles');
    expect(hasRowIdIssue(e, {})).toBe(false);
  });

  it('render_canvas keeps rowId OPTIONAL (shared with simple-edit; read)', () => {
    const r = toolByName(renderTools, 'render_canvas');
    expect(hasRowIdIssue(r, {})).toBe(false);
  });

  it('validate_graph keeps rowId OPTIONAL (pure preflight, not row-coupled)', () => {
    const v = toolByName(validateTools, 'validate_graph');
    expect(hasRowIdIssue(v, { graph: { atoms: [], bonds: [], rings: [], counts: {} } })).toBe(false);
  });

  it('refuse keeps rowId OPTIONAL (terminal escape)', () => {
    const r = toolByName(refuseTools, 'refuse');
    expect(hasRowIdIssue(r, { pixel_evidence: 'cannot read any strokes' })).toBe(false);
  });
});

describe('resolveRowState derives a deterministic per-rowId dir from rowId alone', () => {
  const cleanups: string[] = [];
  beforeEach(() => _resetSessionUuidForTest());
  afterEach(() => {
    for (const d of cleanups) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    cleanups.length = 0;
    _resetSessionUuidForTest();
  });

  it('same rowId (no outputDir) → same dir; different rowId → different dir', () => {
    const a = resolveRowState({ rowId: 'mol-1' });
    const a2 = resolveRowState({ rowId: 'mol-1' });
    const b = resolveRowState({ rowId: 'mol-2' });
    cleanups.push(a.outputDir, b.outputDir);
    expect(a.rowId).toBe('mol-1');
    expect(a.outputDir).toBe(a2.outputDir);
    expect(a.outputDir).not.toBe(b.outputDir);
    expect(a.outputDir.startsWith(tmpdir())).toBe(true);
    expect(a.outputDir).toContain('ketcher-row-');
  });

  it('rowId wins over sourceImagePath for dir derivation (validate+build share a row)', () => {
    // validate carries the image; build carries only the rowId. Same rowId ⇒
    // same dir, so the validate→build trace gate stays row-scoped.
    const v = resolveRowState({ rowId: 'mol-1', sourceImagePath: '/img.png' });
    const bld = resolveRowState({ rowId: 'mol-1' });
    cleanups.push(v.outputDir);
    expect(bld.outputDir).toBe(v.outputDir);
  });

  it('explicit outputDir + rowId still authoritative (regression)', () => {
    const r = resolveRowState({ rowId: 'mol-1', outputDir: '/tmp/explicit-xyz' });
    expect(r.outputDir).toBe('/tmp/explicit-xyz');
    expect(r.rowId).toBe('mol-1');
    expect(r.defaulted).toBe(false);
    cleanups.push('/tmp/explicit-xyz');
  });
});
