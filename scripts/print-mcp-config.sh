#!/usr/bin/env bash
# Usage: scripts/print-mcp-config.sh claude|cursor|codex [--servers N]
# Emits the MCP server config block for the chosen platform.
# One server (default) = interactive use. --servers N (cap 3) = concurrent batch
# pool (Model B): N keyed servers, each isolated, with KETCHER_STRICT_CANVAS_ANCHOR=1
# so a batch host stays race-free even if a worker forgets its rowId.
set -euo pipefail
PKG="@cavall/heimdall-mcp-server"
PLATFORM="${1:-}"; N=1
[[ "${2:-}" == "--servers" ]] && N="${3:-1}"
(( N >= 1 && N <= 3 )) || { echo "servers must be 1..3 (Chromium startup cap)" >&2; exit 2; }

key() { [[ "$1" -eq 1 ]] && echo "heimdall" || echo "heimdall-$1"; }
# Strict anchor only when pooling (N>1), so batch hosts are race-safe.
strict() { [[ "$N" -gt 1 ]] && echo ', "KETCHER_STRICT_CANVAS_ANCHOR": "1"' || true; }

case "$PLATFORM" in
  claude|cursor)
    printf '{\n  "mcpServers": {\n'
    for i in $(seq 1 "$N"); do
      sep=$([[ "$i" -lt "$N" ]] && echo "," || echo "")
      printf '    "%s": { "command": "npx", "args": ["-y", "%s"], "env": { "KETCHER_AGENT_MODE": "auto"%s } }%s\n' \
        "$(key "$i")" "$PKG" "$(strict)" "$sep"
    done
    printf '  }\n}\n' ;;
  codex)
    for i in $(seq 1 "$N"); do
      printf '[mcp_servers.%s]\ncommand = "npx"\nargs = ["-y", "%s"]\n[mcp_servers.%s.env]\nKETCHER_AGENT_MODE = "auto"\n' \
        "$(key "$i")" "$PKG" "$(key "$i")"
      [[ "$N" -gt 1 ]] && printf 'KETCHER_STRICT_CANVAS_ANCHOR = "1"\n'
      printf '\n'
    done ;;
  *) echo "usage: $0 claude|cursor|codex [--servers N]" >&2; exit 2 ;;
esac
