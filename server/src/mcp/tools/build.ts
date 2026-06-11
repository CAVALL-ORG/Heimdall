import { join } from 'node:path';
import { z } from 'zod';
import { BuildFromGraphError } from '../../adapter/graph-intent/errors';
import { translateGraphIntent } from '../../adapter/graph-intent/translator';
import {
  buildStereoAdvisory,
  buildMethylWedgeAdvisory,
} from '../../adapter/graph-intent/stereo-advisory';
import { graphIntentSchema } from '../../types/graph-intent';
import { RuntimeMutationError } from '../runtime';
import type { ToolDefinition } from './types';
import {
  appendSessionEvent,
  readSessionTrace,
  readUnresolvedTargets,
  resolveRowState,
  scrubAgentText,
  stableHash,
  writeUnresolvedTargets,
} from './row-state';

// T1b — build-after-validate gate. Default ON in Phase 2.
const BUILD_AFTER_VALIDATE_ENABLED = () =>
  process.env.KETCHER_BUILD_AFTER_VALIDATE !== '0';

const layoutEnum = z.enum(['auto', 'preserve', 'clean']);

const buildFromGraphSchema = z.object({
  graph: graphIntentSchema,
  validate_counts: z.boolean().optional().default(true),
  // 'auto' = preserve when any atom has coords, else clean. 'preserve' =
  // unconditional skip. 'clean' = unconditional run. Default 'auto'.
  layout: layoutEnum.optional().default('auto'),
  // Optional row-state anchors (T1b build-after-validate gate). Production
  // agents may omit; server-default resolver picks a session-scoped path.
  rowId: z.string().min(1),
  outputDir: z.string().min(1).optional(),
  // Optional sourceImagePath — when present, server-default resolver
  // hashes it into the default outputDir so build_from_graph lands in
  // the SAME row dir as the preceding validate_graph round (per-row
  // isolation, no cross-row turn-counter leak).
  sourceImagePath: z.string().optional(),
});

export const buildTools: ToolDefinition[] = [
  {
    name: 'build_from_graph',
    description:
      'Build a molecule from a structured GraphIntent. ' +
      'The translator runs skeleton → element overrides → bond orders → aromatize → drawn_H → ' +
      'charge → radical → wedges → Indigo CIP perception → selective V2000 solver re-apply (Mode C) → ' +
      'count check → clean. Atomic — reverts on schema or count mismatch. Returns atomIdMap / bondIdMap / ' +
      'visionFingerprint / state. Agents call validate_graph FIRST for stateless preflight on the draft. ' +
      'Example: { "graph": { "version": 1, "atoms": [{"id":0,"element":"C","drawn_H":null,"charge":0,"radical":0,"ring":null},{"id":1,"element":"O","drawn_H":null,"charge":0,"radical":0,"ring":null}], "bonds": [{"a":0,"b":1,"order":1,"wedge":null,"wedge_from":null}], "rings": [], "counts": {"heavy":2,"rings":0,"heteroatoms":{"O":1}} }, "rowId": "demo" }',
    inputSchema: {
      type: 'object',
      properties: {
        graph: { type: 'object' },
        validate_counts: { type: 'boolean' },
        layout: { type: 'string', enum: ['auto', 'preserve', 'clean'] },
        // Optional row-state anchors (mirrors validate_graph's zod schema).
        // When the orchestrator passes rowId+outputDir, resolveRowState
        // anchors the row deterministically AND the GraphIntent dump lands at
        // <outputDir>/<rowId>.graph.json — the grader's un-blinded stereo
        // resolver reads that file. The MCP server is a separate persistent
        // process with no per-row shell-env channel under the agent-orch
        // harness, so env-only dump wiring (below) never fires there; the
        // resolved-anchor fallback is what writes the dump on the MCP path.
        rowId: { type: 'string' },
        outputDir: { type: 'string' },
        sourceImagePath: { type: 'string' },
      },
      required: ['graph', 'rowId'],
      additionalProperties: false,
    },
    inputValidator: buildFromGraphSchema,
    run: async (runtime, args) => {
      const parsed = buildFromGraphSchema.parse(args);

      const { outputDir, rowId, defaulted } = resolveRowState({
        rowId: parsed.rowId,
        outputDir: parsed.outputDir,
        sourceImagePath: parsed.sourceImagePath,
      });
      const submittedGraphHash = stableHash(parsed.graph);

      // Phase 0 (image-harness-grading-correctness): the deterministic
      // GraphIntent dump location the translator writes when the forensics
      // env is set. Recorded on the success event below so the grader's
      // resolver has a trace-embedded pointer that does NOT depend on
      // re-reading the build-dump env at grade time.
      // Env vars remain the primary channel (a standalone tsx/daemon
      // orchestrator that controls the server-process env). Under the
      // agent-orch MCP harness the server is a separate persistent process
      // with no per-row shell-env channel, so fall back to the RESOLVED row
      // anchors: when the caller passed explicit rowId+outputDir
      // (defaulted === false), write the per-row dump at
      // <outputDir>/<rowId>.graph.json. Production agents that omit the
      // anchors (defaulted === true) keep the historical no-op.
      const buildDumpDir =
        process.env.KETCHER_BUILD_DUMP_DIR ?? (defaulted ? undefined : outputDir);
      const buildDumpRowId =
        process.env.KETCHER_BUILD_DUMP_ROW_ID ?? (defaulted ? undefined : rowId);
      const graphIntentPath =
        buildDumpDir && buildDumpRowId
          ? join(buildDumpDir, `${buildDumpRowId}.graph.json`)
          : undefined;

      // T1b — build-after-validate gate. Verify a passing validate_graph
      // round on the SAME graph exists in the row trace. Two error modes:
      // build_without_validate / build_graph_differs_from_validated.
      // NOTE: gate check runs BEFORE clearCanvas so rejected calls don't
      // disturb the canvas state.
      if (BUILD_AFTER_VALIDATE_ENABLED()) {
        const trace = readSessionTrace(outputDir);
        const passingValidates = trace.filter(
          (e) => e.tool === 'validate_graph' && e.result?.ok === true,
        );
        if (passingValidates.length === 0) {
          return {
            ok: false,
            error: {
              code: 'build_without_validate',
              message:
                'build_from_graph requires a passing validate_graph round in ' +
                'the current session. Submit the draft to validate_graph first; ' +
                'address any unresolved targets; then build.',
            },
          };
        }
        const latest = passingValidates[passingValidates.length - 1];
        const validatedHash = latest.result?.graph_hash;
        if (
          typeof validatedHash !== 'string' ||
          validatedHash !== submittedGraphHash
        ) {
          return {
            ok: false,
            error: {
              code: 'build_graph_differs_from_validated',
              message:
                'The graph submitted to build_from_graph differs from the ' +
                'most-recently-validated graph. Re-submit the current draft ' +
                'to validate_graph; if it passes, build that same draft.',
            },
          };
        }
      }

      // Clear canvas so back-to-back rows start on a blank canvas
      // (prevents cross-row atom leakage). Runs after gate checks so
      // rejected calls do not disturb the canvas state.
      await runtime.callBridge('clearCanvas');

      const graphForBuild = parsed.graph;
      // Task 3 — hard-pin validate_counts:true on the tool layer.
      // build_from_graph is the Ketcher-authored build path for both
      // ketcher-image-rebuild (vision) and ketcher-ingest, both contracted to
      // validate_counts:true. An agent self-authorizing false silently shipped
      // a wrong skeleton in A004H-r1 (declared 7 rings, bonds formed 10 cycles,
      // bypassed the check). The field is still accepted by the zod schema for
      // back-compat but is ignored/overridden here. Only the tool layer pins it;
      // translateGraphIntent's validate_counts option stays a real boolean so
      // direct-translator calls (runtime-e2e tests with intentionally mismatched
      // fixtures) are unaffected.
      const validateCounts = true;
      let buildError: BuildFromGraphError | null = null;
      // Holder object, not a bare `let`: translatorOutput is assigned only
      // inside the async applyMutation closure below, which the outer
      // control-flow analysis cannot see — a bare `let` would stay narrowed to
      // its `null` initializer at the read sites. A property read uses the
      // declared property type, so the assignment is honored.
      const captured: {
        translatorOutput: {
          atomIdMap: Record<number, number>;
          bondIdMap: Record<string, number>;
          visionFingerprint: unknown;
          complexity: unknown;
          stereoLossDiagnostics: unknown;
          perceivedUndefinedStereoCenters: number[];
          degenerateStereoFindings: unknown[];
        } | null;
      } = { translatorOutput: null };
      try {
        const mutationResult = await runtime.applyMutation(
          'build_from_graph',
          { validate_counts: validateCounts, layout: parsed.layout },
          async () => {
            try {
              const out = await translateGraphIntent(runtime, graphForBuild, {
                validate_counts: validateCounts,
                layout: parsed.layout,
                // Phase 0 (image-harness-grading-correctness): route the MCP
                // build path through the forensics dump so every image build
                // writes a deterministic <rowId>.graph.json the grader's
                // un-blinded stereo resolver can read. Mirrors the existing
                // env-var shape; the dump no-ops when the env is unset.
                forensics: { buildDumpDir, rowId: buildDumpRowId },
              });
              captured.translatorOutput = {
                atomIdMap: out.atomIdMap,
                bondIdMap: out.bondIdMap,
                visionFingerprint: out.visionFingerprint,
                complexity: out.complexity,
                stereoLossDiagnostics: out.stereoLossDiagnostics ?? [],
                perceivedUndefinedStereoCenters:
                  out.perceivedUndefinedStereoCenters ?? [],
                degenerateStereoFindings: out.degenerateStereoFindings ?? [],
              };
            } catch (err) {
              if (err instanceof BuildFromGraphError) buildError = err;
              throw err;
            }
          },
        );
        appendSessionEvent(outputDir, {
          tool: 'build_from_graph',
          rowId,
          ts: Date.now(),
          args: { graph_hash: submittedGraphHash, graph_intent_path: graphIntentPath },
          result: { ok: true, graph_hash: submittedGraphHash },
        });
        // Dense-stereo advisory (2026-06-01) — PRIMARY channel. Dense-gated +
        // empty-suppressed in buildStereoAdvisory (null on sparse/easy rows →
        // fast-on-easy byte-identical). Persist its center worklist to the
        // existing sidecar so the NEXT validate_graph round re-surfaces it
        // (option-C tail, lagged-by-one, free). Skip-closed when null.
        const stereoAdvisory = buildStereoAdvisory(
          graphForBuild,
          captured.translatorOutput?.perceivedUndefinedStereoCenters ?? [],
        );
        if (stereoAdvisory) {
          const priorSidecar = readUnresolvedTargets(outputDir);
          if (priorSidecar) {
            writeUnresolvedTargets(outputDir, {
              ...priorSidecar,
              stereoAdvisoryCenters: stereoAdvisory.centerIntentIds,
            });
          }
        }
        return {
          ok: true,
          data: {
            atomIdMap: captured.translatorOutput?.atomIdMap ?? {},
            bondIdMap: captured.translatorOutput?.bondIdMap ?? {},
            visionFingerprint: captured.translatorOutput?.visionFingerprint ?? null,
            complexity: captured.translatorOutput?.complexity ?? null,
            stereoLossDiagnostics: captured.translatorOutput?.stereoLossDiagnostics ?? [],
            stereoAdvisory,
            // Lever A advisory (coordinate-fidelity): dense wedge centers whose
            // in-plane neighbor pair is near-collinear → re-read the bond
            // directions from a crop. null on sparse/no-findings (fast-on-easy).
            stereoGeometryAdvisory:
              (captured.translatorOutput?.degenerateStereoFindings?.length ?? 0) > 0
                ? captured.translatorOutput?.degenerateStereoFindings
                : null,
            // Fusion-methyl wedge re-check (2026-06-04, A011 atom10 lever).
            // Dense-gated + empty-suppressed → null on sparse/no-findings
            // (fast-on-easy byte-identical). Non-mutating WARNING; flags a
            // hashed-vs-solid methyl-wedge stroke that is easily misread.
            methylWedgeAdvisory: buildMethylWedgeAdvisory(graphForBuild),
            ...mutationResult,
          },
        };
      } catch (err) {
        if (buildError) {
          const failure =
            err instanceof RuntimeMutationError ? err.details : undefined;
          const code = `BUILD_FROM_GRAPH_${(buildError as BuildFromGraphError).code.toUpperCase()}`;
          appendSessionEvent(outputDir, {
            tool: 'build_from_graph',
            rowId,
            ts: Date.now(),
            args: { graph_hash: submittedGraphHash },
            result: { ok: false, error_code: code },
          });
          return {
            ok: false,
            error: {
              code,
              message: scrubAgentText(
                (buildError as BuildFromGraphError).message,
              ),
              details: {
                ...((buildError as BuildFromGraphError).details as object | undefined),
                rollbackAttempted: failure?.rollbackAttempted ?? false,
                rollbackSucceeded: failure?.rollbackSucceeded ?? false,
              },
            },
          };
        }
        appendSessionEvent(outputDir, {
          tool: 'build_from_graph',
          rowId,
          ts: Date.now(),
          args: { graph_hash: submittedGraphHash },
          result: { ok: false, error_code: 'unknown_error' },
        });
        throw err;
      }
    },
  },
];
