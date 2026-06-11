import { z } from 'zod';
import type { ToolDefinition } from './types';

const emptySchema = z.object({}).default({});

export const verifyTools: ToolDefinition[] = [
  {
    name: 'validate_state',
    description:
      'Run Indigo structural checks against the current structure. ' +
      'Example: {}',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
    },
    inputValidator: emptySchema,
    run: async (runtime) => {
      const checks = await runtime.callBridge('validateState');
      return { ok: true, data: checks };
    },
  },
];
