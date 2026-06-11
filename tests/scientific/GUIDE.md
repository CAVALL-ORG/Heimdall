# GUIDE — Ketcher Scientific Test Suite

## What this suite proves

That a Claude agent armed with the project's skills can:

1. Use Ketcher as the structural source of truth for *any* molecular task
   (no shortcut answers from memorized chemistry).
2. Recognize structures from images robustly — including a
   **self-verification round-trip** that catches its own hallucinations.
3. Compose Ketcher primitives (atom/bond edits, charge, radical, stereo,
   reactions) under realistic prompts that do not name Ketcher.
4. Refuse gracefully when an image is not a chemical structure, without
   inventing SMILES.

## Architecture

```
                ┌────────────────────────────────────────┐
                │  ORCHESTRATOR (Claude Code main agent) │
                │  • parses user filter                  │
                │  • runs prereq gate                    │
                │  • schedules rows (parallel cap 3)     │
                │  • writes report.md + failures.md      │
                └─────────────┬──────────────────────────┘
                              │ per row, sequentially:
                              ▼
        ┌──────────────────────────┐    ┌──────────────────────────┐
        │ TEST-RUNNER SUBAGENT     │ →  │ EVALUATOR SUBAGENT       │
        │ (Agent tool)             │    │ (Agent tool)             │
        │ • reads system.md        │    │ • reads evaluator.md     │
        │ • drives Ketcher via tsx │    │ • calls grader.py        │
        │   script (parallel) or   │    │ • vision-compares images │
        │   MCP (sequential)       │    │ • owns the VERDICT       │
        │ • emits TRACE: + certified │    └──────────────┬───────────┘
        │   SMILES when available    │
        └──────────────────────────┘                   │
                              ▼                         ▼
                      outputs/tests/agent-orch/<run-id>/
                          ├ report.md
                          ├ failures.md
                          ├ summary.jsonl
                          └ <id>/
                              ├ candidate.json   (test-runner output)
                              ├ trace.json       (expanded for grader)
                              └ verdict.json     (evaluator's verdict)
```

Each test-runner subagent runs in its own Agent-tool context with no
shared canvas (tsx scripts spawn fresh KetcherRuntime per invocation
in parallel mode). The evaluator is a separate subagent so judgement
is decoupled from execution.

## Two grading gates

A test passes only when both gates pass.

1. **Chemistry gate** — canonical isomeric SMILES match (or whatever the
   `grading` field specifies). Implemented in
   [runner/grader.py](runner/grader.py) on top of RDKit.
2. **Execution gate** — the MCP trace contains every entry in
   `required_trace_events`. A chemically correct answer that didn't go
   through Ketcher (e.g. quoted from memorized chemistry) fails.

For image cases, follow `.claude/skills/ketcher-image-rebuild/SKILL.md`.
Dense rows use backend-owned worksheet continuation and may leave
`candidate_smiles` empty when export is blocked. Read
[docs/04_image_verification.md](docs/04_image_verification.md) only as a
subordinate suite note.

## Suite size

Total: **77 chemistry-reasoning cases** in [manifest.jsonl](manifest.jsonl).
Image-driven cases (98 rows) live in [tests/ketcher/image-to-smiles/](../ketcher/image-to-smiles/);
mechanical primitives (5 rows) in [tests/ketcher/mechanical-primitives/](../ketcher/mechanical-primitives/).

| Shard | Count | Suite | Run mode |
|---|---|---|---|
| P0-primitives | 14 | ketcher_primitives | sequential gate |
| S1-fragments | 10 | fragment_and_ring_tasks | parallel after P0 |
| S2-functional | 10 | functional_group_transformations | parallel after P0 |
| S3-charge | 10 | charge_valence_salts | parallel after P0 |
| S4-radicals | 8 | radicals | parallel after P0 |
| S5-regio | 10 | regiochemistry | parallel after P0 |
| S6-stereo | 8 | stereochemistry | parallel after P0 |
| S7-canvas | 5 | canvas_state_grounding | parallel after P0 |
| S8-reactions | 8 | reaction_tasks | parallel after P0 |
| S9-images-clean | 10 | image_to_smiles (synthetic clean) | parallel after P0 |
| S9b-images-noisy | 6 | image_to_smiles (synthetic noisy) | parallel after P0 |
| S9c-images-adversarial | 4 | image_to_smiles (filename-adversarial) | parallel after P0 |
| S10-negative-images | 4 | image_negative_controls | parallel after P0 |
| S11-academic-images | 8 | image_to_smiles (academic papers, CC-licensed) | parallel after P0 |
| S12-wikipedia-images | 6 | image_to_smiles (Wikimedia Commons) | parallel after P0 |
| S13-roundtrip | 4 | image_roundtrip_regression | parallel after P0 |

## Docs

Read these in order:

1. [docs/01_skill_contract.md](docs/01_skill_contract.md) — the rule the
   subagent must follow, including the trace-event vocabulary.
2. [docs/02_runner_architecture.md](docs/02_runner_architecture.md) — how
   the orchestrator dispatches subagents and the evaluator owns the verdict.
3. [docs/03_grading.md](docs/03_grading.md) — every grading mode, what it
   checks, and how to extend.
4. [docs/04_image_verification.md](docs/04_image_verification.md) — suite
   notes for image verification; subordinate to
   `.claude/skills/ketcher-image-rebuild/SKILL.md`.
5. [docs/05_authoring_tests.md](docs/05_authoring_tests.md) — how to add
   a new case (manifest row + optional image + grading mode choice).

## Manifest schema

Each row of [manifest.jsonl](manifest.jsonl):

```jsonc
{
  "id": "I001",
  "suite": "image_to_smiles",
  "parallel_shard": "S9-images-clean",
  "parallel_group": "S9",
  "prompt": "Given the uploaded molecule image, rebuild it per the image-rebuild skill …",
  "input_smiles": null,
  "image_path": "images/clean/benzene_clean.png",
  "expected_smiles": "c1ccccc1",
  "expected_canonical_smiles": "c1ccccc1",
  "acceptable_canonical_smiles": ["c1ccccc1"],
  "grading": "canonical_smiles_from_image_plus_trace",
  "expected_failure": false,
  "required_trace_events": [
    "build_from_graph",
    "render_canvas",
    "export_smiles"
  ],
  "notes": "Image rows follow ketcher-image-rebuild; dense rows may leave candidate_smiles null when export is blocked."
}
```

The `required_trace_events` list is the contract the execution gate enforces.

## Why subagents (not the host model)?

A test that uses the same model instance which authored the runner would
contaminate the result with conversation context. Spawning an Agent-tool
subagent per row makes each evaluation hermetic — fresh context window,
fresh skill discovery, fresh tsx KetcherRuntime per script invocation in
parallel mode. That matches what a user gets.

The orchestrator dispatches subagents at a concurrency cap (default 3,
matching the KetcherRuntime spawn cap documented in `CLAUDE.md`) so
Playwright doesn't trip its 120 s startup deadline. Parallel test-runner
subagents are required to use tsx scripts (each spawns its own runtime);
MCP tools are allowed only in sequential mode because the shared MCP
canvas corrupts under concurrent mutation.

A separate evaluator subagent — also Agent-tool, also fresh context —
owns the per-row verdict. See [docs/02_runner_architecture.md](docs/02_runner_architecture.md).
