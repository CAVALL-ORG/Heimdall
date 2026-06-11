import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition } from './types';
import {
  appendSessionEvent,
  resolveRowState,
} from './row-state';

const renderCanvasSchema = z
  .object({
    showAtomIds: z.boolean().optional().default(false),
    format: z.enum(['png', 'svg']).optional().default('png'),
    backgroundColor: z.string().optional(),
    rowId: z.string().min(1).optional(),
    outputDir: z.string().min(1).optional(),
    sourceImagePath: z.string().optional(),
  })
  .default({});

export const renderTools: ToolDefinition[] = [
  {
    name: 'render_canvas',
    description:
      'Render the current Ketcher canvas to a PNG (default) or SVG and write it to a temp ' +
      'file. Returns the file path so the agent can Read the image to visually inspect the ' +
      "structure. Pass `showAtomIds: true` to overlay each atom's integer ID — useful when " +
      'picking which atom to edit. Use this whenever a visual check would help (confirming a ' +
      'loaded structure, picking an atom by visual position, verifying a multi-step edit); ' +
      'skip when get_state alone is enough. ' +
      'Example: { "showAtomIds": true, "format": "png" }',
    inputSchema: {
      type: 'object',
      properties: {
        showAtomIds: {
          type: 'boolean',
          description: 'Overlay atom IDs on the rendered image (default false).',
        },
        format: {
          type: 'string',
          enum: ['png', 'svg'],
          description: 'Image format. Default png.',
        },
        backgroundColor: {
          type: 'string',
          description: 'CSS background color for the PNG canvas (e.g. "#ffffff"). PNG only.',
        },
        rowId: { type: 'string' },
        outputDir: { type: 'string' },
        sourceImagePath: { type: 'string' },
      },
      additionalProperties: false,
    },
    inputValidator: renderCanvasSchema,
    run: async (runtime, args) => {
      const parsed = renderCanvasSchema.parse(args ?? {});
      const { outputDir, rowId } = resolveRowState({
        rowId: parsed.rowId,
        outputDir: parsed.outputDir,
        sourceImagePath: parsed.sourceImagePath,
      });
      const base64 = await runtime.callBridge<string>('renderCanvas', parsed);
      const ext = parsed.format === 'svg' ? 'svg' : 'png';
      const fileName = `ketcher-canvas-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`;
      const filePath = path.join(tmpdir(), fileName);
      const buffer = Buffer.from(base64, 'base64');
      await writeFile(filePath, buffer);
      appendSessionEvent(outputDir, {
        tool: 'render_canvas',
        rowId,
        ts: Date.now(),
        args: {
          format: parsed.format,
          showAtomIds: parsed.showAtomIds,
          backgroundColor: parsed.backgroundColor,
        },
        result: {
          ok: true,
          path: filePath,
          format: parsed.format,
          showAtomIds: parsed.showAtomIds,
          bytes: buffer.byteLength,
        },
      });
      return {
        ok: true,
        data: {
          path: filePath,
          format: parsed.format,
          showAtomIds: parsed.showAtomIds,
          bytes: buffer.byteLength,
        },
      };
    },
  },
];
