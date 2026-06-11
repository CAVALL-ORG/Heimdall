import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import type { KetcherRuntime } from '../mcp/runtime';

const REPO_MARKERS: Array<{ name: string; kind: 'file' | 'dir' }> = [
  { name: '.git', kind: 'dir' },
  { name: 'CLAUDE.md', kind: 'file' },
];

export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
      while (true) {
        const k = i++;
        if (k >= items.length) return;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

export function scriptDirname(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

export function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  while (true) {
    for (const marker of REPO_MARKERS) {
      try {
        const stat = statSync(path.join(dir, marker.name));
        if (marker.kind === 'dir' ? stat.isDirectory() : stat.isFile()) return dir;
      } catch {
        continue;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find repo root above ${startDir}`);
    }
    dir = parent;
  }
}

export interface TaskPaths {
  root: string;
  data: string;
  images: string;
  tex: string;
  inputs: string;
  driver: string;
}

export function taskPaths(slug: string, repoRoot?: string): TaskPaths {
  const root = repoRoot
    ? path.join(repoRoot, 'outputs', slug)
    : path.join(findRepoRoot(process.cwd()), 'outputs', slug);
  return {
    root,
    data: path.join(root, 'data'),
    images: path.join(root, 'images'),
    tex: path.join(root, 'tex'),
    inputs: path.join(root, 'inputs'),
    driver: path.join(root, `${slug}.ts`),
  };
}

export interface ManifestBody {
  date: string;
  operation: string;
  prompt: string;
  deliverable: string;
  notes?: string;
}

export async function writeManifest(
  slug: string,
  body: ManifestBody,
  repoRoot?: string,
): Promise<string> {
  const paths = taskPaths(slug, repoRoot);
  await fs.mkdir(paths.root, { recursive: true });
  const lines = [
    `# ${slug}`,
    '',
    `**Date:** ${body.date}`,
    `**Operation:** ${body.operation}`,
    '',
    '## Prompt',
    body.prompt,
    '',
    '## Deliverable',
    body.deliverable,
  ];
  if (body.notes) {
    lines.push('', '## Notes', body.notes);
  }
  lines.push('');
  const out = path.join(paths.root, 'README.md');
  await fs.writeFile(out, lines.join('\n'), 'utf8');
  return out;
}

export async function snapshotRoundtrip<T>(
  runtime: KetcherRuntime,
  body: () => Promise<T>,
): Promise<T> {
  const ket = await runtime.exportKet();
  if (!ket) {
    throw new Error('snapshotRoundtrip: exportKet returned null — canvas empty or export failed');
  }
  try {
    return await body();
  } finally {
    await runtime.callBridge('resetToSnapshot', ket);
  }
}
