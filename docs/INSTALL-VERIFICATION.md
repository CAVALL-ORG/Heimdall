# Install verification

Records the install checks for each distribution channel. The clean-room npm
install is verified here; the per-platform marketplace installs are owner-run
on a clean box (they need the `claude` / Cursor / Codex clients) — fill in the
results before announcing the release.

## Channel 1 — npm tarball clean install (VERIFIED)

Packed `@cavall/heimdall-mcp-server@0.1.0` and installed it into a fresh
temp dir (no dev workspace state):

```bash
cd server && npm pack                      # -> cavall-heimdall-mcp-server-0.1.0.tgz
T=$(mktemp -d); cd "$T"; npm init -y
HEIMDALL_SKIP_BROWSER=1 npm install /path/to/cavall-heimdall-mcp-server-0.1.0.tgz
node -e "require.resolve('@cavall/heimdall-mcp-server/dist/mcp/server.mjs')"
```

- ✅ install succeeds; `postinstall` opt-out (`HEIMDALL_SKIP_BROWSER=1`) is silent and non-fatal.
- ✅ bin resolves: `node_modules/@cavall/heimdall-mcp-server/dist/mcp/server.mjs`.
- Package size: ~7.7 MB packed / ~26 MB unpacked (the prebuilt Ketcher `dist/ui` dominates — by design, so no UI build at install).
- Tarball contents gate: 65 files; production artifacts present (`dist/mcp/server.mjs`, `dist/ui/index.html`, `scripts/indigo-shim.py`, `scripts/ensure-chromium.mjs`); **zero** tests/fixtures/harness scripts shipped.
- The in-tree e2e (`server/tests/runtime-e2e/prebuilt-ui-boot.e2e.test.ts`) proves the node bundle boots Ketcher from `dist/ui` and serves `load_smiles -> export_smiles` with no tsx/vite at runtime.

> Note: a full **boot** from a clean box also fetches Chromium (~150 MB, one-time)
> unless `HEIMDALL_SKIP_BROWSER=1`. First server start prints a clear error if
> the browser is genuinely missing.

## Channel 2 — Claude Code (marketplace) — OWNER TO RUN

On a clean checkout / machine:

```
/plugin marketplace add CAVALL-ORG/Heimdall
/plugin install heimdall@heimdall
```
Then run an image-rebuild on a known fixture and confirm a SMILES comes back.

- [ ] skills (`heimdall-image-rebuild`, `heimdall-pdf-extract`, `heimdall-ingest`) load
- [ ] `heimdall` MCP tools resolve (verify the prefix the client exposes matches `mcp__heimdall__*`)
- [ ] one real image row returns a SMILES — record it here:
- Result:

## Channel 3 — Cursor — OWNER TO RUN

Paste `scripts/print-mcp-config.sh cursor` into `.cursor/mcp.json` (or use the
deeplink from OWNER-RELEASE.md); skills auto-load from `.agents/skills/`.

- [ ] three skills load
- [ ] agent sees `ketcher`/`heimdall` tools under the expected prefix (note the exact prefix Cursor exposes)
- Result:

## Channel 4 — Codex — OWNER TO RUN

```
codex mcp add heimdall -- npx -y @cavall/heimdall-mcp-server
```
Requires Codex ≥ 0.34, `mcp_servers` (underscore); for repo-scoped
`.codex/config.toml`, trust the project in `~/.codex/config.toml`.

- [ ] `/mcp` shows the `heimdall` server's tools
- [ ] installed Codex version (must be ≥ 0.34):
- Result:
