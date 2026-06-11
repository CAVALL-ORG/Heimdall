# 03 — Grading Modes

A test row's `grading` field selects which chemistry-gate algorithm
runs. All chemistry comparisons normalize through RDKit canonical
isomeric SMILES — never raw string equality. The execution gate is
always required and never optional.

## Authority model — grader vs evaluator

The grader (`runner/grader.py`) is the **deterministic floor**. It
runs the gates that can be decided from on-disk artifacts (canonical
SMILES, trace events, integrity, stereo). The evaluator subagent
(`runner/prompts/evaluator.md`) owns the final verdict and chooses
PASS/FAIL based on row type:

| Row type | `verdict_owner` | Verdict source |
|---|---|---|
| Non-image (chemistry, mechanical, reaction, …) | `"grader"` | `deterministic_pass` is the verdict — evaluator does not second-guess |
| Image rebuild (`image_roundtrip_evaluator` / `skill: ketcher-image-rebuild`) | `"evaluator"` | Evaluator vision-compares the rendered candidate against the original image; `certified` short-circuits the compare to canonicalization-erased features only |

The grader cannot see the image and therefore cannot decide image-row
verdicts on its own. The evaluator can; image-truth grading
(per CLAUDE.md "Grading framework — image-truth, not
chemistry-equivalence") requires it.

For all image rows, the only authority-bearing SMILES source is a
trace-event `export_smiles` call following a successful `build_from_graph`.

The grader composes a set of deterministic gates whose membership
changes as the protocol evolves; see `grader.py` `main()` for the
current composition. This doc does not enumerate the gates because
the list drifts.

`vision_fingerprint_gate` is **advisory only**. It compares the
agent's `source=` readback against the canvas-computed
`VisionCheckCandidate` sidecar that `translator.ts` wrote to
`KETCHER_FINGERPRINT_DUMP_DIR` during the build (Stage 2 of
PLAN-a004-class-robustness-2026-05-22). Its failures land in
`evaluator_notes`, not in `deterministic_pass`. Independent
cross-checking of `expected_features` moves to `audit_manifest.py`
(offline) and the evaluator's vision compare.

`beyond_protocol_gate` reports a row-level refusal class for
stereocenters the agent flagged as `stereo_label: 'beyond_protocol'`
(axial chirality, allene, chair-without-coords, hypervalent,
indigo-indeterminate). Its presence does NOT change
`deterministic_pass`; refusal is distinct from pass/fail. Row reporters
must surface the refused atom ids and reasons so production users see
the partial answer rather than a silent pass.

## Grading modes

### `canonical_smiles`

Default for chemistry tasks without stereo. Compares
`Chem.MolToSmiles(mol, isomericSmiles=False, canonical=True)`.

Use when stereochemistry, formal charge, and radical state are not
under test (e.g. ring construction, simple functional-group swap).

### `canonical_isomeric_smiles`

Compares with `isomericSmiles=True`. Required for any case where E/Z,
R/S, or wedge/dash matter. The default for the `stereochemistry` suite.

### `canonical_smiles_plus_trace`

`canonical_smiles` + the execution gate (which is always on). Tagged
explicitly when the test is a primitive whose entire point is to
exercise a specific MCP tool.

### `canonical_isomeric_smiles_plus_radical_count`

`canonical_isomeric_smiles` + total radical electron count must equal
the expected count. RDKit's `Descriptors.NumRadicalElectrons(mol)` is
the truth value. Catches the case where the agent draws a closed-shell
isomer that happens to have the same heavy-atom skeleton as the radical.

### `canonical_smiles_plus_isomer_specificity`

`canonical_smiles` + reject any canonical SMILES present in the
**`forbidden_canonical_smiles`** field. For "make the *para* isomer",
where producing the ortho is the most common chemistry mistake; the
ortho canonical SMILES is listed as forbidden and grading fails even
if it canonicalizes cleanly.

### `canonical_isomeric_smiles_plus_radical_count` (with `acceptable_canonical_smiles`)

When multiple resonance contributors are all correct (allyl radical can
be `[CH2]C=C` or `C=C[CH2]`, canonicalize differently), the list of
acceptable canonicals is given and any match passes.

### `canonical_smiles_from_image_plus_trace`

`canonical_smiles` + the execution gate **plus** mandatory image
rebuild events. Image rows must use the `ketcher-image-rebuild`
contract (`build_from_graph`, `render_canvas`, `export_smiles`) rather
than a `load_smiles` guess-and-render loop.

### `product_canonical_smiles_plus_rxn_export`

For reaction tasks. Compares the *product* SMILES (after splitting on
`>>`) AND requires `construct_reaction_in_ketcher` + `getRxn` events.

### `canonical_smiles_plus_hidden_input_canvas`

For S7-canvas tests. The prompt does not name the input molecule; the
harness preloads it. Grading checks the expected canonical SMILES AND
the trace shows the agent did NOT call `load_smiles` with a fresh
SMILES string (i.e. it inspected the existing canvas via `get_state`
or `get_annotated_state` first).

### `safe_failure_plus_no_invented_smiles`

For negative-control image tests. PASS criteria:

1. Trace contains NO `export_smiles` call.
2. Final assistant text contains one of the refusal phrases
   (see [grader.py refusal list](../runner/grader.py)).
3. Trace MAY contain `vision_identify_structure` followed immediately
   by `handle_recognition_failure_without_invention`.

The grader is conservative: silent non-answer fails. The agent must
explicitly say it cannot recognize a molecule.

### `image_roundtrip_self_corrected`

For S13-roundtrip regression tests. Constructed so the *first* vision
identification is wrong (chosen ambiguous source image), and the
agent must self-correct via the closed loop. PASS criteria:

1. Trace contains at least one `vision_consistency_mismatch` event.
2. Trace contains a subsequent `vision_consistency_verified` event.
3. Final canonical SMILES matches expected.

This is the test that proves the round-trip protocol is actually
defending against hallucinations, not merely going through the motions.

## Implementation

See [runner/grader.py](../runner/grader.py). The grader is invoked as:

```bash
python runner/grader.py \
  --row '<jsonl-row>' \
  --trace runner/results/<run_id>/<id>.trace.json \
  --transcript runner/results/<run_id>/<id>.transcript.json \
  --out runner/results/<run_id>/<id>.grade.json
```

The output JSON looks like (post 2026-05-20 schema):

```json
{
  "id": "I001",
  "deterministic_pass": true,
  "verdict_owner": "evaluator",
  "certified": true,
  "reason": "deterministic_pass",
  "chemistry_gate": {
    "pass": true,
    "mode": "image_roundtrip_evaluator",
    "iso_match": true,
    "flat_match": true,
    "actual_canonical": "c1ccccc1"
  },
  "execution_gate": { "pass": true, "matched_events": ["build_from_graph", "render_canvas", "export_smiles"], "missing_events": [] },
  "integrity_gate": { "pass": true, "forbidden_observed": [] },
  "stereo_gate":    null,
  "vision_fingerprint_gate": { "pass": true, "advisory": true, ... },
  "beyond_protocol_gate": null,
  "final_smiles": "c1ccccc1"
}
```

Field reference:

- `deterministic_pass` — AND of `chemistry_gate.pass`,
  `execution_gate.pass`, `integrity_gate.pass` (when present),
  `stereo_gate.pass` (when present). The evaluator emits PASS for
  non-image rows if and only if this is True.
- `verdict_owner` — `"grader"` for non-image rows, `"evaluator"` for
  image-rebuild rows. The evaluator subagent consults this to pick
  branch A vs C in its decision procedure.
- `certified` — `chemistry_gate.iso_match AND integrity_gate.pass`. When
  True, the evaluator's vision compare for image rows may skip the
  features canonicalization already proves (connectivity + stereo +
  charge) and limit the compare to tautomer / drawn-H / drawn bond
  position / isotope / multi-fragment salts.
- `vision_fingerprint_gate.advisory: true` — explicitly tagged so
  consumers do not feed it into pass logic. Pre 2026-05-20 it was a
  hard gate; that turned out to wrongly fail correct candidates whose
  runner self-report had cosmetic flaws. Stage 2 of
  PLAN-a004-class-robustness-2026-05-22 swapped the candidate source
  from RDKit-recompute-from-`final_smiles` to canvas-computed sidecar,
  closing the rubber-stamp channel structurally; the gate is still
  advisory because the evaluator subagent owns the image-row verdict.
- `beyond_protocol_gate` — null on the overwhelming majority of rows.
  When present, carries `{verdict: "refuse-with-reason", refused: [...]}
  ` with the agent-flagged atom ids and reasons. Does NOT feed
  `deterministic_pass`.
- `evaluator_notes` — short strings prefixed `vision_advisory:` (gate
  failures) or `beyond_protocol:` (refusal entries) that surface those
  signals to the evaluator's narrative.

## Adding a grading mode

1. Add a new branch in `grader.py`'s dispatch table.
2. Update this doc with a new section.
3. Add at least one regression case in
   `tests/scientific/manifest.jsonl` that exercises the new mode.
