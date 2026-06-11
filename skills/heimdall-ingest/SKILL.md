---
name: heimdall-ingest
description: |
  Load molecules into Ketcher from SMILES or molfile and return canonical
  exports + atom/bond tables. Image input is NOT handled here — for images,
  invoke heimdall-image-rebuild, which reconstructs the molecule by graph
  primitives so Ketcher (not free-styled SMILES) is the source of truth.
---

# Ketcher Ingest Skill

Use when the user asks to load a molecule from SMILES or molfile and return
normalized exports.

Tool reference: [../_shared/reference-api.md](../_shared/reference-api.md).
State / atom-row / bond-row shapes: [../_shared/reference-state-model.md](../_shared/reference-state-model.md).

## Hard rule — agent never authors SMILES

This skill loads SMILES / molfiles **supplied by the caller**, and reports
back what `export_smiles` / `get_state` say. The SMILES the agent passes
to `load_smiles` must be either (a) verbatim from the caller's request,
or (b) loaded from a file path the caller named. The agent does not
"clean up" a SMILES, "canonicalize in head", "use the more standard
form", or substitute its own remembered SMILES for the caller's input.

If a caller hands the agent `c1ccccc1` and asks for the canonical form,
the agent calls `load_smiles("c1ccccc1")` then `export_smiles` and
reports whatever Ketcher returned. The agent does not type
`c1ccccc1` itself based on "the caller probably meant benzene".

See the root [../../CLAUDE.md](../../CLAUDE.md) Core Principle.

## SMILES workflow

1. `load_smiles({ "smiles": "<caller-supplied string>" })`
2. `get_state({})` — read back `smiles`, `ket`, `atoms[]`, `bonds[]`
3. Optionally `export_smiles({})` for the canonical form.
4. Return the requested fields. Every returned SMILES came from
   `get_state` / `export_smiles`, not from the agent's text.

## Molfile workflow

1. `load_molfile({ "molfile": "<caller-supplied string>" })`
2. `get_state({})`
3. Return the requested fields.

## GraphIntent workflow

When the caller supplies a structured `GraphIntent` JSON (atoms +
bonds + rings + counts; schema in
[../_shared/graph-intent-schema.md](../_shared/graph-intent-schema.md)),
load it via `build_from_graph` instead of `load_smiles` / `load_molfile`:

1. `build_from_graph({ graph: <caller-supplied GraphIntent>, validate_counts: true })`
2. `get_state({})` — read back `smiles`, `atoms[]`, `bonds[]`.
3. Optionally `export_smiles({})` for the canonical form.

`build_from_graph` is a Ketcher-authored path (same trust model as
`load_smiles`): the caller supplies the structural intent, the
translator commits the build atomically with revert-on-mismatch, and
the SMILES the agent returns comes from `export_smiles`. Image input is
NOT handled here — for images, invoke `heimdall-image-rebuild`, which
emits a GraphIntent of its own.

## Image input — delegate to heimdall-image-rebuild

Never call `load_smiles` with a SMILES the agent typed from looking at
an image — even if the molecule is "obviously benzene". That is the
free-styling path the repo's chemistry guardrail forbids (see CLAUDE.md).
The supported image path is
[../heimdall-image-rebuild/SKILL.md](../heimdall-image-rebuild/SKILL.md),
which is now strict: it bans `load_smiles` outright for image tasks and
requires `add_fragment` + primitives.

## Guardrails

- Use explicit IDs from `atoms[]` / `bonds[]`. No GUI / coordinate actions.
- Do not infer chemistry validity.
- Keep responses mechanical and explicit.

Links: [examples.md](examples.md) ·
[../_shared/reference-api.md](../_shared/reference-api.md) ·
[../_shared/reference-state-model.md](../_shared/reference-state-model.md).
