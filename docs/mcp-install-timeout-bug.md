# MCP Install Timeout — Bug Handoff

## Initial Symptom

Fresh Claude Code install via:

```
/plugin marketplace add CAVALL-ORG/Heimdall
/plugin install heimdall@heimdall
```

Results in:

```
MCP server "plugin:heimdall:heimdall" connection timed out after 30000ms
```

---

## Root Cause

Claude Code's MCP subprocess timeout is **30 seconds**. On a cold machine, `npx -y @cavall/heimdall-mcp-server` must:

1. Download the 26.9 MB package
2. Run `postinstall` → `npx playwright install chromium` → downloads Chrome Headless Shell (~113 MB) + full Chrome for Testing (~150 MB)

This takes **2–5 minutes** on a typical connection. Claude Code kills the subprocess at 30s. The MCP server never starts.

---

## What the Failed Run Leaves Behind

The kill happens mid-download. Playwright's `__dirlock` directory is not cleaned up. On the next Claude Code start, a new install attempt sees the stale lock, fights with it, and either:

- Exits silently without downloading anything, or
- Crashes with `Unable to update lock within the stale threshold`

If one browser partially downloads before the kill, its cache directory exists but is empty or incomplete — causing a different failure mode on the next attempt.

---

## Cascading Failure: The webkit Fallback

`server/src/mcp/runtime.ts:372–381` — the server tries `chromium.launch()` first. If that throws `"Executable doesn't exist"`, it falls back to `webkit.launch()`. webkit is never installed by the postinstall script, so the fallback always fails too. The user sees a confusing error about webkit rather than a clear message about Chromium being missing.

```typescript
// runtime.ts:372
try {
  this.browser = await chromium.launch({ headless: true });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Executable doesn't exist|Target page, context or browser has been closed/i.test(message)) {
    this.browser = await webkit.launch({ headless: true }); // <-- always fails for npm users
  } else {
    throw error;
  }
}
```

---

## Secondary Bug: `ensure-chromium.mjs` Uses the Wrong playwright

`scripts/ensure-chromium.mjs` calls:

```js
execFileSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit' });
```

`npx playwright` resolves from PATH or npx cache — not from the package's own `node_modules/playwright`. This causes:

1. A playwright "no project dependencies" warning that looks like a failure
2. Risk of installing a different chromium revision than the server expects
3. The `__dirlock` conflict when multiple install attempts run concurrently (e.g. if the user retries)

Fix: replace `npx playwright` with a direct call to the bundled CLI:

```js
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const playwrightCli = resolve(__dirname, '../node_modules/playwright/cli.js');
execFileSync('node', [playwrightCli, 'install', 'chromium'], { stdio: 'inherit' });
```

---

## What Was Ruled Out

- Plugin install mechanism itself works fine — verified clean reinstall completes in under 1 second
- MCP server responds correctly once browsers are cached — verified full MCP handshake and all 15 tools present
- `@cavall/heimdall-mcp-server@0.1.0` is correctly published to npm

---

## Fixes Needed

| # | File | Fix |
|---|---|---|
| 1 | `scripts/ensure-chromium.mjs` | Call `node_modules/playwright/cli.js` directly instead of `npx playwright` |
| 2 | `server/src/mcp/runtime.ts:376` | Remove or guard the webkit fallback — verify webkit is installed before attempting launch, or replace with a clear "Chromium not found" error |
| 3 | README | Updated to warn about 1–5 min silent first-run download; removed the broken `npx playwright install chromium` prereq command |

---

## Structural Limitation

The 30-second timeout is a Claude Code constraint and cannot be changed. The real mitigation options are:

- **Lazy browser download** — defer Chromium install to first tool call, respond to MCP `initialize` immediately, return a clear "browser initializing" error on tool calls until ready
- **One-time setup command** — publish a `heimdall-setup` or `npx @cavall/heimdall-mcp-server --install` path users run from terminal (outside Claude Code) before the first session
- **Smaller first-run footprint** — investigate whether the headless shell alone (~113 MB) is sufficient, eliminating the full Chrome download from the critical path
