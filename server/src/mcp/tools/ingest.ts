import { z } from 'zod';
import type { ToolDefinition } from './types';

const loadSmilesSchema = z.object({
  smiles: z.string().min(1),
});

const loadMolfileSchema = z.object({
  molfile: z.string().min(1),
});

const getStateSchema = z.object({
  includeMolfile: z.boolean().optional().default(false),
});

export const ingestTools: ToolDefinition[] = [
  {
    name: 'load_smiles',
    description:
      'Load SMILES into Ketcher and return normalized state artifacts. ' +
      'Example: { "smiles": "CCO" }',
    inputSchema: {
      type: 'object',
      properties: {
        smiles: { type: 'string', minLength: 1 },
      },
      required: ['smiles'],
      additionalProperties: false,
    },
    inputValidator: loadSmilesSchema,
    run: async (runtime, args) => {
      const parsed = loadSmilesSchema.parse(args);
      const result = await runtime.applyMutation('load_smiles', parsed, async () => {
        await runtime.callBridge('loadSmiles', parsed.smiles);
      });
      return { ok: true, data: result };
    },
  },
  {
    name: 'load_molfile',
    description:
      'Load a V2000 or V3000 molfile string into Ketcher. Symmetric to export_molfile — use for ' +
      'round-tripping molecules through the most portable structure format. ' +
      'Example: { "molfile": "\\n  Mrv2014\\n\\n  0  0  0  0  0  0            999 V2000\\nM  END\\n" }',
    inputSchema: {
      type: 'object',
      properties: {
        molfile: { type: 'string', minLength: 1 },
      },
      required: ['molfile'],
      additionalProperties: false,
    },
    inputValidator: loadMolfileSchema,
    run: async (runtime, args) => {
      const parsed = loadMolfileSchema.parse(args);
      const result = await runtime.applyMutation('load_molfile', parsed, async () => {
        await runtime.callBridge('loadMolfile', parsed.molfile);
      });
      return { ok: true, data: result };
    },
  },
  {
    name: 'get_state',
    description:
      'Return the current state artifacts and atom/bond ID tables. ' +
      'Example: {}',
    inputSchema: {
      type: 'object',
      properties: {
        includeMolfile: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    inputValidator: getStateSchema,
    run: async (runtime, args) => {
      const parsed = getStateSchema.parse(args ?? {});
      const state =
        (await runtime.getPublicState?.(parsed.includeMolfile)) ??
        (await runtime.getState(parsed.includeMolfile));
      return { ok: true, data: state };
    },
  },
];
