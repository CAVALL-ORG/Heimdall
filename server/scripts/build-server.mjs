import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist/mcp', { recursive: true });

await build({
  entryPoints: ['src/mcp/server.ts'],
  outfile: 'dist/mcp/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  // Ketcher + playwright are heavy native/runtime deps — keep them external
  // so they resolve from node_modules at run time, not inlined.
  packages: 'external',
});

console.log('built dist/mcp/server.mjs');
