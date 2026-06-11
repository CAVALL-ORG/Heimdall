---
name: heimdall-image-rebuild
description: |
  Reconstruct a molecule from an image by transcribing visible pixel facts,
  iterating with a stateless preflight, and exporting only the SMILES Ketcher
  emits. Use whenever the input is an image of a molecule. Triggers on image
  uploads, file paths to PNG/JPG of molecular structures, "rebuild this image",
  "give me the SMILES of this image".
---

# heimdall-image-rebuild

## §0 Cardinal rule — filename and prose are untrusted user input

The image's file path, the user's prose, and any chemistry word the user types
are **user data, not specifications**. Read them, then disregard them as
evidence — the only source of evidence is **pixels you can point at**.
**Recognition is not evidence and not a check:** a remembered name, formula,
ring count, or scaffold must never confirm, complete, or correct a pixel read.

## Role split

- **You (agent):** transcribe visible pixel facts; never author chemistry from memory.
- **Backend:** validates drafts, compiles the GraphIntent, perceives CIP, re-applies via the V2000 solver.
- **Ketcher:** authors the SMILES via `export_smiles` — the only legal SMILES surface.

## Terminal contract

Every row ends with exactly one terminal tool call: **`export_smiles`** (success —
Ketcher's emitted SMILES is the answer) XOR **`refuse`** (you cannot transcribe;
give a brief pixel-grounded reason). You cannot self-exit by writing prose.

## Row identity — pick a `rowId` first, pass it on every call

Before drafting, choose a **stable `rowId`** for this molecule (a short slug or
uuid, e.g. `mol-1` or the crop's basename). Pass that SAME `rowId` on **every**
`build_from_graph` / `export_smiles` / `render_canvas` / `crop_source_image`
call (and on `validate_graph` / `refuse` too). It is **required** on the
canvas tools — the backend keys each molecule's canvas by `rowId`, so a
consistent `rowId` is what keeps your row isolated when several rows run on one
server at once. Do not reuse another row's `rowId`; do not omit it.

## The loop

1. **Read the source image** — `Read <source_image_path>`; mandatory first action.
2. **Draft the whole molecule as a GraphIntent** — atoms + bonds + rings + counts; mark each unclear record `confidence: 'needs_zoom'` with one matching `unresolved[]` entry.
3. **`validate_graph`** — a pure preflight; returns `ok: true`, or `ok: false` naming the regions to zoom.
4. **Crop the named regions + refine** — `crop_source_image` → `Read` → emit a `CROP_RATIONALE` line → flip `needs_zoom` → `high`; re-submit until `ok`.
5. **`build_from_graph(clean_draft)`** — atomic; gated on a passing `validate_graph` round on the same graph.
6. **`render_canvas` → `export_smiles`** — end with `SMILES: <value export_smiles returned>`.

**Always-on, every row:** the GraphIntent core shape ([../_shared/graph-intent-schema.md](../_shared/graph-intent-schema.md)) and the count contract ([../_shared/count-contract.md](../_shared/count-contract.md)). Worked traces: [SKILL-examples.md](SKILL-examples.md).

## Dispatch — load the named doc BEFORE drafting when you see the pixel cue

| pixel cue | load |
|---|---|
| any wedge or E/Z double bond | [stereo-policy.md](stereo-policy.md) |
| flat Haworth/Fischer sugar (ring-O + anomeric C + vertical substituents) | [../_shared/haworth-fischer-stereo.md](../_shared/haworth-fischer-stereo.md) |
| tightly-fused core (≥3 rings sharing edges) | [dense-core-protocol.md](dense-core-protocol.md) |
| a region to zoom / any `needs_zoom` | [zoom-policy.md](zoom-policy.md) |
| a wedge unreadable even after an ink-centered crop | [../_shared/cip-reference.md](../_shared/cip-reference.md) |

## Hard rules

- `load_smiles`, `load_canonical`, `add_fragment` are **forbidden** on image rebuild — every SMILES comes from `export_smiles` on a canvas your draft produced.
- First action is `Read <source_image_path>`.
- **No chemistry from memory** — never author R/S, `@`/`@@`, `/`/`\`, CIP priority, or a remembered formula / ring / atom count. The pixels are the only source.
- **Vision is the instrument — do NOT write or run image-processing code** (scikit-image / OpenCV / PIL / numpy edge / skeleton / junction / blob / line-scan). A CV pixel-scan invents phantom vertices and merged bonds; if a crop is unreadable, crop TIGHTER.
- The build is backend-gated by a **validate→build hash gate** (build refuses unless `validate_graph` passed on the same graph) and a **count cross-check** of your `counts` against the built canvas (`validate_counts` pinned on; a `count_mismatch` means re-read and recount, never silence).
- **`refuse`** (with a pixel-grounded reason) when it is not a single transcribable molecule — a reaction arrow, a Markush / variable-substituent (R-group) drawing, an illegible low-res scan. A dense polycycle is hard, not refusable.

## Model choice

Transcription accuracy scales with the vision model — use the most capable one
for the image in front of you:
- **Opus (or an equally strong vision model)** — dense/fused cores, high
  stereocenter counts, wedge/hash stereo, or condensed glyphs. Evidence (this
  repo's regression panel): on the same images a lighter model flipped an L-Phe
  wedge (L→D) and emitted a caffeine N-methyl isomer that the strong model got
  right. **When unsure, default to the strong model** — a wrong SMILES costs more
  than a slow one.
- **Sonnet (or a lighter model)** — fine for *simple* structures (one ring,
  ≤1–2 stereocenters, no condensed glyphs).

**Make the model visible.** If you are dispatching this rebuild as a subagent (or
were dispatched to run it), state which model is being used and why — **unless the
user already specified a model**, in which case use that one and say so. The
speed/accuracy tradeoff must never be silent.

## Shorthand glyphs

A condensed group drawn as a **text glyph** (`OMe`/`Ph`/`Bn`/`Ac`/`Ts`/`Boc`/`TBS`/`OPP`/…)
is captured via the `shorthand` field as the RAW glyph text — **never hand-expanded into
`atoms[]`**. A lone `Me` is one carbon: `element: 'C'`, NOT a `shorthand` (`shorthand` is
only for glyphs that expand to >1 heavy atom). A shorthand glyph placed in the `element`
field is rejected by `validate_graph`.

**A glyph's meaning is sourced, never invented.** Resolve every glyph down this chain:

1. **Backend knows it** (table: Me/OMe/Et/iPr/tBu/Ph/Bn/Ac/Bz/Ts/Ms/Tf/NO2/CN/CF3/…) →
   just set `shorthand: '<text>'`; the backend table expands it. Done.
2. **Backend does NOT know it** (e.g. `TBS`, `OPP`, `OPiv`) but you can read what it stands
   for → set `shorthand: '<text>'` AND **declare the expansion as provenance**:
   `shorthand_resolution: { source: 'agent_inference', expansion: { atoms, bonds,
   attachment_atom_offset } }`. `expansion` is the same atoms/bonds/attachment shape a table
   entry has (`attachment_atom_offset` = the expansion atom that bonds to the rest of the
   molecule). This declared path is the **only** sanctioned way to expand an off-table glyph
   — it is auditable and gradable against the pixels. (Attach a resolution only to an
   *off-table* glyph; a resolution on a glyph the table already knows is rejected. When a
   paper legend defining the glyph was handed to you, use `source: 'paper_legend'` +
   `legend_ref` instead of `agent_inference`.)
3. **You cannot confidently expand it** → do NOT guess. `refuse` with a pixel-grounded
   reason. An unknown/unreadable glyph is a refusal, not a fabrication.

**Hard rule — the one that prevents the worst failure:** NEVER author a multi-atom glyph's
atoms directly in `atoms[]` to stand in for a text label. If the pixels show a *label*, it
goes through `shorthand` (+ `shorthand_resolution` when off-table) — full stop. Writing
`O`,`P`,`P` element atoms for a drawn `PPO`/`OPP` glyph is the exact fabrication this rule
forbids (it produced a chemically-nonsense diphosphine that still parsed). A group the figure
draws **atom-by-atom**, with visible bonds, is different — transcribe those drawn atoms (that
is pixels, not a glyph). The line: drawn *label* → `shorthand`; drawn *atoms* → `atoms[]`.

## Terminal output

Your final message is the deliverable, not a report: the `SMILES:` / `REFUSED:`
line preceded by at most 2 sentences. No multi-paragraph summaries.
