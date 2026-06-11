/**
 * ════════════════════════════════════════════════════════════════════
 *  Image-rebuild test-runner — MCP-ONLY transport (no script terminal).
 *
 *  >>> THERE IS NO SCRIPT BUILD/EXPORT TEMPLATE FOR IMAGE ROWS. <<<
 *
 *  Image-rebuild rows run their ENTIRE Ketcher loop — validate_graph,
 *  crop_source_image, build_from_graph, render_canvas, export_smiles,
 *  refuse — through the `mcp__heimdall__*` tools, in SEQUENTIAL
 *  mode. This is the only path that fires the real protocol: the
 *  `validate_graph` `_unresolved_targets.json` sidecar, the
 *  `crop_source_image` proximity gate, the `build_from_graph`
 *  validate-hash gate + `_session_trace.json` build event (with
 *  `args.graph_intent_path`), the `render_canvas` PNG, and the `refuse`
 *  classifier all live in the MCP tool handlers.
 *
 *  WHY THE OLD DAEMON TEMPLATE WAS DELETED (dense-zoom-protocol Phase 0,
 *  2026-05-30): the previous version copied a tsx script that ran the
 *  FINAL build → render → export through the daemon `RuntimeClient`
 *  (`server/dist/scripts/test-daemon-client.mjs`). That path calls
 *  `translateGraphIntent` directly and writes NONE of the MCP sidecars.
 *  A row whose build/export went through it produced a green-looking
 *  result with a SYNTHETIC trace — the placeholder/zoom loop never
 *  actually ran end-to-end. A004 lost exactly this way: its
 *  `_session_trace.json` had crop rejections (`crop_before_validate`)
 *  and zero `validate_graph` events because the sidecar was never
 *  written, so every crop hard-rejected and the agent fell back to a
 *  confident-wrong full-image draft. (Script-template bypass is the
 *  biggest trap in the dense-zoom protocol.)
 *
 *  The transport integration test
 *  (`tests/scientific/runner/image_transport.integration.test.ts`)
 *  STATICALLY guards this file: it fails if this template ever again
 *  routes build / export through `RuntimeClient` / `rt.buildFromGraph` /
 *  `rt.exportSmiles`.
 *
 *  ── HOW TO DRIVE AN IMAGE-REBUILD ROW (MCP-only) ────────────────────
 *
 *  1. Read the source image (mandatory first event).
 *  2. Draft a direct GraphIntent (atoms + bonds + rings + counts, plus
 *     optional `unsure_regions` and per-record `unresolved[]` /
 *     `needs_zoom` placeholders).
 *  3. validate-zoom loop, all via MCP tools:
 *       mcp__heimdall__validate_graph   { graph }
 *       mcp__heimdall__crop_source_image{ sourceImagePath, x, y, w, h }
 *       (Read the crop, emit CROP_RATIONALE, refine the draft, re-validate.)
 *     `validate_graph` writes the `_unresolved_targets.json` sidecar that
 *     `crop_source_image` gates against — crops are REFUSED
 *     (`crop_before_validate`) until a validate round names the region.
 *  4. Terminal, also via MCP tools:
 *       mcp__heimdall__build_from_graph  { graph }     ← gated on a
 *                                                             passing validate
 *       mcp__heimdall__render_canvas     { showAtomIds: true }
 *       mcp__heimdall__export_smiles     {}            ← emits SMILES:
 *     OR, when the pixels cannot be transcribed:
 *       mcp__heimdall__refuse            { ... }       ← no SMILES line
 *
 *  The orchestrator sets `KETCHER_BUILD_DUMP_DIR` + `KETCHER_BUILD_DUMP_ROW_ID`
 *  in the MCP environment so the build path writes `<rowId>.graph.json`
 *  and stamps `graph_intent_path` on the build session event (the grader's
 *  un-blinded stereo resolver reads it). With MCP transport this is
 *  automatic — no per-script forensics wiring is needed.
 *
 *  Emit one `TRACE:` line per MCP op (snake_case), the
 *  `TRACE: render_canvas <abs-path>` line with the path render_canvas
 *  returned, and the terminal `SMILES: <line>` (success) or refusal prose
 *  (no SMILES). See `tests/scientific/runner/prompts/system.md`.
 *
 *  ── do NOT copy this file into a per-row run.ts ─────────────────────
 *  It is a contract reference, not an executable. Running it aborts so a
 *  stale "copy the template" habit fails loudly instead of silently
 *  reintroducing the daemon bypass.
 * ════════════════════════════════════════════════════════════════════
 */

throw new Error(
  'image-rebuild rows are MCP-only: there is no script build/export template. ' +
    'Drive validate_graph / crop_source_image / build_from_graph / render_canvas / ' +
    'export_smiles / refuse through the mcp__heimdall__* tools in SEQUENTIAL mode. ' +
    'See the header of this file and tests/scientific/runner/prompts/system.md.',
);
