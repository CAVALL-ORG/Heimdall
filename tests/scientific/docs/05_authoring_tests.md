# 05 — Authoring New Tests

A test is a single JSONL row in [manifest.jsonl](../manifest.jsonl).
To add a test you write the row first, then any human-readable mirror
docs you want.

## Row template

```jsonc
{
  "id": "F011",                          // unique, suite-prefixed
  "suite": "fragment_and_ring_tasks",    // see GUIDE.md table
  "parallel_shard": "S1-fragments",
  "parallel_group": "S1",
  "prompt": "Draw <molecule> and return SMILES.",

  // Exactly one of these is non-null:
  "input_smiles": "<optional preload>",  // null if none
  "image_path": null,                    // null if not an image case

  // Ground truth and tolerated answers
  "expected_smiles": "<one canonical example>",
  "expected_canonical_smiles": "<RDKit canonical form of above>",
  "acceptable_canonical_smiles": ["<… every equivalent canonical>"],

  // Optional negative list for `…_plus_isomer_specificity` grading
  "forbidden_canonical_smiles": [],

  "grading": "canonical_smiles",
  "expected_failure": false,

  // The exact contract the execution gate enforces
  "required_trace_events": ["load_smiles", "export_smiles"],

  "notes": "one sentence on what the case proves"
}
```

## Choosing the right `grading`

| Question about the test | Mode |
|---|---|
| Stereo matters? | `canonical_isomeric_smiles` (or `_plus_…`) |
| Radical electron count matters? | `canonical_isomeric_smiles_plus_radical_count` |
| Most common chemistry mistake is the wrong regioisomer? | `canonical_smiles_plus_isomer_specificity` (fill `forbidden_canonical_smiles`) |
| Test is a Ketcher primitive that *must* fire specific MCP tools? | `canonical_smiles_plus_trace` |
| Image case, non-trivial? | `canonical_smiles_from_image_plus_trace` |
| Negative control image? | `safe_failure_plus_no_invented_smiles` |
| Reaction product + RXN export? | `product_canonical_smiles_plus_rxn_export` |
| Canvas-state hidden-input test? | `canonical_smiles_plus_hidden_input_canvas` |
| Round-trip regression — must catch first-guess mistake? | `image_roundtrip_self_corrected` |

## Required trace events — the gate you write yourself

The execution gate fails if any `required_trace_events` entry is
missing from the trace. Be specific. For image cases:

- Trivial image: `["build_from_graph", "render_canvas", "export_smiles"]`.
- Non-trivial image: `["build_from_graph", "render_canvas", "export_smiles"]`.
- Negative image: `["handle_recognition_failure_without_invention"]`.
- Round-trip regression: `["build_from_graph", "render_canvas", "export_smiles"]` with notes describing the expected mismatch/correction class.

Reactions: `["construct_reaction_in_ketcher", "getRxn", "export_smiles"]`.

For most chemistry edits: `["load_smiles", "<the edit op>", "export_smiles"]`.

## Computing the canonical form

```bash
python -c "from rdkit import Chem; \
m = Chem.MolFromSmiles('C/C=C/C'); \
print(Chem.MolToSmiles(m, isomericSmiles=True))"
```

Put the output in `expected_canonical_smiles`. If multiple equivalent
canonicals exist (resonance contributors, salt vs hydrate writeups),
canonicalize each and add them all to `acceptable_canonical_smiles`.

## Adding an image fixture

For an *academic* or *Wikipedia* image:

1. Add a row to [images/SOURCES.md](../images/SOURCES.md) with:
   citation, license, URL, expected SMILES, target filename.
2. Add a row to
   [../../ketcher/image-to-smiles/image_sources.jsonl](../../ketcher/image-to-smiles/image_sources.jsonl).
3. Run `npx tsx scripts/download_academic_images.ts` to fetch.
4. Add the test row to the appropriate `manifest.jsonl`
   (scientific: `tests/scientific/manifest.jsonl`; image-to-smiles:
   `tests/ketcher/image-to-smiles/manifest.jsonl`) referencing the
   local image path.

For a *synthetic* image rendered from Ketcher (clean / noisy / adversarial):

1. Use `render_canvas` against a known SMILES, save the PNG under
   `images/<category>/<slug>.png`.
2. Add the test row.

The runner does not re-verify that the image file matches the
ground-truth SMILES; that is the fixture author's job. Once committed,
the file is the contract.

## Promoting a case from "draft" to the run

A case is part of the run when its `parallel_shard` matches one in
[shards.csv](../shards.csv). Add the shard row if the case introduces
a new shard, otherwise just incrementing the count suffices.

## Running just your new case

Open a Claude Code session at the repo root and type:

```
Run row F011 per the runbook
```

Or via the slash command: `/test F011`. The orchestrator runs the
single row with a fresh `run-id` under
`outputs/tests/agent-orch/<run-id>/`. Re-running just overwrites
that row dir if you reuse the `run-id`; otherwise a new dir is
created.
