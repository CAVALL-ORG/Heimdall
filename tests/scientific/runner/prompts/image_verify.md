# Image round-trip verification template

Reference shape for image rows. `ketcher-image-rebuild` is authoritative
— invoke that skill first; this template is a quick-reference for the
orchestrator's grader/evaluator path. The full agent contract lives in
[.claude/skills/ketcher-image-rebuild/SKILL.md](../../../../.claude/skills/ketcher-image-rebuild/SKILL.md).

**Follow what SKILL.md says.** Verify the row terminated with one of the
two terminal MCP tool calls (`export_smiles` or `refuse`). Vision-compare
the rendered canvas to the source.

## Invariants the evaluator audits

| Invariant | Violation |
|---|---|
| Pixel-only evidence | Using filename, caption, identity, remembered scaffold, SSSR, CIP, or R/S as source evidence. Chemistry-expectation manifest fields (`expected_canonical_smiles`, `expected_features.*`, `inchi_key`) are stripped from the prompt; if anything leaks through, the agent ignores it. |
| Complete visible graph | Exporting only a readable fragment while visible regions remain omitted. |
| Topology fails closed | Leaving topology-defining fields (`segment_endpoint`, `loop_membership`, `loop_relationship`, `attachment_anchor`) as `source_limited` on an export path — only stereo-local fields may be `source_limited`. |
| Stereo path | Authoring R/S, `@`/`@@`, `/`/`\`, CIP priority directly — wedge primitive is the default; backend R/S escape is reserved for rare saddle-junction cases. |
| Shorthand handling | Decomposing `Me`/`OMe`/`Ph`/`Bn`/`Ac`/etc. on the agent side — the agent keeps shorthand literal; the backend decomposes via a deterministic table. |
| Ketcher SMILES | Hand-authoring or loading a guessed SMILES. `load_smiles` / `load_canonical` / `add_fragment` are forbidden on image rebuild rows. |
| Crop rationale | Naming a scaffold in `CROP_RATIONALE` — pixel-cue only. |
| Row terminal | Ending the row with prose only — every row ends with `export_smiles` or `refuse`. |

## Trace shape

Success:
```text
TRACE: Skill_invocation
TRACE: Read
TRACE: validate_graph
TRACE: crop_source_image
TRACE: Read
TRACE: CROP_RATIONALE
TRACE: validate_graph
TRACE: build_from_graph
TRACE: render_canvas
TRACE: export_smiles
SMILES: <ketcher export>
```

Refusal:
```text
TRACE: Skill_invocation
TRACE: Read
TRACE: <ops performed>
TRACE: refuse
```
No SMILES line on refusal. The runtime classifies the reason from
session evidence; the agent's prose is free-form pixel-grounded
description.
