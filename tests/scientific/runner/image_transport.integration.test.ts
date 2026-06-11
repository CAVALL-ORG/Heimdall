#!/usr/bin/env tsx
/**
 * ════════════════════════════════════════════════════════════════════
 *  Phase 0 (dense-zoom-protocol) transport integration test.
 *
 *  GUARANTEE UNDER TEST: image-rebuild rows run their Ketcher actions
 *  through the REAL MCP loop end-to-end, so the placeholder / zoom /
 *  build / render / export trace is genuine — not synthesized from a
 *  daemon / bridge bypass.
 *
 *  This is a STANDALONE tsx test (own assert harness + exit code). It is
 *  NOT discovered by vitest and is independent of the pytest grader
 *  suite (test_grader.py). It drives the REAL MCP tool `.run()` handlers
 *  (the exact code path the stdio MCP server invokes) against one real
 *  `KetcherRuntime`, plus a real fixture image, and asserts on the
 *  `_session_trace.json` / `_unresolved_targets.json` sidecars those
 *  handlers write.
 *
 *  Three behavioral assertions + one static guard:
 *
 *   A. SUCCESS — real MCP loop with per-call row anchors.
 *      validate_graph → build_from_graph → render_canvas → export_smiles
 *      via the MCP tool handlers writes a real `_session_trace.json`
 *      carrying genuine validate_graph + build_from_graph + render_canvas
 *      + export_smiles events, the build event carries
 *      `args.graph_intent_path` pointing at the on-disk
 *      `<rowId>.graph.json`, and the export event carries the exact
 *      Ketcher SMILES.
 *
 *   B. NEEDS-ZOOM — crop succeeds ONLY after a real MCP validate_graph
 *      named the region. A crop before any validate is hard-rejected
 *      (`crop_before_validate`, no sidecar). After the MCP validate_graph
 *      writes `_unresolved_targets.json` with a named target, a crop near
 *      that target succeeds (`ok:true`).
 *
 *   C. BYPASS — the daemon dispatch buildFromGraph path (the
 *      `RuntimeClient` / `image-rebuild-subagent.template.ts` transport)
 *      produces NO `_session_trace.json` build event and NO
 *      `graph_intent_path`. This is the synthetic-trace bypass §5.1 / §11
 *      warn about: a green-looking build with no real MCP sidecar.
 *
 *   D. STATIC GUARD — the canonical image-rebuild runner template must
 *      NOT route build / render / export through the daemon `RuntimeClient`
 *      (the bypass from C). It must drive those through the MCP tools.
 *      This guard FAILS today (the template uses `rt.buildFromGraph` /
 *      `rt.exportSmiles`) and is the RED that Step 3 turns GREEN.
 *
 *  Run (repo root):
 *      RUN_KETCHER_E2E=1 npx tsx \
 *        tests/scientific/runner/image_transport.integration.test.ts
 *
 *  Skips (exit 0, prints SKIP) when RUN_KETCHER_E2E is unset — it spawns
 *  Chromium via KetcherRuntime, same gate the vitest runtime-e2e suite uses.
 * ════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KetcherRuntime } from '../../../server/src/mcp/runtime';
import { dispatch } from '../../../server/scripts/test-daemon';
import { buildTools } from '../../../server/src/mcp/tools/build';
import { validateTools } from '../../../server/src/mcp/tools/validate';
import { cropTools } from '../../../server/src/mcp/tools/crop';
import { renderTools } from '../../../server/src/mcp/tools/render';
import { exportTools } from '../../../server/src/mcp/tools/export';
import {
  readSessionTrace,
  readUnresolvedTargets,
  type SessionEvent,
} from '../../../server/src/mcp/tools/row-state';

const REPO = join(__dirname, '..', '..', '..');
const TEMPLATE = join(
  REPO,
  'tests/scientific/runner/image-rebuild-subagent.template.ts',
);
// Real committed fixture (manifest row A011 / I015 pool). The needs-zoom
// assertion only needs a real >=300px source so crop_source_image accepts it.
const FIXTURE_IMAGE = join(
  REPO,
  'tests/scientific/images/noisy/rotated_l_alanine.png',
);

// ── micro assert harness ─────────────────────────────────────────────
let failures = 0;
const results: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    results.push(`  PASS  ${name}`);
  } else {
    failures++;
    results.push(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

// Pull the typed tool handler by MCP name.
function tool(defs: { name: string }[], name: string) {
  const t = defs.find((d) => d.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t as {
    name: string;
    run: (runtime: unknown, args: unknown) => Promise<unknown>;
  };
}

type ToolResult = { ok: boolean; data?: unknown; error?: { code?: string } };

// ── fixtures ─────────────────────────────────────────────────────────

// Minimal buildable success graph: benzene (validate passes, builds clean).
const SUCCESS_GRAPH = {
  version: 1 as const,
  label: 'image-transport-success',
  atoms: [1, 2, 3, 4, 5, 6].map((id) => ({
    id,
    element: 'C',
    drawn_H: null,
    charge: 0,
    radical: 0,
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
  rings: [{ id: 'r1', atoms: [1, 2, 3, 4, 5, 6], kind: 'kekule' as const }],
  counts: { heavy: 6, rings: 1, heteroatoms: {} },
};

// Needs-zoom graph: a deferred drawn_H placeholder on an atom that carries
// pixel coords, so validate_graph emits an unresolved target the agent may
// crop. Coords are inside the real fixture's bounds (>0, < image dims).
const NEEDS_ZOOM_GRAPH = {
  version: 1 as const,
  label: 'image-transport-needs-zoom',
  atoms: [
    {
      id: 1,
      element: 'N',
      drawn_H: 2,
      charge: 0,
      radical: 0,
      ring: null,
      x: 120,
      y: 140,
      drawn_H_confidence: 'needs_zoom' as const,
    },
    { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 160, y: 140 },
    { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 200, y: 140 },
    { id: 4, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null, x: 230, y: 120 },
    { id: 5, element: 'O', drawn_H: 1, charge: 0, radical: 0, ring: null, x: 230, y: 170 },
    { id: 6, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 160, y: 100 },
  ],
  bonds: [
    { a: 1, b: 2, order: 1, wedge: null, wedge_from: null },
    { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
    { a: 3, b: 4, order: 2, wedge: null, wedge_from: null },
    { a: 3, b: 5, order: 1, wedge: null, wedge_from: null },
    { a: 2, b: 6, order: 1, wedge: null, wedge_from: null },
  ],
  rings: [],
  counts: { heavy: 6, rings: 0, heteroatoms: { N: 1, O: 2 } },
  unresolved: [
    {
      field: 'drawn_H' as const,
      record_id: 'atom:1',
      note: 'glyph tail under the N runs off-frame; cannot count H',
      state: 'needs_zoom' as const,
    },
  ],
};

// ── D. STATIC GUARD (runs without a runtime) ─────────────────────────
//
// The runner template is the artifact the orchestrator copies for image
// rows. If it still drives build / render / export through the daemon
// `RuntimeClient`, an image row's terminal trace is synthetic (assertion
// C). Assert the template no longer offers that bypass for image rows.
function staticTemplateGuard(): void {
  const src = existsSync(TEMPLATE) ? readFileSync(TEMPLATE, 'utf8') : '';
  check('D.template-exists', src.length > 0, TEMPLATE);
  // The bypass signatures: daemon-client build/export driving the terminal.
  const usesDaemonBuild = /\brt\.buildFromGraph\s*\(/.test(src);
  const usesDaemonExport = /\brt\.exportSmiles\s*\(/.test(src);
  const importsRuntimeClientForBuild = /RuntimeClient/.test(src) && usesDaemonBuild;
  check(
    'D.template-does-not-daemon-build',
    !usesDaemonBuild,
    'template still calls rt.buildFromGraph (daemon bypass; build must go through MCP build_from_graph)',
  );
  check(
    'D.template-does-not-daemon-export',
    !usesDaemonExport,
    'template still calls rt.exportSmiles (daemon bypass; export must go through MCP export_smiles)',
  );
  check(
    'D.template-not-runtimeclient-build-terminal',
    !importsRuntimeClientForBuild,
    'template wires RuntimeClient into the build/export terminal (script-template bypass §11)',
  );
}

// ── A + B + C (need a runtime) ───────────────────────────────────────
async function behavioralAssertions(runtime: KetcherRuntime): Promise<void> {
  const validateGraph = tool(validateTools, 'validate_graph');
  const buildFromGraph = tool(buildTools, 'build_from_graph');
  const cropSourceImage = tool(cropTools, 'crop_source_image');
  const renderCanvas = tool(renderTools, 'render_canvas');
  const exportSmiles = tool(exportTools, 'export_smiles');

  // ===== A. SUCCESS — real MCP loop produces a genuine trace =====
  {
    const dir = mkdtempSync(join(tmpdir(), 'xport-A-'));
    const rowId = 'XPORT_A';
    try {
      const v = (await validateGraph.run(runtime, {
        graph: SUCCESS_GRAPH,
        rowId,
        outputDir: dir,
        sourceImagePath: FIXTURE_IMAGE,
      })) as ToolResult;
      check('A.validate-ok', v.ok === true, JSON.stringify(v.error ?? {}));

      const b = (await buildFromGraph.run(runtime, {
        graph: SUCCESS_GRAPH,
        rowId,
        outputDir: dir,
        sourceImagePath: FIXTURE_IMAGE,
      })) as ToolResult;
      check('A.build-ok', b.ok === true, JSON.stringify(b.error ?? {}));

      const r = (await renderCanvas.run(runtime, {
        format: 'png',
        rowId,
        outputDir: dir,
        sourceImagePath: FIXTURE_IMAGE,
      })) as ToolResult;
      const renderPath = (r.data as { path?: string } | undefined)?.path;
      check('A.render-ok', r.ok === true && !!renderPath && existsSync(renderPath));

      const e = (await exportSmiles.run(runtime, {
        rowId,
        outputDir: dir,
        sourceImagePath: FIXTURE_IMAGE,
      })) as ToolResult;
      const smiles = (e.data as { smiles?: string } | undefined)?.smiles;
      check('A.export-ok', e.ok === true && typeof smiles === 'string' && smiles.length > 0, String(smiles));

      // The real-MCP-loop signature lives in the on-disk session trace.
      const trace: SessionEvent[] = readSessionTrace(dir);
      const validates = trace.filter((ev) => ev.tool === 'validate_graph');
      const builds = trace.filter((ev) => ev.tool === 'build_from_graph');
      const renders = trace.filter((ev) => ev.tool === 'render_canvas');
      const exports = trace.filter((ev) => ev.tool === 'export_smiles');
      check('A.trace-has-validate-event', validates.length >= 1, `n=${validates.length}`);
      check('A.trace-has-build-event', builds.length >= 1, `n=${builds.length}`);
      check('A.trace-has-render-event', renders.length >= 1, `n=${renders.length}`);
      check('A.trace-has-export-event', exports.length >= 1, `n=${exports.length}`);
      const buildEvt = builds[builds.length - 1];
      const gip = (buildEvt?.args as { graph_intent_path?: string } | undefined)?.graph_intent_path;
      check(
        'A.build-event-carries-graph_intent_path',
        typeof gip === 'string' && gip.length > 0,
        String(gip),
      );
      check(
        'A.graph_intent_path-file-written',
        typeof gip === 'string' && existsSync(gip),
        `expected ${gip} on disk`,
      );
      check(
        'A.graph_intent_path-matches-rowid',
        gip === join(dir, `${rowId}.graph.json`),
        String(gip),
      );
      const exportEvt = exports[exports.length - 1];
      const exportedSmiles = (exportEvt?.result as { smiles?: string } | undefined)?.smiles;
      check(
        'A.export-event-carries-exact-smiles',
        typeof smiles === 'string' && exportedSmiles === smiles,
        `event=${String(exportedSmiles)} return=${String(smiles)}`,
      );
      const renderEvt = renders[renders.length - 1];
      const eventRenderPath = (renderEvt?.result as { path?: string } | undefined)?.path;
      check(
        'A.render-event-carries-path',
        typeof eventRenderPath === 'string' && eventRenderPath === renderPath,
        String(eventRenderPath),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ===== A2. PRODUCTION TRANSPORT — anchorless export/render inherit =====
  //
  // Production agents (and the simplified test contract) anchor only the
  // calls that naturally carry context: validate_graph + build_from_graph.
  // render_canvas / export_smiles / refuse are called WITHOUT anchors and
  // must inherit the session row established by the anchored calls — so the
  // export event still lands in the row's _session_trace.json with the exact
  // Ketcher SMILES. Regression lock for the I001 export-provenance failure
  // (agent-orch-<run-id>): before the session-sticky fix, the
  // anchorless export forked to a /tmp dir and the row trace had no export
  // event.
  {
    const dir = mkdtempSync(join(tmpdir(), 'xport-A2-'));
    const rowId = 'XPORT_A2';
    try {
      const v = (await validateGraph.run(runtime, {
        graph: SUCCESS_GRAPH,
        rowId,
        outputDir: dir,
        sourceImagePath: FIXTURE_IMAGE,
      })) as ToolResult;
      check('A2.validate-ok', v.ok === true, JSON.stringify(v.error ?? {}));

      const b = (await buildFromGraph.run(runtime, {
        graph: SUCCESS_GRAPH,
        rowId,
        outputDir: dir,
        sourceImagePath: FIXTURE_IMAGE,
      })) as ToolResult;
      check('A2.build-ok', b.ok === true, JSON.stringify(b.error ?? {}));

      // render + export with NO anchors — exactly what a production agent does.
      const r = (await renderCanvas.run(runtime, { format: 'png' })) as ToolResult;
      check('A2.render-ok', r.ok === true);

      const e = (await exportSmiles.run(runtime, {})) as ToolResult;
      const smiles = (e.data as { smiles?: string } | undefined)?.smiles;
      check('A2.export-ok', e.ok === true && typeof smiles === 'string' && smiles.length > 0, String(smiles));

      // The anchorless render+export events MUST land in the anchored row dir.
      const trace: SessionEvent[] = readSessionTrace(dir);
      const renders = trace.filter((ev) => ev.tool === 'render_canvas');
      const exports = trace.filter((ev) => ev.tool === 'export_smiles');
      check('A2.anchorless-render-event-in-row-dir', renders.length >= 1, `n=${renders.length}`);
      check('A2.anchorless-export-event-in-row-dir', exports.length >= 1, `n=${exports.length}`);
      const exportEvt = exports[exports.length - 1];
      const exportedSmiles = (exportEvt?.result as { smiles?: string } | undefined)?.smiles;
      check(
        'A2.anchorless-export-event-carries-exact-smiles',
        typeof smiles === 'string' && exportedSmiles === smiles,
        `event=${String(exportedSmiles)} return=${String(smiles)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ===== B. NEEDS-ZOOM — crop only after a real MCP validate =====
  {
    const dir = mkdtempSync(join(tmpdir(), 'xport-B-'));
    const rowId = 'XPORT_B';
    try {
      // B.1 crop BEFORE any validate → hard reject (no sidecar yet).
      const early = (await cropSourceImage.run(runtime, {
        rowId,
        outputDir: dir,
        sourceImagePath: FIXTURE_IMAGE,
        x: 120,
        y: 140,
        w: 200,
        h: 200,
      })) as ToolResult;
      check(
        'B.crop-rejected-before-validate',
        early.ok === false && early.error?.code === 'crop_before_validate',
        JSON.stringify(early.error ?? early.data ?? {}),
      );
      check('B.no-sidecar-before-validate', readUnresolvedTargets(dir) === null);

      // B.2 real MCP validate_graph names the unresolved region + writes sidecar.
      const v = (await validateGraph.run(runtime, {
        graph: NEEDS_ZOOM_GRAPH,
        rowId,
        outputDir: dir,
        sourceImagePath: FIXTURE_IMAGE,
      })) as ToolResult;
      check('B.validate-ran', v.ok !== undefined);
      const sidecar = readUnresolvedTargets(dir);
      check('B.sidecar-written-by-mcp-validate', sidecar !== null);
      const namedAtom1 = (sidecar?.targets ?? []).find(
        (t) => t.record_id === 'atom:1' && Number.isFinite(t.x_center),
      );
      check(
        'B.sidecar-names-deferred-region',
        !!namedAtom1,
        JSON.stringify(sidecar?.targets ?? []),
      );

      // B.3 crop near the named target now succeeds.
      if (namedAtom1) {
        const ok = (await cropSourceImage.run(runtime, {
          rowId,
          outputDir: dir,
          sourceImagePath: FIXTURE_IMAGE,
          x: Math.round(namedAtom1.x_center),
          y: Math.round(namedAtom1.y_center),
          w: 200,
          h: 200,
        })) as ToolResult;
        check(
          'B.crop-accepted-after-validate',
          ok.ok === true,
          JSON.stringify(ok.error ?? {}),
        );
      } else {
        check('B.crop-accepted-after-validate', false, 'no named target to crop');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ===== C. BYPASS — daemon dispatch build writes no MCP sidecar =====
  {
    const dir = mkdtempSync(join(tmpdir(), 'xport-C-'));
    const rowId = 'XPORT_C';
    const prevDir = process.env.KETCHER_BUILD_DUMP_DIR;
    const prevRow = process.env.KETCHER_BUILD_DUMP_ROW_ID;
    process.env.KETCHER_BUILD_DUMP_DIR = dir;
    process.env.KETCHER_BUILD_DUMP_ROW_ID = rowId;
    try {
      // The daemon path does NOT clear the canvas (unlike the MCP build tool),
      // so reset before measuring — otherwise a prior build leaks atoms.
      await runtime.callBridge('clearCanvas');
      // The daemon `RuntimeClient` path the template uses calls dispatch()
      // → translateGraphIntent directly, bypassing src/mcp/tools/build.ts.
      // It may either return {ok:true} or rethrow BuildFromGraphError; either
      // way the point of C is the ABSENCE of an MCP session sidecar.
      let daemonBuilt = false;
      try {
        const res = (await dispatch(runtime, 'buildFromGraph', [
          SUCCESS_GRAPH,
          { rowId, buildDumpDir: dir, fingerprintDumpDir: dir },
        ])) as { ok?: boolean };
        daemonBuilt = res?.ok === true;
      } catch {
        daemonBuilt = false; // a throw is still a real daemon-path invocation
      }
      check('C.daemon-build-invoked', true, `built=${daemonBuilt}`);
      // Proof of the bypass: NO MCP session trace, hence no build event and
      // no graph_intent_path the grader / refusal classifier can read.
      const trace = readSessionTrace(dir);
      check(
        'C.daemon-build-writes-no-session-trace',
        trace.length === 0,
        `daemon path unexpectedly wrote ${trace.length} session events`,
      );
      check(
        'C.daemon-build-has-no-build-event',
        !trace.some((ev) => ev.tool === 'build_from_graph'),
        'daemon path emitted a build_from_graph session event',
      );
    } finally {
      if (prevDir === undefined) delete process.env.KETCHER_BUILD_DUMP_DIR;
      else process.env.KETCHER_BUILD_DUMP_DIR = prevDir;
      if (prevRow === undefined) delete process.env.KETCHER_BUILD_DUMP_ROW_ID;
      else process.env.KETCHER_BUILD_DUMP_ROW_ID = prevRow;
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  // Static guard always runs (no runtime needed) — it is the core Step 3
  // RED→GREEN signal and is cheap.
  staticTemplateGuard();

  if (process.env.RUN_KETCHER_E2E !== '1') {
    console.log(
      'image_transport.integration: behavioral A/B/C skipped (set RUN_KETCHER_E2E=1 to run).',
    );
    console.log('Static template guard (D):');
    console.log(results.filter((r) => /\sD\./.test(r)).join('\n'));
    // Even in skip mode the static guard is authoritative: a failing guard
    // means the template still hosts the bypass.
    if (failures > 0) {
      console.error(`\nRESULT: FAIL (${failures} static-guard assertion(s))`);
      process.exit(1);
    }
    console.log('\nRESULT: PASS (static guard only; behavioral assertions skipped)');
    return;
  }

  const runtime = new KetcherRuntime();
  try {
    await runtime.start();
    await behavioralAssertions(runtime);
  } finally {
    await runtime.stop();
  }

  console.log('image_transport.integration results:');
  console.log(results.join('\n'));
  if (failures > 0) {
    console.error(`\nRESULT: FAIL (${failures} assertion(s))`);
    process.exit(1);
  }
  console.log('\nRESULT: PASS (all transport assertions)');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
