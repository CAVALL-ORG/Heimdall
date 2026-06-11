import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BUNDLE = resolve(__dirname, '../../dist/mcp/server.mjs');

describe('built server bundle', () => {
  beforeAll(() => {
    execFileSync('node', ['scripts/build-server.mjs'], { cwd: resolve(__dirname, '../..') });
  });

  it('produces dist/mcp/server.mjs', () => {
    expect(existsSync(BUNDLE)).toBe(true);
  });
});
