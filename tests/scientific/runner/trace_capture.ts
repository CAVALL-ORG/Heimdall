#!/usr/bin/env tsx
/**
 * Parse the stream-json transcript that `claude -p` emits and
 * extract the trace events the grader checks. Writes one JSON file
 * per test under results/<run_id>/<id>.trace.json.
 *
 * Each line of the transcript is a JSON object with one of these
 * shapes (see Claude Code's --output-format=stream-json docs):
 *   {"type": "system", ...}
 *   {"type": "assistant", "message": { "content": [...] }}
 *   {"type": "user", "message": { "content": [...] }}   ← tool results live here
 * Tool use blocks look like:
 *   {"type": "tool_use", "name": "mcp__heimdall__load_smiles", ...}
 * Tool result blocks look like:
 *   {"type": "tool_result", "content": [...]}
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type TraceEvent = {
  raw_tool: string;
  label: string;
  ts_index: number;
  args?: unknown;
  tool_use_id?: string;
  result?: unknown;
  path?: string;
};

// Maps concrete tool names → normalized trace-event labels the grader
// understands. Multiple aliases are supported so legacy required_trace_events
// lists from v1 keep working.
const TOOL_TO_LABEL: Record<string, string[]> = {
  // mcp__heimdall__* prefix is stripped before lookup.
  'load_smiles':                       ['load_smiles', 'setMolecule', 'load_or_construct_in_ketcher', 'set_recognized_structure'],
  'load_molfile':                      ['load_molfile', 'setMolecule', 'load_or_construct_in_ketcher'],
  'clear_canvas':                      ['clear_canvas', 'setMolecule_replaces_canvas'],
  'add_fragment':                      ['add_fragment', 'addFragment', 'load_or_construct_in_ketcher'],
  'build_from_graph':                  ['build_from_graph', 'buildFromGraph', 'load_or_construct_in_ketcher'],
  'set_atom_element':                  ['set_atom_element', 'edit_in_ketcher'],
  'set_atom_charge':                   ['set_atom_charge', 'set_formal_charge', 'edit_in_ketcher'],
  'set_atom_radical':                  ['set_atom_radical', 'set_radical', 'edit_in_ketcher'],
  'set_atom_implicit_h_count':         ['set_atom_implicit_h_count', 'delete_hydrogen', 'set_implicit_or_explicit_hydrogens', 'edit_in_ketcher'],
  'set_atom_explicit_valence':         ['set_atom_explicit_valence', 'edit_in_ketcher'],
  'add_atom_with_single_bond':         ['add_atom_with_single_bond', 'add_atom', 'add_bond', 'edit_in_ketcher'],
  'add_bond':                          ['add_bond', 'edit_in_ketcher'],
  'delete_atom':                       ['delete_atom', 'edit_in_ketcher'],
  'delete_bond':                       ['delete_bond', 'edit_in_ketcher'],
  'set_bond_order':                    ['set_bond_order', 'change_bond_order', 'edit_in_ketcher'],
  'set_bond_stereo':                   ['set_bond_stereo', 'set_double_bond_stereo', 'set_wedge_dash_or_chiral_flag', 'edit_in_ketcher'],
  'clean':                             ['clean', 'check_or_clean'],
  'aromatize':                         ['aromatize', 'check_or_clean'],
  'dearomatize':                       ['dearomatize', 'check_or_clean'],
  'validate_state':                    ['validate_state', 'check_or_clean'],
  'construct_reaction':                ['construct_reaction', 'construct_reaction_in_ketcher', 'reaction_arrow', 'add_reactants_products'],
  'export_rxn':                        ['export_rxn', 'getRxn', 'export_products'],
  'export_reaction_smiles':            ['export_reaction_smiles', 'export_products'],
  'export_smiles':                     ['export_smiles', 'getSmiles', 'getSmiles_isomeric', 'export_from_ketcher', 'getSmiles_or_product_export'],
  'export_molfile':                    ['export_molfile', 'getMolfile'],
  'export_ket':                        ['export_ket', 'getKet'],
  'render_canvas':                     ['render_canvas'],
  'get_state':                         ['get_state', 'inspect_canvas'],
  'get_annotated_state':               ['get_annotated_state', 'inspect_canvas'],
  'diff_state':                        ['diff_state'],
  'list_recent_events':                ['list_recent_events'],
  // Image-rebuild v3 protocol surfaces (Phase 4 trace plumbing).
  'validate_graph':                    ['validate_graph'],
  'crop_source_image':                 ['crop_source_image'],
  'refuse':                            ['refuse'],
};

function stripMcpPrefix(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '').replace(/^mcp__heimdall__/, '');
}

function camelToSnake(s: string): string {
  return s.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}

// Direct KetcherRuntime methods (not routed through callBridge) that map
// to MCP tools by camelCase ↔ snake_case correspondence. The runtime
// exposes these in src/mcp/runtime.ts.
const DIRECT_RUNTIME_METHODS = new Set([
  'exportSmiles',
  'exportKet',
  'exportMolfile',
  'getState',
  'getAnnotatedState',
  'listRecentEvents',
  'validateState',
]);

// Extract bridge-method names from a Bash command string. Recognizes both
// `callBridge('loadSmiles', …)` / `applyMutation('loadSmiles', …)` and
// direct `runtime.exportSmiles()` / `rt.getAnnotatedState()` calls. Returns
// the snake_case tool names that should be credited.
function bridgeCallsInBashCommand(command: string): string[] {
  const out: string[] = [];
  const bridgeRe = /\b(?:callBridge|applyMutation)\(\s*['"]([A-Za-z]\w*)['"]/g;
  for (let m: RegExpExecArray | null; (m = bridgeRe.exec(command)); ) {
    out.push(camelToSnake(m[1]));
  }
  const directRe = /\b\w+\.([A-Za-z]\w*)\s*\(/g;
  for (let m: RegExpExecArray | null; (m = directRe.exec(command)); ) {
    if (DIRECT_RUNTIME_METHODS.has(m[1])) out.push(camelToSnake(m[1]));
  }
  return out;
}

function parseArgs(): { transcript: string; out: string } {
  const argv = process.argv.slice(2);
  let transcript = '';
  let out = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--transcript') transcript = argv[++i];
    else if (argv[i] === '--out') out = argv[++i];
  }
  if (!transcript || !out) {
    console.error('Usage: trace_capture --transcript <path> --out <path>');
    process.exit(2);
  }
  return { transcript, out };
}

type AssistantContent = {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
};

export type TraceCaptureResult = {
  transcript_path: string;
  events: TraceEvent[];
  final_assistant_text: string;
  final_assistant_text_blocks: string[];
  assistant_message_blocks: string[];
  num_assistant_messages: number;
};

// dense-evidence.json sidecar payload loader deleted 2026-05-26 — the
// sidecar is no longer authority surface; grader gates parse the
// agent's final message directly (LOCK 3 / LOCK 21 / etc.).

function parseToolResultText(content: unknown): unknown {
  // tool_result.content is typically [{ type: 'text', text: '<json>' }, ...].
  // The MCP server JSON-stringifies its result payload into the text block.
  if (!Array.isArray(content)) return undefined;
  for (const piece of content) {
    if (
      piece &&
      typeof piece === 'object' &&
      (piece as { type?: string }).type === 'text' &&
      typeof (piece as { text?: string }).text === 'string'
    ) {
      const text = (piece as { text: string }).text;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return undefined;
}

export function captureTraceFromTranscriptText(
  transcriptText: string,
  transcriptPath = '',
): TraceCaptureResult {
  const lines = transcriptText.split(/\n/).filter(Boolean);
  const events: TraceEvent[] = [];
  let lastWasRender = false;
  let lastWasReadAfterRender = false;
  let assistantMessages: string[] = [];
  let finalAssistantMessageBlocks: string[] = [];
  // tool_use_id → event indices (one tool_use can emit multiple aliased events).
  const eventsByToolUseId = new Map<string, number[]>();

  let idx = 0;
  for (const line of lines) {
    let obj: { type?: string; message?: { content?: AssistantContent[] } } | null = null;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || !obj.message?.content) continue;

    const assistantTextBlocksForMessage: string[] = [];

    for (const block of obj.message.content) {
      if (block.type === 'tool_use' && block.name) {
        const tool = stripMcpPrefix(block.name);
        const labels = TOOL_TO_LABEL[tool];
        const toolUseId = typeof block.id === 'string' ? block.id : undefined;
        if (labels) {
          const startIdx = events.length;
          for (const label of labels) {
            events.push({
              raw_tool: tool,
              label,
              ts_index: idx,
              args: block.input,
              ...(toolUseId ? { tool_use_id: toolUseId } : {}),
            });
          }
          if (toolUseId) {
            const indices: number[] = [];
            for (let k = startIdx; k < events.length; k++) indices.push(k);
            eventsByToolUseId.set(toolUseId, indices);
          }
        }
        // Script transport: KetcherRuntime / callBridge / direct runtime
        // method calls exercise the same primitives as the MCP tools, so
        // credit them as the corresponding tool events. The script body
        // can appear either inline in a Bash heredoc command or as the
        // content of a Write / Edit on a `.ts` file. We scan all three.
        const scanForBridge = (text: string): void => {
          if (!text) return;
          if (!text.includes('KetcherRuntime') &&
              !/\b(callBridge|applyMutation)\(/.test(text) &&
              !/\b\w+\.exportSmiles\s*\(/.test(text)) return;
          for (const bridgeTool of bridgeCallsInBashCommand(text)) {
            const bridgeLabels = TOOL_TO_LABEL[bridgeTool];
            if (bridgeLabels) {
              for (const label of bridgeLabels) {
                events.push({ raw_tool: `script:${bridgeTool}`, label, ts_index: idx });
              }
            }
          }
        };
        if (tool === 'Bash' && block.input && typeof block.input === 'object') {
          scanForBridge((block.input as { command?: string }).command ?? '');
        }
        if ((tool === 'Write' || tool === 'Edit') && block.input && typeof block.input === 'object') {
          const inp = block.input as { content?: string; new_string?: string; file_path?: string };
          if (inp.file_path && /\.(ts|tsx|mjs|js)$/.test(inp.file_path)) {
            scanForBridge(inp.content ?? inp.new_string ?? '');
          }
        }
        // Heuristics: Read on an image immediately followed by a SMILES
        // mention in the next assistant turn → vision_identify_structure.
        // Render → Read → assistant text → consistency_verified / mismatch.
        if (tool === 'render_canvas') {
          lastWasRender = true;
        } else if (tool === 'Read' && lastWasRender) {
          lastWasReadAfterRender = true;
          lastWasRender = false;
        }
        if (tool === 'Read' && block.input && typeof block.input === 'object' &&
            typeof (block.input as { file_path?: string }).file_path === 'string' &&
            /\.(png|jpe?g|svg)$/i.test((block.input as { file_path: string }).file_path)) {
          const path = (block.input as { file_path: string }).file_path;
          // image-rebuild v3 phase 5: emit a literal `Read` label alongside
          // `vision_identify_structure` so transcript_image_input_gate (which
          // looks for `Read`/`read` to gate first build) and
          // image_freshness_gate (which reads `e.get("path")`) see the
          // image-Read event without each gate needing its own label dialect.
          events.push({ raw_tool: 'Read', label: 'Read', path, ts_index: idx });
          events.push({ raw_tool: 'Read', label: 'vision_identify_structure', path, ts_index: idx });
        }
      } else if (block.type === 'tool_result') {
        // tool_result blocks live in user-role messages (transcript role).
        // Pair the result back to the originating tool_use events so the
        // grader (refusal_evidence_gate, ...) can read
        // the backend's structured response off the event.
        const tuid = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
        if (tuid && eventsByToolUseId.has(tuid)) {
          const parsed = parseToolResultText(block.content);
          if (parsed !== undefined) {
            for (const i of eventsByToolUseId.get(tuid) ?? []) {
              if (events[i]) events[i].result = parsed;
            }
          }
        }
      } else if (block.type === 'text' && typeof block.text === 'string') {
        if (obj.type === 'assistant') {
          assistantTextBlocksForMessage.push(block.text);
        }
        // Sentinel-graded vision check on assistant text. The image-rebuild
        // SKILL contract requires exactly one of `VISION_OK` / `VISION_MISMATCH: <reason>`
        // on its own line after the post-build readback. Fuzzy language no
        // longer credits — the regex above (matches|consistent|verified|…)
        // was too lenient and let agents skip a real readback.
        if (lastWasReadAfterRender) {
          // Accept both legacy bare-line sentinels (`VISION_OK` /
          // `VISION_MISMATCH: …`) and the W3 fenced-block form
          // (`VERDICT: VISION_OK` / `VERDICT: VISION_MISMATCH: …`).
          if (/^(?:VISION_MISMATCH:|VERDICT:\s*VISION_MISMATCH:)\s*/m.test(block.text)) {
            events.push({ raw_tool: 'host', label: 'vision_consistency_mismatch', ts_index: idx });
          } else if (/^(?:VISION_OK\s*$|VERDICT:\s*VISION_OK\s*$)/m.test(block.text)) {
            events.push({ raw_tool: 'host', label: 'vision_consistency_verified', ts_index: idx });
          }
          lastWasReadAfterRender = false;
        }
      }
      idx++;
    }
    if (obj.type === 'assistant' && assistantTextBlocksForMessage.length > 0) {
      assistantMessages.push(assistantTextBlocksForMessage.join('\n\n'));
      finalAssistantMessageBlocks = assistantTextBlocksForMessage;
    }
  }

  // Refusal heuristic — final assistant text + no export_smiles in trace.
  const finalText = assistantMessages.slice(-1)[0] ?? '';
  const hadExport = events.some((e) => e.label === 'export_smiles' || e.label === 'getSmiles');
  if (!hadExport && /recognition failed|not a chemical structure|cannot recognize|no valid molecule/i.test(finalText)) {
    events.push({ raw_tool: 'host', label: 'handle_recognition_failure_without_invention', ts_index: idx });
  }

  // Vision-consistency heuristic for script transport. The MCP-Read path
  // already credits this when Read-of-rendered-PNG is followed by
  // "matches" text. Script transport often renders to base64 inside the
  // script — no separate Read event — but the agent still asserts the
  // round-trip in its final reply. Credit that here when a render_canvas
  // event is present and the final text asserts a match. Mismatch wins
  // over match if both keywords appear (rare but possible).
  const hadRender = events.some((e) => e.label === 'render_canvas');
  const hasVerified = events.some((e) => e.label === 'vision_consistency_verified');
  const hasMismatch = events.some((e) => e.label === 'vision_consistency_mismatch');
  if (hadRender && !hasVerified && !hasMismatch && finalText) {
    // Mirror the MCP-Read-path matcher: legacy bare-line sentinel OR W3
    // fenced `VERDICT: VISION_OK` / `VERDICT: VISION_MISMATCH: …`.
    if (/^(?:VISION_MISMATCH:|VERDICT:\s*VISION_MISMATCH:)\s*/m.test(finalText)) {
      events.push({ raw_tool: 'host', label: 'vision_consistency_mismatch', ts_index: idx });
    } else if (/^(?:VISION_OK\s*$|VERDICT:\s*VISION_OK\s*$)/m.test(finalText)) {
      events.push({ raw_tool: 'host', label: 'vision_consistency_verified', ts_index: idx });
    }
  }

  // Iteration evidence: if the trace shows multiple load_smiles attempts
  // for the same image task, the agent self-corrected. Credit a
  // vision_consistency_mismatch event for the iteration even if the
  // agent forgot to declare it in text — the load_smiles count IS the
  // declaration. The S13-roundtrip tests explicitly require this. The
  // mismatch is inserted before any verified event so grader ordering
  // (mismatch → verified) is preserved.
  // Count distinct load_smiles invocations (each MCP/script call emits
  // multiple aliased events; we count by label === 'load_smiles' only).
  const loadAttempts = events.filter((e) => e.label === 'load_smiles').length;
  if (loadAttempts >= 2 && !events.some((e) => e.label === 'vision_consistency_mismatch')) {
    const verifiedIdx = events.findIndex((e) => e.label === 'vision_consistency_verified');
    const insertAt = verifiedIdx >= 0 ? verifiedIdx : events.length;
    events.splice(insertAt, 0, {
      raw_tool: 'host',
      label: 'vision_consistency_mismatch',
      ts_index: insertAt > 0 ? events[insertAt - 1].ts_index : 0,
    });
  }

  return {
    transcript_path: transcriptPath,
    events,
    final_assistant_text: finalText,
    final_assistant_text_blocks: finalAssistantMessageBlocks,
    // Every assistant message's joined text, in arrival order. Used by
    // filename_inference_gate to scan pre-build prose (not just the final
    // assistant message). The richer field; final_assistant_text /
    // final_assistant_text_blocks remain available as fallbacks.
    assistant_message_blocks: assistantMessages.slice(),
    num_assistant_messages: assistantMessages.length,
  };
}

async function main(): Promise<void> {
  const { transcript, out } = parseArgs();
  const transcriptText = await fs.readFile(transcript, 'utf8');
  const result = captureTraceFromTranscriptText(transcriptText, transcript);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
