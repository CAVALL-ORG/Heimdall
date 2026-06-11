# @cavall/heimdall-mcp-server

The prebuilt **stdio MCP server** that backs the [Heimdall](https://github.com/CAVALL-ORG/Heimdall)
skills. Heimdall turns an image or PDF of drawn chemical structures into SMILES
with **Ketcher as the source of truth** — the model transcribes the visible
marks, a backend interprets them into a chemical graph, and Ketcher exports the
SMILES. No SMILES is ever free-styled by the LLM.

This package ships the server, a headless Ketcher UI bundle, and a small Indigo
shim. It is normally installed for you by the Heimdall plugin; install it
directly only if you are wiring the MCP server into a client by hand.

## Run

```bash
npx -y @cavall/heimdall-mcp-server
```

Register it as an MCP server (key `heimdall`) in your client. For example, in
`.mcp.json`:

```json
{
  "mcpServers": {
    "heimdall": {
      "command": "npx",
      "args": ["-y", "@cavall/heimdall-mcp-server"]
    }
  }
}
```

Tools are then addressed as `mcp__heimdall__<tool>`.

## Tools

The server exposes 16 tools (ingest, build-from-graph, validate, crop, render,
export, refuse) — no editing or chemistry-derivation surface. See
[`docs/tool-reference.md`](https://github.com/CAVALL-ORG/Heimdall/blob/main/docs/tool-reference.md)
in the main repo for the full list and arguments.

## Configuration

- **`HEIMDALL_PYTHON`** — Python interpreter used to probe/run Indigo
  (default `python3`). Indigo is **optional**: it enables canonical SMILES and
  improved stereo perception. Without it the server still runs; exports carry a
  "degraded" advisory.
- **`HEIMDALL_SKIP_BROWSER`** — set to skip the Chromium download in the
  `postinstall` step (the headless Ketcher canvas needs Chromium at runtime, so
  only skip this if Chromium is already provisioned by other means).

## Links

- Main repository: <https://github.com/CAVALL-ORG/Heimdall>
- Tool reference: <https://github.com/CAVALL-ORG/Heimdall/blob/main/docs/tool-reference.md>
- Architecture: <https://github.com/CAVALL-ORG/Heimdall/blob/main/docs/architecture.md>

---

Cavall Labs · <ethan@cavall.ai>
