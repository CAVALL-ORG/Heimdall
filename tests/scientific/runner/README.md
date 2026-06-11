# runner/

The reusable pieces the **orchestrator agent** + **evaluator
subagent** call into. The orchestrator itself is not a binary —
it's a Claude Code agent following
[../../AGENT_RUNBOOK.md](../../AGENT_RUNBOOK.md).

```
runner/
├── grader.py          # deterministic chemistry + execution gate (called by evaluator)
├── trace_capture.ts   # snake_case op → grader label map; helpers used by orchestrator
└── prompts/
    ├── system.md      # appended to every test-runner subagent prompt (skill-first, production-shaped task)
    └── evaluator.md   # appended to every evaluator subagent prompt
```

## How a user invokes a run

Open a Claude Code session at the repo root and type one short line.
The orchestrator (the agent receiving the prompt) handles everything:

```
Run the scientific suite per the runbook
Run scientific shard P0-primitives per the runbook
Run row I007 per the runbook
Run image-to-smiles per the runbook
```

Or via the slash command:

```
/test scientific/P0-primitives
/test image-to-smiles
/test C001,R003
```

Full filter syntax + prereq gate + per-row procedure + report layout
+ failure handling lives in [../../AGENT_RUNBOOK.md](../../AGENT_RUNBOOK.md).

## Prereqs (the orchestrator runs the gate automatically)

- Python 3 with `rdkit` (`grader.py` imports `rdkit.Chem`).
- The repo's normal prereqs (npm deps, UI bundle, Playwright,
  Indigo Docker — only for canonical SMILES / PDF render) per
  [../../CLAUDE.md](../../CLAUDE.md).

If `rdkit` isn't available globally, install per its docs (`pip
install rdkit` works on most platforms for recent versions).

## Output

Per-run artifacts under `outputs/tests/agent-orch/<run-id>/`. See
[../docs/02_runner_architecture.md](../docs/02_runner_architecture.md)
for the directory schema.

`trace_capture.ts` exports the `TOOL_TO_LABEL` map the orchestrator
uses to expand the test-runner's `TRACE: <op>` lines into the
grader's full label vocabulary.
