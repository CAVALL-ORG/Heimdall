// Optional Chromium pre-warm. NOT run from `postinstall` — the npm install
// stays light so `npx -y @cavall/heimdall-mcp-server` clears Claude Code's 30s
// MCP connect timeout, and the server downloads Chromium lazily on first use
// (see runtime.ts launchChromium). Run this by hand to pre-warm a Docker image
// or CI cache: `node scripts/ensure-chromium.mjs` (or `npm run setup`).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

if (process.env.HEIMDALL_SKIP_BROWSER === '1') {
  console.log('[heimdall] skipping Chromium install (opt-out set)');
  process.exit(0);
}

try {
  // Resolve the CLI bundled with THIS package's playwright dep (via its
  // package.json — the only export the package exposes), not `npx playwright`,
  // which resolves from PATH / the npx cache and can fetch a mismatched
  // revision or collide with an in-flight `__dirlock`. Hoist-safe: works
  // whether playwright lives in this package's node_modules or a parent's.
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
  // Idempotent: playwright no-ops if the browser revision is already cached.
  execFileSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
} catch (err) {
  console.warn(
    '[heimdall] Chromium pre-warm failed; the server will download it on first '
      + 'use instead.',
    err?.message ?? err,
  );
  // Never fail — the runtime self-heals the missing browser on first launch.
}
