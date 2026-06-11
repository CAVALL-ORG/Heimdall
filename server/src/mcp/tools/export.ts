import { z } from 'zod';
import type { ToolDefinition } from './types';
import {
  appendSessionEvent,
  resolveRowState,
} from './row-state';

const emptySchema = z.object({}).default({});

const exportSmilesSchema = z
  .object({
    canonical: z.boolean().optional().default(false),
    rowId: z.string().min(1).optional(),
    outputDir: z.string().min(1).optional(),
    sourceImagePath: z.string().optional(),
  })
  .default({ canonical: false });

export const exportTools: ToolDefinition[] = [
  {
    name: 'export_smiles',
    description:
      'Export current structure as SMILES string. Pass `canonical: true` to route through ' +
      'Indigo\'s canonical-SMILES mode for a deterministic traversal (useful when comparing ' +
      'output to a known reference). Note: Indigo canonical ≠ RDKit canonical — strings will ' +
      'still differ across toolkits for the same molecule. ' +
      'Example: { "canonical": false }',
    inputSchema: {
      type: 'object',
      properties: {
        canonical: {
          type: 'boolean',
          description: 'When true, return Indigo-canonical SMILES instead of the canvas-traversal SMILES.',
        },
        rowId: { type: 'string' },
        outputDir: { type: 'string' },
        sourceImagePath: { type: 'string' },
      },
      additionalProperties: false,
    },
    inputValidator: exportSmilesSchema,
    run: async (runtime, args) => {
      const parsed = exportSmilesSchema.parse(args ?? {});
      const { outputDir, rowId } = resolveRowState({
        rowId: parsed.rowId,
        outputDir: parsed.outputDir,
        sourceImagePath: parsed.sourceImagePath,
      });
      const smiles = parsed.canonical
        ? await runtime.callBridge<string>('exportCanonicalSmiles')
        : await runtime.exportSmiles();
      appendSessionEvent(outputDir, {
        tool: 'export_smiles',
        rowId,
        ts: Date.now(),
        args: { canonical: parsed.canonical },
        result: { ok: true, smiles, canonical: parsed.canonical },
      });
      return {
        ok: true,
        data: {
          smiles,
          canonical: parsed.canonical,
        },
      };
    },
  },
  {
    name: 'export_ket',
    description:
      'Export current structure as KET string. ' +
      'Example: {}',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
    },
    inputValidator: emptySchema,
    run: async (runtime) => {
      const ket = await runtime.exportPublicKet();
      return { ok: true, data: { ket } };
    },
  },
  {
    name: 'export_molfile',
    description:
      'Export current structure as MDL Molfile string. ' +
      'Example: {}',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
    },
    inputValidator: emptySchema,
    run: async (runtime) => {
      const molfile = await runtime.exportPublicMolfile();
      return { ok: true, data: { molfile } };
    },
  },
];
