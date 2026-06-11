import { z } from 'zod';
import type { KetcherRuntime } from '../runtime';

export type ToolExecutionResult = {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  // Plan 2 Task 4 — non-fatal advisory appended to export results when the
  // server runs standalone (no Indigo backend). Additive: never alters data.
  advisory?: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, object>;
    required?: string[];
    additionalProperties?: boolean;
    anyOf?: Array<Record<string, unknown>>;
  };
  inputValidator: z.ZodTypeAny;
  run: (runtime: KetcherRuntime, args: unknown) => Promise<ToolExecutionResult>;
};

export function toMcpTextResult(result: ToolExecutionResult) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
