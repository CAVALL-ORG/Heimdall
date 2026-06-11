#!/usr/bin/env node
/**
 * Pre-bundle the test-harness daemon scripts so the orchestrator can
 * launch the daemon (and subagents can import test-batched-template)
 * via `node dist/scripts/<name>.mjs` instead of `npx tsx`, dropping
 * tsx's ~300-1500 ms compile-on-launch overhead per invocation.
 *
 * Output: <repo-root>/server/dist/scripts/<entry>.mjs.
 *
 * Vision-suite speedup plan, Phase 5. Uses esbuild because
 * tsc(CommonJS) breaks on `import.meta.url` in src/mcp/runtime.ts and
 * tsc(ESM) does not rewrite bare imports to .js extensions (node's
 * native ESM requires them). esbuild's `--bundle --format=esm
 * --packages=external` handles both: inline first-party TS, leave
 * node_modules as runtime imports.
 */
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = dirname(__dirname);
const OUT = join(PKG, 'dist', 'scripts');
mkdirSync(OUT, { recursive: true });

const ENTRIES = ['test-daemon.ts', 'test-daemon-client.ts', 'test-batched-template.ts'];

await Promise.all(
  ENTRIES.map((entry) =>
    esbuild.build({
      entryPoints: [join(__dirname, entry)],
      outfile: join(OUT, entry.replace(/\.ts$/, '.mjs')),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      packages: 'external',
      sourcemap: false,
      logLevel: 'error',
    }),
  ),
);

console.log(`built ${ENTRIES.length} entries → ${OUT}`);
