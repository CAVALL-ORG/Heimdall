# 04 — Image Verification: current contract

`.claude/skills/ketcher-image-rebuild/SKILL.md` is the sole normative
contract. This suite note only summarizes how verification and grading
consume it.

This suite does not trust first-pass image transcription. The current
protocol therefore requires:

1. Pixel transcription into a direct `GraphIntent` (the one input shape),
   never `load_smiles`.
2. `validate_graph` preflight rounds with `crop_source_image` zooms on
   regions the preflight names, until preflight passes.
3. `build_from_graph` (gated on a passing preflight on the same graph).
   Optional one local-correction retry.
4. `render_canvas` + `export_smiles`, or call `refuse` if transcription
   fails.

**Row terminal:** one of two MCP tool calls — `export_smiles` (final
message ends with `SMILES: <line>`) or `refuse` (no SMILES line; the
runtime classifies the reason from session evidence). Prose-only
termination is unfinished.

## Verification invariants

`VISION_CHECK` and the evaluator compare these source-image properties:

| Invariant | Why it matters |
|---|---|
| Same heavy-atom set | catches element-swap hallucinations (Cl ↔ Br, N ↔ C) |
| Same connectivity (ring system + substituents) | catches regiochemistry errors (ortho ↔ para) |
| Same formal charges and stereo (when visible) | catches charge / E-Z / R-S flips |
| Same disconnected-fragment count | catches missed counter-ions in salts |

## When image verification is mandatory

The execution gate requires `render_canvas` for every positive-control
image row. There is no longer a separate normative
`vision_consistency_verified` guess-and-render loop; the image-rebuild
tool surfaces (`validate_graph`, `crop_source_image`, `build_from_graph`,
`render_canvas`, `export_smiles`, `refuse`) plus the grader's audit
gates carry that role.

| Trivial criteria | Round-trip optional? |
|---|---|
| ≤ 6 heavy atoms, no charge, no stereo, single ring | optional |
| `benzene`, `pyridine`, `furan`, `thiophene` | optional |
| Negative controls (N001–N004) | not applicable — refuse before load |

All other cases (anything with charges, stereo, multi-fragment, fused
rings, > 12 heavy atoms, or any "noisy"/"adversarial" tag) must show
the round-trip events.

## Three intentional regression tests (S13-roundtrip)

These cases exist *specifically* to prove the loop bites. They use
ambiguous source images where the most likely first-guess is wrong;
the agent must catch the mismatch and self-correct.

| ID | Image | First-guess mistake the loop catches |
|---|---|---|
| RT001 | [images/clean/cis_stilbene_clean.png](../images/clean/cis_stilbene_clean.png) | E/Z confusion vs trans-stilbene |
| RT002 | [images/noisy/cropped_pyridinium.png](../images/noisy/cropped_pyridinium.png) | Charge missed — pyridine instead of pyridinium |
| RT003 | [images/clean/sodium_acetate_clean.png](../images/clean/sodium_acetate_clean.png) | Counter-ion missed — acetate instead of sodium acetate |
| RT004 | [images/clean/glycine_zwitterion_clean.png](../images/clean/glycine_zwitterion_clean.png) | Neutral glycine instead of zwitterion |

Grading mode: `image_roundtrip_self_corrected` (see
[docs/03_grading.md](03_grading.md)).

## Authority model

- The skill defines what the runner may do.
- The runtime emits trace events + final assistant text rendering
  (TRACE lines, CROP_RATIONALE lines, free-form prose).
- The grader parses those surfaces via chemistry/execution/integrity/
  stereo gates plus the audit gates documented in
  [03_grading.md](03_grading.md).
- The evaluator uses image comparison only on top of that deterministic
  floor.

This file is subordinate to the skill and runner prompts; if they ever
disagree, follow the skill.

## Known limitations

- `vision_compare` is the agent's own judgment, so a confidently wrong
  agent can still pass a wrong-and-wrong-but-matching loop. The S13
  regression cases catch this for known failure modes, but they aren't
  exhaustive.
- `render_canvas` uses Ketcher's default layout, which differs from
  paper layouts. The agent compares *structures*, not pixel-level
  similarity. The skill contract emphasizes the four invariants.
- Three iterations are a hard cap. Some agents will refuse on
  legitimate but unusual structures rather than burn iteration budget.
  That is a known trade-off; lifting the cap risks unbounded retry
  loops on out-of-distribution inputs.
