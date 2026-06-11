import { describe, it, expect } from 'vitest';
import { toolDefinitions } from '../../src/mcp/server';

const KEEP = new Set([
  'load_smiles', 'load_molfile', 'build_from_graph', 'load_canonical',
  'list_canonical', 'get_state', 'validate_state', 'validate_graph',
  'crop_source_image', 'crop_molecule', 'render_pdf_region', 'render_canvas',
  'export_smiles', 'export_ket', 'export_molfile', 'refuse',
]);

describe('trimmed MCP tool surface', () => {
  const names = new Set(toolDefinitions.map((t) => t.name));

  it('exposes exactly the keep-list (no missing tools)', () => {
    for (const k of KEEP) expect(names.has(k), `missing kept tool: ${k}`).toBe(true);
  });

  it('exposes nothing outside the keep-list (no cut tools leak)', () => {
    for (const n of names) expect(KEEP.has(n), `cut tool still present: ${n}`).toBe(true);
  });
});
