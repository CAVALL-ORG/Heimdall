# Ketcher MCP Tool Reference

Single source of truth for every MCP tool the `heimdall-*` skill layer
exposes. Tool implementations live in `server/src/mcp/tools/`; the
runtime they call lives in `server/src/mcp/runtime.ts` and
`server/src/ui/bridge.ts`.

**Field-name confusion?** Same concept has different field names at
each layer (GraphIntent vs MCP write vs bridge call vs `getState()` row).
Writes use `atomId1/atomId2`, `element`, etc.; reads use `beginAtomId/endAtomId`,
`label`. The drift is intentional and documented; do not retry with the
read-side names.

## Ingest

### `load_smiles`
- Input: `{ "smiles": "..." }`
- Loads a molecule into the editor, replaces canvas content.

### `load_molfile`
- Input: `{ "molfile": "..." }` (V2000 or V3000)
- Parses the molfile, replaces canvas content. Symmetric to `export_molfile`.

### `add_fragment`
- Input: `{ "smiles": "..." }`
- Adds a fragment to the canvas without clearing existing content. Used
  by `heimdall-image-rebuild` for canonical sub-units.

### Image input
The MCP surface intentionally exposes no image-loading tool. For an
image input, invoke `heimdall-image-rebuild`, which uses agent vision to
identify features and then builds the molecule via graph primitives.
Imago OCR is not available because it hallucinates SMILES on
non-chemistry inputs (reaction arrows, formula text, spectra).

## State

### `get_state`
- Input: `{ "includeMolfile": false }` (optional)
- Returns: `{ smiles, ket, molfile, isEmpty, isReaction, hasExportFailure,
  exportErrorMessage, atoms[], bonds[] }` — see `reference-state-model.md`
  for the row shapes.

### `get_annotated_state`
- Input: `{}`
- Returns the same shape as `get_state` plus per-atom (`implicitH`,
  `lonePairs`, `aromatic`, `inRing`, `degree`, `neighborAtomIds`,
  `neighborBondIds`, `explicitValence`, `computedValence`) and per-bond
  (`aromatic`, `inRing`, `conjugationGroupId`) annotations, plus a
  top-level `conjugationGroups[]` array.

### `render_canvas`
- Input: `{ "showAtomIds": false, "format": "png", "backgroundColor":
  "#ffffff" }` (all optional)
- Rasterizes the canvas to PNG/SVG, writes a temp file, returns
  `{ path, format, showAtomIds, bytes }`. Use the Read tool on the
  returned path to view the image.

## Edits (atom/bond mutations)

### `set_bond_order`
- Input: `{ "bondId": number, "order": 1|2|3|4 }`

### `set_atom_charge`
- Input: `{ "atomId": number, "charge": -4..4 }`

### `set_atom_radical`
- Input: `{ "atomId": number, "radical": 0..3 }` (encoding non-linear)

### `set_atom_element`
- Input: `{ "atomId": number, "element": "N" | ... }`

### `set_atom_explicit_valence`
- Input: `{ "atomId": number, "valence": number | null }`

### `set_atom_implicit_h_count`
- Input: `{ "atomId": number, "count": number | null }`

### `set_bond_stereo`
- Input: `{ "bondId": number, "stereo": "cis"|"trans"|"up"|"down"|"none" }`

### `add_atom_with_single_bond`
- Input: `{ "element": string, "atomId": number }` — extends an existing
  atom by one heavy atom with a single bond.

### `delete_atom`
- Input: `{ "atomId": number }`

### `add_bond`
- Input: `{ "atom1": number, "atom2": number, "order": 1|2|3 }`

### `delete_bond`
- Input: `{ "bondId": number }`

### `layout`, `clean`, `clear_canvas`, `aromatize`, `dearomatize`
- Input: `{}`
- Standard Ketcher rearrangement / cleanup operations.

### `reset_to_snapshot`
- Input: `{ "snapshotId": "snap_..." }` or `{ "ket": "..." }`

## Export / verify

### `export_smiles`
- Input: `{ "canonical": false }` (optional). With `canonical: true`,
  routes through the Indigo /v2/indigo/convert remote service for
  canonicalization.

### `export_molfile`
- Input: `{}` — V3000 by default.

### `export_ket`
- Input: `{}` — Ketcher's native KET JSON, used for `reset_to_snapshot`.

### `diff_state`
- Input: `{ "before": AgentState, "after": AgentState }` — atom/bond
  delta. Most mutations also return a `diff` inline.

### `list_recent_events`
- Input: `{ "limit": number }` — runtime event log for debugging.

### `validate_state`
- Input: `{}` — runs Indigo `validate_state` against the canvas; returns
  warnings / errors per atom or per substructure.

## Reactions

### `construct_reaction`
- Input: `{ "reactants": SMILES[], "products": SMILES[], "agents":
  SMILES[]? }`

### `export_rxn`
- Input: `{}` — V3000 RXN file.

### `export_reaction_smiles`
- Input: `{}` — Reaction SMILES.

## Mutation response contract

Every mutating tool returns:

```json
{
  "operation": "set_atom_radical",
  "params": { "atomId": 0, "radical": 2 },
  "before": { /* AgentState */ },
  "after":  { /* AgentState */ },
  "beforeSnapshotId": "snap_12",
  "afterSnapshotId":  "snap_13",
  "beforeKetHash": "...",
  "afterKetHash":  "...",
  "diff": { /* atom/bond delta */ },
  "events": [ /* runtime event log */ ]
}
```

Track `afterSnapshotId` (or `exportKet()` in script mode) for rollback
targets.

## Indigo service dependency

The local Indigo Docker container at `http://127.0.0.1:8002/v2/` is used
by:

- `export_smiles({ canonical: true })` — canonical SMILES.
- PDF/figure rendering — `/v2/indigo/render` for image rendering.

It is **not** used for image OCR. Standalone mode covers every other
tool above.
