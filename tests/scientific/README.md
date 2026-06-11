# Scientific Test Suite

> **Status (Heimdall public tree):** `manifest.jsonl` is **empty**. The 77
> chemistry-reasoning cases this suite used to carry tested the `chem-*`
> reasoning skills, which are **not part of Heimdall**. Heimdall ships three
> skills only — `heimdall-image-rebuild`, `heimdall-pdf-extract`,
> `heimdall-ingest` — so the chemistry-reasoning rows were removed during
> public curation. The **primary eval is now the image→SMILES suite** at
> [../ketcher/image-to-smiles/manifest.jsonl](../ketcher/image-to-smiles/manifest.jsonl).
> The `runner/` (grader + prompts + trace capture) and the shared image
> fixture pool under `images/` are retained because the image suite reuses
> them. See [../TESTING.md](../TESTING.md) for the public runbook.

The text below describes the original chemistry-reasoning design and is
kept for provenance only.

Tests that the agent uses Ketcher to **reason like a chemist**. The
prompts are open-ended chemistry questions; the agent must invoke the
matching project skill and drive Ketcher through every mutation. For
image rows, `.claude/skills/ketcher-image-rebuild/SKILL.md` is the sole
normative contract: no `load_smiles` shortcut, backend-owned dense
continuation, and no candidate SMILES unless `export_smiles` was
certified. The grader compares the final canonical SMILES + required MCP
trace events.

## Layout

```
tests/scientific/
├── README.md                   ← this file
├── GUIDE.md                    ← author-time setup / fixture rules
├── manifest.jsonl              ← 77 chemistry-reasoning cases
├── shards.csv                  ← parallel-shard schedule
├── docs/                       ← suite architecture
│   ├── 01_skill_contract.md      mandatory skill use + round-trip
│   ├── 02_runner_architecture.md orchestrator + subagents + evaluator
│   ├── 03_grading.md             10 grading modes
│   ├── 04_image_verification.md  closed-loop vision verification
│   └── 05_authoring_tests.md     test authoring guide
├── images/                     ← shared image fixture pool (the ketcher/image-to-smiles
│                                 subsuite symlinks here so it doesn't duplicate fixtures)
├── runner/                     ← grader.py + trace label map + prompts/
└── scripts/                    ← fixture download / sync helpers
```

## Suite distribution (77 cases)

| Suite | Cases | What's tested |
|---|---|---|
| fragment_and_ring_tasks | 10 | Ring fission, substitution, fragment attachment |
| functional_group_transformations | 10 | H• ablation, deprotonation, radical cation routing |
| charge_valence_salts | 10 | Formal charge placement, salt forms, zwitterions |
| regiochemistry | 10 | Ortho/meta/para picking, regioselectivity |
| ketcher_primitives (chemistry-driven) | 8 | P004–P010, P012 — chemistry-aware primitive use |
| radicals | 8 | Radical generation + stability ranking |
| stereochemistry | 8 | Wedge/dash, E/Z, chiral centers |
| reaction_tasks | 8 | Multi-step reactions, RXN export |
| canvas_state_grounding | 5 | Persistent canvas state across multi-turn prompts |

Mechanical primitives (P001–P003, P011, P014) live in
`tests/ketcher/mechanical-primitives/` — they aren't chemistry tests.
All 38 image-driven cases (P013 + image_to_smiles + negative controls +
roundtrip regression) live in `tests/ketcher/image-to-smiles/`.

## How to run

**One mode. One short prompt.** Open a Claude Code session at the
repo root and type one of:

```
Run the scientific suite per the runbook
Run scientific shard P0-primitives per the runbook
Run scientific shard S1 per the runbook
Run row C001 per the runbook
Run rows C001,R003 per the runbook
Run grading mode canonical_smiles_plus_trace per the runbook
```

The receiving agent is the **orchestrator**. It reads
[../AGENT_RUNBOOK.md](../AGENT_RUNBOOK.md), spawns a test-runner
subagent per matching row (cap 3 parallel), spawns an evaluator
subagent that owns the verdict (calls
[runner/grader.py](runner/grader.py) for the deterministic gate),
writes `report.md` + `failures.md` under the run directory, and
prints a pass/fail summary.

Prerequisites (the orchestrator runs the gate automatically — listed
here for reference):

- Python 3 with RDKit + Indigo, in a clean isolated venv. From the repo root:
  `python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`
  (then `export HEIMDALL_PYTHON="$PWD/.venv/bin/python"`). See `tests/TESTING.md`.
- Playwright chromium (for the MCP server's headless Ketcher).
- UI bundle built (`npm run build:ui -w server`).
- Indigo Docker container at port 8002 (for `export_smiles canonical=true`
  + PDF render in any `mode: pdf` deliverables the case produces — optional
  for most rows).

## Grading modes

10 modes documented in `docs/03_grading.md`. The most common:

| Mode | What it checks |
|---|---|
| `canonical_smiles` | RDKit canonical SMILES matches `expected_canonical_smiles`. |
| `canonical_smiles_plus_trace` | Canonical SMILES match + required `required_trace_events` all present in the captured trace. |
| `canonical_smiles_from_image_plus_trace` | As above, but the input was an image; trace must include the image-rebuild primitives (`build_from_graph` / worksheet session / render / export), not `load_smiles`. |
| `image_roundtrip_evaluator` | Closed-loop: render the result, vision-verify against the source, require trace events. |
| `canonical_isomeric_smiles` | Stereochemistry is mandatory (E/Z, R/S preserved in canonical form). |
| `canonical_smiles_plus_isomer_specificity` | Regiochemistry / E/Z specifically required (ortho ≠ para etc.). |
| `canonical_smiles_plus_hidden_input_canvas` | Multi-turn: the agent's view of the canvas must survive across prompts. |
| `product_canonical_smiles_plus_rxn_export` | Reactions: product SMILES + RXN file structure. |
| `safe_failure_plus_no_invented_smiles` | Negative control: must refuse without fabricating SMILES or calling `load_smiles`. |
| `canonical_isomeric_smiles_plus_radical_count` | Radicals + stereo together. |

## Output format

Per-run artifacts land under `outputs/tests/agent-orch/<run-id>/`:

```
outputs/tests/agent-orch/<run-id>/
├── report.md             — comparison table across all rows
├── failures.md           — root-cause breakdown for non-pass rows
├── summary.jsonl         — one JSON line per row
└── <row.id>/
    ├── candidate.json    — {candidate_smiles|null, candidate_trace, subagent_summary}
    ├── trace.json        — events expanded for grader.py
    ├── verdict.json      — evaluator's structured verdict
    └── scripts/          — any tsx scripts the test-runner wrote
```

For a failing case: read `failures.md` first (root cause + expected vs
actual), then drill into `<row.id>/verdict.json` for the evaluator's
reasoning, then `candidate.json` for the test-runner's summary. On a
blocked dense row, `candidate_smiles` should be null and the authority
surface is `dense-evidence.json`, not prose.

## How `shards.csv` parallelizes

`shards.csv` maps each case to a parallel group. `P0-primitives` is
the gate shard — if it fails, the full run aborts. `S1`–`S9b` run in
parallel after P0 passes. The orchestrator respects `concurrency: 3`
(per CLAUDE.md "Multi-parent batches") so no more than 3 Playwright
runtimes spawn at once.
