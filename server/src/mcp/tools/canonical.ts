import { z } from 'zod';
import type { ToolDefinition } from './types';
import {
  CANONICAL_LIBRARY,
  listCanonicalNames,
  resolveCanonical,
} from '../../data/canonical-library';

const loadCanonicalSchema = z.object({
  name: z.string().min(1),
});

const listCanonicalSchema = z.object({}).default({});

export const canonicalTools: ToolDefinition[] = [
  {
    name: 'load_canonical',
    description:
      'Load a named molecule from the curated canonical-SMILES library into Ketcher. Use ONLY ' +
      'when the molecule is unambiguously identifiable by name (e.g. "paclitaxel", "morphine", ' +
      '"cholesterol", "atp") AND building it via primitives would exceed the turn budget. The ' +
      'library is reviewed code, so this path preserves the rule that the agent never authors ' +
      'SMILES. Call list_canonical first if unsure which names are available. Errors include the ' +
      'available name list. ' +
      'Example: { "name": "paclitaxel" }',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
      },
      required: ['name'],
      additionalProperties: false,
    },
    inputValidator: loadCanonicalSchema,
    run: async (runtime, args) => {
      const parsed = loadCanonicalSchema.parse(args);
      const resolved = resolveCanonical(parsed.name);
      if (!resolved) {
        return {
          ok: false,
          error: {
            code: 'CANONICAL_NOT_FOUND',
            message: `No canonical entry for "${parsed.name}". Call list_canonical to see available names.`,
            details: {
              requested: parsed.name,
              available: listCanonicalNames(),
            },
          },
        };
      }
      const result = await runtime.applyMutation(
        'load_canonical',
        { name: resolved.key },
        async () => {
          await runtime.callBridge('loadSmiles', resolved.entry.smiles);
        },
      );
      return {
        ok: true,
        data: {
          ...result,
          canonical_key: resolved.key,
          source: resolved.entry.source ?? null,
          notes: resolved.entry.notes ?? null,
        },
      };
    },
  },
  {
    name: 'list_canonical',
    description:
      'List every registered name in the canonical-SMILES library, with aliases, source, and ' +
      'notes. Call this before load_canonical if unsure whether a molecule is available. The ' +
      'underlying SMILES strings are intentionally NOT returned — the agent must load via ' +
      'load_canonical and rely on export_smiles for the canonical form. ' +
      'Example: {}',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
    },
    inputValidator: listCanonicalSchema,
    run: async () => {
      const names = listCanonicalNames();
      const entries = names.map((key) => {
        const entry = CANONICAL_LIBRARY[key];
        return {
          key,
          aliases: entry.aliases ?? [],
          source: entry.source ?? null,
          notes: entry.notes ?? null,
        };
      });
      return { ok: true, data: { entries } };
    },
  },
];
