# Contributing to Heimdall

Thanks for your interest in contributing. Heimdall is a headless Ketcher
runtime exposed as an MCP server (`@cavall/heimdall-mcp-server`) for
agent-driven molecule editing. This guide covers local setup, the one
invariant every contributor must preserve, and the checks to run before
opening a pull request.

By participating you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

```bash
git clone https://github.com/CAVALL-ORG/Heimdall
cd Heimdall/server
npm install
npm run build
```

`npm install` runs a `postinstall` step that ensures a compatible Chromium is
available (Playwright). `npm run build` builds the UI bundle and the server.

### Python test environment (only for the eval harness + optional Indigo)

The server itself needs no Python. The image-truth eval grader (RDKit) and the
optional Indigo shim (canonical SMILES + full stereo) do. Create one clean,
isolated venv for both — from the repo root:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
export HEIMDALL_PYTHON="$PWD/.venv/bin/python"
```

You only need this to run the agent-orchestrated eval (see `tests/TESTING.md`)
or to get canonical/stereo output locally. The per-PR checklist below does not
require it.

## The cardinal invariant — the agent NEVER authors SMILES

Heimdall exists to be the **agentic interface to Ketcher**. Its entire value
is that Ketcher — not a language model — is the source of truth for every
SMILES string. There are exactly two legitimate origins for any SMILES that
leaves the system:

1. **The caller supplied it directly** (e.g. as input to an ingest path or as
   the parent SMILES for a transform).
2. **Ketcher emitted it** via `mcp__heimdall__export_smiles` on a canvas the
   agent built (from a caller-supplied SMILES via `load_smiles`, from a
   transcribed graph via `build_from_graph`, or by issuing graph primitives).

There is no third path. **Do not add a code path that lets the model emit a
SMILES it typed** — not from vision, not from memory of "what this molecule
looks like", not by "quoting the after-state to sanity-check it", not by
hand-authoring stereo (`@`/`@@`), E/Z (`/`/`\`), or ring closures. If a SMILES
appears in output and did not come from `export_smiles` or the caller, the
operation is wrong even if the chemistry happens to be right.

This is a flat, enforceable rule, not a judgment call. For image-rebuild paths
in particular, `load_smiles` and `load_canonical` are forbidden — the agent
transcribes visible pixel features into a graph intent, the backend compiles
it, and `export_smiles` emits the answer. If you are touching a skill or a tool
that produces SMILES, preserve this contract.

## Verify before a PR (run locally — there is no CI)

There is no continuous-integration pipeline; you are the CI. Run the following
from the `server/` directory and confirm each passes before opening a PR:

```bash
cd server
npm run typecheck
npx vitest run tests/unit
npm audit --audit-level=moderate
# image-path smoke (needs Chromium: `npx playwright install chromium`):
RUN_KETCHER_E2E=1 npx vitest run tests/runtime-e2e/trimmed-server-smoke.e2e.test.ts --testTimeout=120000
```

Notes:

- The full agent-orchestrated image→SMILES grading suite needs a live
  vision-capable agent and is **not** part of this per-PR checklist. Its steps
  live in `tests/TESTING.md`.
- `tests/unit` currently has **3 known pre-existing paclitaxel dense-FP
  failures** (Indigo-dependent). These are not a regression gate — do not block
  your PR on them, but do not introduce *new* failures.

## Pull request expectations

- **Keep PRs small and focused.** One logical change per PR; it is far easier
  to review and revert a tight diff than a sprawling one.
- **Update docs and tests with behavior changes.** A meaningful behavior change
  comes with updated tests and updated docs, or a documented reason neither is
  possible.
- **Stay in scope.** Awareness of a problem elsewhere is not permission to fix
  it in the same PR — flag it instead.
- **Fill in the PR template** (`.github/PULL_REQUEST_TEMPLATE.md`), including
  the verify-before-PR checklist, so reviewers know what you ran.
