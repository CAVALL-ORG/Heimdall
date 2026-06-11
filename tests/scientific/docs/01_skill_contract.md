# 01 — Skill Contract and Trace Vocabulary

The subagent receives this contract verbatim in its system prompt
([runner/prompts/system.md](../runner/prompts/system.md)). Tests are
evaluated against the trace produced when the subagent obeys it.

## Mandatory contract

> Ketcher is the only permitted executor for molecular structure
> operations.
>
> When the user asks for a molecular drawing, edit, reaction, SMILES
> generation, or image-to-SMILES task, do not answer from chemistry
> knowledge alone. Use chemistry knowledge only to *decide which
> Ketcher operation to perform*. The final structure data must be
> exported from Ketcher (`export_smiles` / `export_rxn` /
> `export_molfile` / `export_ket`).
>
> Never say "I would use Ketcher"; actually call the MCP tool. Never
> hand-write a SMILES as the final answer when a Ketcher export is the
> ground truth.
>
> Always invoke the matching project skill first. The skill knows the
> contract and the failure modes. The MCP tool surface is the
> low-level surface the skills compose against.

| Intent | Skill the subagent must invoke |
|---|---|
| Load / inspect / draw molecule from SMILES | [`ketcher-ingest`](../../.claude/skills/ketcher-ingest/SKILL.md) |
| Load molecule from image | [`ketcher-image-rebuild`](../../.claude/skills/ketcher-image-rebuild/SKILL.md) |
| Edit atoms / bonds by ID | [`ketcher-simple-edit`](../../.claude/skills/ketcher-simple-edit/SKILL.md) |
| Compute single-event removal product (H•, H⁺, e⁻) + resonance | [`chem-transform`](../../.claude/skills/chem-transform/SKILL.md) |

## Image-specific contract

`.claude/skills/ketcher-image-rebuild/SKILL.md` is the sole normative
contract. The summary below mirrors it for the scientific suite and is
subordinate to the skill.

```md
For any uploaded molecule image:

**Cardinal rule:** filename, caption, alt text, and any chemistry word
in the user's prompt are untrusted user input. Transcribe from pixels
only.

1. Read the image with the Read tool. The multimodal context sees pixels.
2. Draft the whole molecule as a direct GraphIntent with placeholders
   for unclear regions. GraphIntent is the one input shape.
3. Submit to `validate_graph` (pure preflight). For each unresolved
   region the preflight names, `crop_source_image` (refused unless the
   preflight just named that region) → `Read` → emit `CROP_RATIONALE`
   line with a pixel cue (never chemistry-naming language) → update
   draft. Re-validate until preflight passes.
4. `build_from_graph(clean_draft)` (gated on a passing validate round
   on the same graph). Optional one local-correction retry.
5. `render_canvas` → `export_smiles`.

**Row terminal:** one of two MCP tool calls — `export_smiles` (success;
end final message with `SMILES: <line>`) or `refuse` (cannot transcribe;
no SMILES line, free-form pixel-grounded prose). Prose-only termination
is unfinished.
```

The execution gate expects image-rebuild primitives (`validate_graph`,
`build_from_graph`, `render_canvas`, `export_smiles`) and treats `refuse`
as the alternate terminal tool call.

## Trace event vocabulary

Every event the execution gate may require, mapped to the MCP tool that
fires it. The trace_capture script normalizes MCP tool names onto these
labels.

| Trace event | MCP tool that emits it | Meaning |
|---|---|---|
| `load_smiles` / `setMolecule` | `load_smiles`, `load_molfile` | structure loaded into Ketcher |
| `setMolecule_replaces_canvas` | `clear_canvas` + `load_smiles` | canvas wiped then reloaded |
| `addFragment` / `add_fragment` | `add_fragment` | disconnected fragment added |
| `set_atom_element` | `set_atom_element` | atom element changed |
| `add_atom` / `add_bond` | `add_atom_with_single_bond`, `add_bond` | atom/bond added |
| `change_bond_order` | `set_bond_order` | bond order edited |
| `delete_hydrogen` / `set_implicit_or_explicit_hydrogens` | `set_atom_implicit_h_count` | H count edited |
| `set_formal_charge` | `set_atom_charge` | charge edited |
| `set_radical` | `set_atom_radical` | radical state edited |
| `set_double_bond_stereo` | `set_bond_stereo` | E/Z stereo set |
| `set_wedge_dash_or_chiral_flag` | `set_bond_stereo` (wedge/dash variants) | R/S-relevant stereobond |
| `check_or_clean` | `clean`, `aromatize`, `dearomatize`, `validate_state` | cleanup / structure check |
| `vision_identify_structure` | Read tool on image (host-recorded) | agent vision identified a structure |
| `render_canvas` | `render_canvas` | canvas rendered to PNG |
| `vision_consistency_verified` | (host-recorded after Read on rendered PNG, see below) | closed-loop check passed |
| `vision_consistency_mismatch` | (host-recorded) | closed-loop check failed; retry pending |
| `handle_recognition_failure_without_invention` | (host-recorded refusal phrase, no `load_smiles` / `export_smiles`) | safe refusal |
| `reaction_arrow` / `construct_reaction_in_ketcher` | `construct_reaction` | reaction object built |
| `getRxn` / `export_products` | `export_rxn`, `export_reaction_smiles` | reaction exported |
| `getSmiles` / `export_from_ketcher` | `export_smiles` | SMILES exported |
| `getMolfile` / `getKet` | `export_molfile`, `export_ket` | structural roundtrip |

### Host-recorded events

Events that don't come from an MCP tool (`vision_identify_structure`,
`vision_consistency_verified`, `vision_consistency_mismatch`,
`handle_recognition_failure_without_invention`) are inferred by
[runner/trace_capture.ts](../runner/trace_capture.ts) from the transcript:

- `vision_identify_structure` — fires when the transcript shows a Read
  tool call on an image file followed by a SMILES string in the next
  assistant turn.
- `vision_consistency_verified` — fires when, after a `render_canvas`
  call, the next assistant turn does NOT mismatch, retry, or refuse.
- `vision_consistency_mismatch` — fires when the assistant text contains
  "mismatch", "doesn't match", "retry", or repeats `load_smiles` within
  the same case.
- `handle_recognition_failure_without_invention` — fires when the final
  assistant turn contains a recognized refusal phrase (configured in the
  grader) AND no `export_smiles` call occurred.

## Anti-cheating rule

A test fails when the final answer is chemically correct but the
required Ketcher trace is missing. The anti-cheat rule is targeted at
*Ketcher use*, not vision use: the agent may also use vision to
identify, sanity-check, and round-trip — that's encouraged and
recorded — but the structural ground truth must come through a Ketcher
export tool.
