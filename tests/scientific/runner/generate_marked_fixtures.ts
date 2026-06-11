/**
 * Layout-cleaned (marked) fixture generator. Sibling of
 * generate_hires_fixtures.ts. Operator-driven; not part of CI.
 *
 * Generates an A009H_marked-style fixture by FIRST re-laying out the
 * molecule via Indigo's /v2/indigo/layout endpoint (fresh 2D
 * coordinates) and THEN rendering the resulting molfile via
 * /v2/indigo/render. The layout pass aims to eliminate the visual
 * ring-stroke crossings present in the direct-from-SMILES render
 * (e.g. the bisindole cage of vinblastine in A009H_hires.png), so
 * the protocol can be tested on the same molecule when the pixel
 * cues are unambiguous.
 *
 * Output path: tests/scientific/images/academic-hires/<id>H_marked.png
 * (NOT replacing <id>H_hires.png).
 *
 * Usage:
 *   npx tsx tests/scientific/runner/generate_marked_fixtures.ts A009
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INDIGO_BASE = 'http://127.0.0.1:8002/v2/indigo';
const INDIGO_LAYOUT_URL = `${INDIGO_BASE}/layout`;
const INDIGO_RENDER_URL = `${INDIGO_BASE}/render`;
const REPO_ROOT = process.cwd();
const MANIFEST_PATH = join(
  REPO_ROOT,
  'tests/ketcher/image-to-smiles/manifest.jsonl',
);
const OUT_DIR = join(REPO_ROOT, 'tests/scientific/images/academic-hires');

interface ManifestRow {
  id: string;
  expected_canonical_smiles: string;
  image_path?: string;
  notes?: string;
}

function loadRow(id: string): ManifestRow {
  const text = readFileSync(MANIFEST_PATH, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as ManifestRow;
    if (row.id === id) return row;
  }
  throw new Error(`row ${id} not in manifest`);
}

async function layoutSmiles(smiles: string): Promise<string> {
  const body = {
    struct: smiles,
    output_format: 'chemical/x-mdl-molfile',
  };
  const resp = await fetch(INDIGO_LAYOUT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Indigo layout failed: HTTP ${resp.status}`);
  }
  const payload = (await resp.json()) as { struct: string };
  if (!payload.struct) {
    throw new Error('Indigo layout returned no struct');
  }
  return payload.struct;
}

async function renderMolfile(molfile: string): Promise<Buffer> {
  const body = {
    struct: molfile,
    output_format: 'image/png',
    options: {
      'render-image-width': 4000,
      'render-image-height': 3000,
    },
  };
  const resp = await fetch(INDIGO_RENDER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Indigo render failed: HTTP ${resp.status}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

async function generateOne(id: string): Promise<void> {
  const row = loadRow(id);
  const smiles = row.expected_canonical_smiles;

  console.log(`[${id}] requesting layout from ${INDIGO_LAYOUT_URL}`);
  const molfile = await layoutSmiles(smiles);
  console.log(
    `[${id}] layout OK (${molfile.length} bytes molfile)`,
  );

  console.log(`[${id}] requesting render from ${INDIGO_RENDER_URL}`);
  const png = await renderMolfile(molfile);
  console.log(`[${id}] render OK (${png.length} bytes png)`);

  const pngPath = join(OUT_DIR, `${id}H_marked.png`);
  const licPath = `${pngPath}.LICENSE.txt`;
  const molfilePath = `${pngPath}.molfile.txt`;
  writeFileSync(pngPath, png);
  writeFileSync(molfilePath, molfile);
  writeFileSync(
    licPath,
    [
      `${id}H_marked`,
      'Source: synthesized via Indigo two-pass layout→render of manifest expected_canonical_smiles',
      `Indigo layout endpoint: ${INDIGO_LAYOUT_URL}`,
      `Indigo render endpoint: ${INDIGO_RENDER_URL}`,
      'Render dims: 4000x3000',
      `Source SMILES: ${smiles}`,
      'Variant: layout-cleaned (fresh 2D coords via /v2/indigo/layout) before rasterizing.',
      'License: derived asset — Indigo render of canonical SMILES; no third-party copyright.',
      `Original fixture: tests/scientific/${row.image_path} (paired control).`,
      `Sibling hi-res fixture: ${id}H_hires.png (same SMILES, different layout pass).`,
      `Notes: ${row.notes ?? '(none)'}`,
      '',
    ].join('\n'),
  );
  console.log(`wrote ${pngPath} (${png.length} bytes)`);
  console.log(`wrote ${molfilePath} (${molfile.length} bytes)`);
  console.log(`wrote ${licPath}`);
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error(
      'usage: npx tsx tests/scientific/runner/generate_marked_fixtures.ts <ID> [<ID>...]',
    );
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  for (const id of ids) {
    await generateOne(id);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
