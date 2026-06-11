import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findRepoRoot,
  runWithConcurrency,
  scriptDirname,
  taskPaths,
  writeManifest,
} from '../../src/batch';

const tmpdirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpdirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpdirs.length) {
    const d = tmpdirs.pop()!;
    await fs.rm(d, { recursive: true, force: true });
  }
});

describe('runWithConcurrency', () => {
  it('preserves input order in output', async () => {
    const out = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (x) => x * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('honors the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await runWithConcurrency([1, 2, 3, 4, 5, 6], 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(20);
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('handles an empty input list', async () => {
    const out = await runWithConcurrency<number, number>([], 3, async (x) => x);
    expect(out).toEqual([]);
  });

  it('passes the index to fn', async () => {
    const out = await runWithConcurrency(['a', 'b', 'c'], 2, async (x, i) => `${i}:${x}`);
    expect(out).toEqual(['0:a', '1:b', '2:c']);
  });
});

describe('scriptDirname', () => {
  it('returns the dirname of an import.meta.url', () => {
    const url = 'file:///tmp/foo/bar/script.ts';
    expect(scriptDirname(url)).toBe('/tmp/foo/bar');
  });
});

describe('findRepoRoot', () => {
  it('locates a repo root marked by .git directory', async () => {
    const root = await makeTmp('rtk-root-');
    await fs.mkdir(path.join(root, '.git'));
    const deep = path.join(root, 'a', 'b', 'c');
    await fs.mkdir(deep, { recursive: true });
    expect(findRepoRoot(deep)).toBe(root);
  });

  it('locates a repo root marked by CLAUDE.md', async () => {
    const root = await makeTmp('rtk-root-');
    await fs.writeFile(path.join(root, 'CLAUDE.md'), '# root\n');
    const deep = path.join(root, 'pkg', 'src');
    await fs.mkdir(deep, { recursive: true });
    expect(findRepoRoot(deep)).toBe(root);
  });

  it('throws when no marker is found', async () => {
    const dir = await makeTmp('rtk-noroot-');
    expect(() => findRepoRoot(dir)).toThrow(/repo root/);
  });
});

describe('taskPaths', () => {
  it('builds the expected outputs/<slug>/ layout', () => {
    const paths = taskPaths('example-batch', '/repo');
    expect(paths.root).toBe('/repo/outputs/example-batch');
    expect(paths.data).toBe('/repo/outputs/example-batch/data');
    expect(paths.images).toBe('/repo/outputs/example-batch/images');
    expect(paths.tex).toBe('/repo/outputs/example-batch/tex');
    expect(paths.inputs).toBe('/repo/outputs/example-batch/inputs');
    expect(paths.driver).toBe('/repo/outputs/example-batch/example-batch.ts');
  });
});

describe('writeManifest', () => {
  it('writes README.md with frontmatter sections', async () => {
    const root = await makeTmp('rtk-manifest-');
    const out = await writeManifest(
      'demo',
      {
        date: '2026-05-15',
        operation: 'chem-transform',
        prompt: 'Test prompt',
        deliverable: '- `demo.pdf`',
        notes: 'Watch the units.',
      },
      root,
    );
    expect(out).toBe(path.join(root, 'outputs', 'demo', 'README.md'));
    const body = await fs.readFile(out, 'utf8');
    expect(body).toContain('# demo');
    expect(body).toContain('**Date:** 2026-05-15');
    expect(body).toContain('**Operation:** chem-transform');
    expect(body).toContain('## Prompt');
    expect(body).toContain('Test prompt');
    expect(body).toContain('## Deliverable');
    expect(body).toContain('## Notes');
    expect(body).toContain('Watch the units.');
  });

  it('skips the Notes section when notes is omitted', async () => {
    const root = await makeTmp('rtk-manifest-');
    const out = await writeManifest(
      'demo2',
      {
        date: '2026-05-15',
        operation: 'ketcher-ingest',
        prompt: 'p',
        deliverable: 'd',
      },
      root,
    );
    const body = await fs.readFile(out, 'utf8');
    expect(body).not.toContain('## Notes');
  });
});
