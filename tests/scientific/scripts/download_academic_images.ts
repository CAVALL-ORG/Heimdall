#!/usr/bin/env tsx
/**
 * Read tests/ketcher/image-to-smiles/image_sources.jsonl and download
 * each fixture into the target_path under images/academic/ or
 * images/wikipedia/ (relative to tests/scientific/).
 *
 * Idempotent — skips files that already exist unless --force is set.
 * Writes a <file>.LICENSE.txt next to each downloaded image with the
 * citation + license line, so the provenance never gets separated
 * from the binary.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const SUITE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT  = path.resolve(SUITE_ROOT, '..', '..');
const SOURCES_FILE = path.join(
  REPO_ROOT, 'tests', 'ketcher', 'image-to-smiles', 'image_sources.jsonl',
);

type Row = {
  id: string;
  category: 'academic' | 'wikipedia' | 'diverse';
  target_path: string;
  source_url: string;
  license: string;
  citation: string;
  expected_canonical_smiles: string;
  notes?: string;
};

async function loadSources(): Promise<Row[]> {
  const text = await fs.readFile(SOURCES_FILE, 'utf8');
  return text.split(/\n/).filter(Boolean).map((line) => JSON.parse(line) as Row);
}

async function fetchOne(row: Row, force: boolean): Promise<'downloaded' | 'cached' | 'failed'> {
  const abs = path.join(SUITE_ROOT, row.target_path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    if (!force) {
      await fs.access(abs);
      return 'cached';
    }
  } catch { /* not present, continue */ }

  const res = await fetch(row.source_url, {
    headers: {
      // Wikimedia Commons requires a UA per their etiquette page.
      'User-Agent': 'heimdall-test-suite/0.1 (https://github.com/CAVALL-ORG/Heimdall)',
    },
  });
  if (!res.ok) {
    console.error(`${row.id}: HTTP ${res.status} from ${row.source_url}`);
    return 'failed';
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(abs, buf);

  // Write the LICENSE sidecar.
  const license = `${row.id}
Source: ${row.source_url}
License: ${row.license}
Citation: ${row.citation}
Expected SMILES: ${row.expected_canonical_smiles}
${row.notes ? `Notes: ${row.notes}\n` : ''}`;
  await fs.writeFile(`${abs}.LICENSE.txt`, license);

  return 'downloaded';
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const onlyCategory = (() => {
    const i = process.argv.indexOf('--category');
    return i >= 0 ? process.argv[i + 1] : null;
  })();

  const rows = await loadSources();
  const filtered = onlyCategory ? rows.filter((r) => r.category === onlyCategory) : rows;

  console.log(`Fetching ${filtered.length} fixtures (force=${force})…`);
  let downloaded = 0;
  let cached = 0;
  let failed = 0;
  for (const row of filtered) {
    const status = await fetchOne(row, force);
    console.log(`  ${status.padEnd(11)} ${row.id}  ${row.target_path}`);
    if (status === 'downloaded') downloaded++;
    else if (status === 'cached') cached++;
    else failed++;
  }
  console.log(`\n${downloaded} downloaded, ${cached} cached, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
