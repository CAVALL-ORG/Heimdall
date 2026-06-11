# 02 — Runner Architecture

The "runner" is a Claude Code **orchestrator agent** (not a CLI
binary). It reads the user's one-line invocation, follows
[../../AGENT_RUNBOOK.md](../../AGENT_RUNBOOK.md), and dispatches
work to subagents.

```
┌──────────────────────────────────────────────────────────────┐
│ User (one prompt) → "Run image-to-smiles per the runbook"    │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ ORCHESTRATOR (Claude Code main agent)                        │
│ • Parse filter from user prompt                              │
│ • Run prereq gate (RDKit, Playwright, UI bundle, Indigo?)    │
│ • For each row, schedule:                                    │
│     [test-runner subagent] → [evaluator subagent]            │
│   with concurrency cap = 3 (rows in parallel)                │
│ • Write report.md + failures.md                              │
│ • Print summary to chat                                      │
└──────────────────────────────────────────────────────────────┘
            │                              │
            ▼                              ▼
┌────────────────────────────┐  ┌────────────────────────────┐
│ TEST-RUNNER SUBAGENT       │  │ EVALUATOR SUBAGENT         │
│ (Agent tool /              │  │ (Agent tool /              │
│  general-purpose)          │  │  general-purpose)          │
│                            │  │                            │
│ Reads system.md            │  │ Reads evaluator.md         │
│ Treats row prompt like     │  │ Runs grader.py             │
│   production user intent   │  │                            │
│ Invokes skill first, then  │  │                            │
│   picks transport/scaffold │  │                            │
│ Drives Ketcher via tsx     │  │                            │
│   scripts (parallel) OR    │  │ Vision-compares (img rows) │
│   MCP tools (sequential)   │  │ Owns the verdict           │
│ Emits TRACE: + certified   │  │ Writes verdict.json        │
│   SMILES when authorized   │  │                            │
│                            │  │ Emits VERDICT: PASS|FAIL   │
└────────────────────────────┘  └────────────────────────────┘
```

## Orchestrator properties

- **One source of truth.** All filter / prereq / artifact / report
  logic lives in `AGENT_RUNBOOK.md`.
- **One user surface.** Type one line at the repo root, or use
  `/test <filter>`.
- **Production-shaped runner prompt.** The test-runner receives the row
  as a normal user task first ("give me the SMILES from this image"),
  invokes the matching skill, and only then applies harness transport
  constraints. The harness should not pre-teach row-specific chemistry,
  benchmark labels, or benchmark-specific routing.
- **Subagents share the parent MCP server / KetcherRuntime /
  Chromium page.** Parallel mode resolves the shared-canvas problem
  by forcing tsx-script transport (each tsx invocation spawns its
  own runtime).
- **Agent-tool subagents inherit the parent's turn budget.** Test-
  runner subagents are expected to finish in reasonable time; runaway
  loops still cost main-session tokens. The runtime caps long-running
  image-rebuild sessions silently — operator-side telemetry only; the
  subagent sees no budget integers.
- **No external CLI dependency.** Works inside the Claude Code IDE
  extension, the macOS app, the web app — anywhere a session can
  spawn subagents.

## Subagent transport: tsx scripts vs MCP tools

Parallel subagents share state. The transport rule:

| Run mode | Transport for test-runner |
|---|---|
| Parallel (default, cap 3) | tsx scripts only. `render_canvas` is the one MCP exception (read-only PNG snapshot). |
| Sequential (cap 1, `Run … sequentially per the runbook`) | MCP tools allowed; tsx scripts allowed too. Choose per the `ketcher-batch-driver` SKILL (MCP for short inline ops; tsx scripts for longer batches). |

The orchestrator passes a `parallel: true|false` flag into the
test-runner subagent prompt. The subagent honors it via the rules
in [../runner/prompts/system.md](../runner/prompts/system.md).

## Concurrency

Subagent fan-out is capped at **3** rows in parallel (configurable
via "Run … with concurrency N"). Higher cold-starts more Playwright
runtimes than the host can service (per CLAUDE.md "Multi-parent
batches"); 3 is the safe ceiling.

The orchestrator schedules rows with the same worker-pool pattern as
[server/src/batch/](../../../server/src/batch/) — no
`Promise.all` over arbitrary arrays.

## Trace capture

The orchestrator cannot see the test-runner's tool history directly
(Agent tool returns only the final assistant message). The
test-runner self-reports its trace via `TRACE: <op>` lines in its
final message. The orchestrator expands those snake_case op names
into the grader's full label vocabulary via the `TOOL_TO_LABEL` map
in [../runner/trace_capture.ts](../runner/trace_capture.ts), then
writes `trace.json` in the schema `grader.py` expects.

`trace.json`'s `final_assistant_text` is the rendered text surface the
grader parses (TRACE events, CROP_RATIONALE lines, free-form prose).
Copy verbatim — paraphrasing breaks the parsers.

Some host-recorded labels (`vision_consistency_verified`,
`vision_consistency_mismatch`,
`handle_recognition_failure_without_invention`) are inferred from
the test-runner's final text plus its TRACE log via the heuristics
in `trace_capture.ts`.

## Evaluator owns the verdict

The orchestrator does NOT call `grader.py` directly. It delegates to
the evaluator subagent, which:

1. Calls `grader.py` for the deterministic canonical-SMILES + trace
   gate.
2. For image rows: vision-compares the candidate SMILES (re-rendered
   via Ketcher) against the original image. InChIKey equivalence is
   NOT enough — drawn tautomer / protomer / H position must match.
3. Picks a root-cause bucket from the
   [evaluator.md](../runner/prompts/evaluator.md) vocabulary and
   emits `VERDICT: PASS|FAIL — <bucket>: <one-line detail>`.
4. Writes the full structured verdict to `verdict.json`.

The orchestrator reads the verdict, records the row, and moves on.

## Output layout

Per-run artifacts under `outputs/tests/agent-orch/<run-id>/`:

```
outputs/tests/agent-orch/<run-id>/
├── report.md             # comparison table across all rows
├── failures.md           # root-cause breakdown for non-pass rows
├── summary.jsonl         # one JSON line per row
└── <row.id>/
    ├── candidate.json    # test-runner output
    ├── trace.json        # expanded for grader.py
    ├── verdict.json      # evaluator's verdict
    └── scripts/          # any tsx scripts the test-runner wrote
```

`run-id` defaults to `agent-orch-<YYYYMMDD-HHMMSSZ>` UTC. The
orchestrator computes it once at run start, reuses across rows.

## Exit semantics

The orchestrator is a chat agent — there is no exit code. Instead it
emits a structured summary:

- All passed → `Ran N rows; N passed, 0 failed, 0 errored.` +
  pointer to `report.md`.
- Some failed → headline counts + per-row failure detail + pointer
  to `failures.md`.
- Prereq gate failed → single-line diagnostic + abort, no subagents
  spawned.
- P0 gate failed (when present) → run aborts before non-P0 rows;
  orchestrator says so explicitly.

## Resuming / re-running

A re-run is the user typing a new prompt. To re-run only failures:

```
Re-run failures from agent-orch-20260517-1530Z per the runbook
```

The orchestrator reads the prior run's `failures.md`, extracts the
row ids, and re-runs those with a fresh `run-id`. The prior run's
artifacts stay untouched.

Each row is a one-shot run against a daemon slot: the test-runner script invokes
ONE `buildFromGraph` call (with optional ONE local-correction retry on a
backend-named diagnostic). No multi-patch session, no continuation envelopes.

## What the orchestrator does NOT do

- Does not pre-warm the canvas across rows. Each subagent starts
  cold (either spawns its own tsx KetcherRuntime, or shares the
  parent MCP in sequential mode).
- Does not grade. The evaluator owns the verdict.
- Does not retry flaky rows silently. A flake is a fail.
- Does not write outside `outputs/tests/agent-orch/<run-id>/`.

## Filter inputs the user can type

```
Run all tests per the runbook
Run the scientific suite per the runbook
Run scientific shard P0-primitives per the runbook
Run scientific shard S1 per the runbook
Run grading mode canonical_smiles_plus_trace per the runbook
Run mechanical primitives per the runbook
Run image-to-smiles per the runbook
Run image negative controls per the runbook
Run row C001 per the runbook
Run rows C001,R003,I007 per the runbook
Run … sequentially per the runbook       # disables parallel; allows MCP transport
Run … with concurrency 1 per the runbook # same effect; explicit
```

Full filter-to-manifest mapping table is in the runbook.
