/**
 * T2 — `refuse` MCP tool. Replaces text-token refusal.
 *
 * The agent calls this tool when the current row cannot be transcribed.
 * Backend classifies via `refusal-classifier.ts` over sidecar state +
 * the agent-supplied `pixel_evidence`. Agent does NOT pick the reason
 * class; the classifier owns it.
 *
 * Rejection cases (agent must retry):
 *   - `pixel_evidence` < 20 chars → refusal_lacks_evidence.
 *   - Prior successful export_smiles on row → refusal_after_export.
 *   - Evidence cites no record_id / visual-id / (x, y) anchor → refusal_evidence_unanchored.
 *
 * Acceptance: returns
 *   { accepted: true, classification: <one of 12>, rationale, trace_event_id }.
 *
 * Always logs an entry to `_session_trace.json` so the row's terminal is
 * trackable from trace (verdict.json), independent of free-form prose.
 *
 * Gate: `KETCHER_REFUSE_TOOL` — default ON (flipped in Phase 2c). Opt
 * OUT with `KETCHER_REFUSE_TOOL=0`; when OFF, the tool returns
 * `{ ok: false, error.code: 'refuse_tool_disabled' }` so callers can
 * detect that the env-var opt-out is engaged.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  classifyRefusal,
  type ClassifierVerdict,
} from '../../adapter/refusal-classifier';
import {
  appendSessionEvent,
  resolveRowState,
} from './row-state';
import type { ToolDefinition } from './types';

const REFUSE_TOOL_ENABLED = () => process.env.KETCHER_REFUSE_TOOL !== '0';

const MIN_EVIDENCE_CHARS = 20;

const refuseInputSchema = z.object({
  rowId: z.string().min(1).optional(),
  outputDir: z.string().min(1).optional(),
  // Optional sourceImagePath — when present, server-default resolver
  // hashes it into the default outputDir so refuse lands in the SAME
  // row dir as the row's validate_graph / build_from_graph sidecars
  // (per-row isolation, no cross-row turn-counter leak).
  sourceImagePath: z.string().optional(),
  pixel_evidence: z
    .string()
    .min(MIN_EVIDENCE_CHARS, `pixel_evidence must be at least ${MIN_EVIDENCE_CHARS} characters`),
});

export const refuseTools: ToolDefinition[] = [
  {
    name: 'refuse',
    description:
      'Call when the current row cannot be transcribed. Backend classifies ' +
      'the reason from row state and the supplied pixel_evidence. ' +
      'pixel_evidence must describe a concrete visible feature and cite a ' +
      'record_id, visual-id token (n<int>/s<int>/l<int>), or pixel (x, y) ' +
      'that appears in the most recent validate_graph round. ' +
      'Example: { "rowId": "default", "pixel_evidence": "Vertex n12 at (482, 631) appears to overlap two unrelated rings; cannot determine bond order from visible strokes." }',
    inputSchema: {
      type: 'object',
      properties: {
        rowId: { type: 'string' },
        outputDir: { type: 'string' },
        pixel_evidence: { type: 'string', minLength: MIN_EVIDENCE_CHARS },
      },
      required: ['pixel_evidence'],
      additionalProperties: false,
    },
    inputValidator: refuseInputSchema,
    run: async (_runtime, args) => {
      const parsed = args as z.infer<typeof refuseInputSchema>;

      if (!REFUSE_TOOL_ENABLED()) {
        return {
          ok: false,
          error: {
            code: 'refuse_tool_disabled',
            message:
              'The refuse tool is gated off. Use the existing text-grammar ' +
              'refusal terminal documented in SKILL.md.',
          },
        };
      }

      const { outputDir, rowId } = resolveRowState({
        rowId: parsed.rowId,
        outputDir: parsed.outputDir,
        sourceImagePath: parsed.sourceImagePath,
      });

      const verdict: ClassifierVerdict = classifyRefusal({
        outputDir,
        pixel_evidence: parsed.pixel_evidence,
      });

      appendSessionEvent(outputDir, {
        tool: 'refuse',
        rowId,
        ts: Date.now(),
        args: {
          pixel_evidence_hash: hashEvidence(parsed.pixel_evidence),
          pixel_evidence_length: parsed.pixel_evidence.length,
        },
        result: verdict.accepted
          ? { ok: true, classification: verdict.classification }
          : { ok: false, error_code: verdict.reason },
      });

      if (!verdict.accepted) {
        return {
          ok: false,
          error: {
            code: verdict.reason,
            message: verdict.suggestion,
            details: { suggestion: verdict.suggestion },
          },
        };
      }

      return {
        ok: true,
        data: {
          accepted: true,
          classification: verdict.classification,
          rationale: verdict.rationale,
        },
      };
    },
  },
];

function hashEvidence(s: string): string {
  // Truncated SHA-256 prefix so trace doesn't echo full agent prose.
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}
