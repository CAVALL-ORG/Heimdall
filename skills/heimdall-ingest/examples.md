# Ketcher Ingest Examples

## Load SMILES then inspect state

1. `load_smiles({ "smiles": "c1ccccc1" })`
2. `get_state({ "includeMolfile": true })`

Expected shape:
- `data.after.smiles` is present
- `data.after.ket` is present
- `data.after.atoms` and `data.after.bonds` have IDs

## Load image via agent vision (the only supported image path)

The closed-loop consistency check (render Ketcher's reconstruction, Read
the PNG, compare to source) is required for every image. Compare the
molecular graph, not the artistic style.

### Example — straightforward match

Benzene at `images/clean/benzene_clean.png`.

1. Read the source — 6-carbon aromatic ring.
2. Identify: `c1ccccc1`.
3. `load_smiles({ "smiles": "c1ccccc1" })`.
4. `render_canvas({ "showAtomIds": false })`. Read the returned PNG.
   Graph: 6-carbon aromatic ring, no substituents. Matches source.
   Emit `vision_consistency_verified`.
5. `get_state({})` — return canonical SMILES.

### Example — charges (graph match despite cosmetic differences)

Glycine zwitterion at `images/clean/glycine_zwitterion_clean.png`.

1. Read source. Identify: `[NH3+]CC(=O)[O-]`.
2. `load_smiles({ "smiles": "[NH3+]CC(=O)[O-]" })`.
3. `render_canvas` → Read PNG. Verify graph: 3 heavy-atom main chain
   (N, C, C), one `=O` and one `[O-]` on the second carbon, `[NH3+]`
   on the nitrogen. Bond angles in the render may differ from the
   source — ignore. Charges and connectivity match. Emit
   `vision_consistency_verified`.
4. `get_state({})` — return SMILES.

### Example — mismatch + iteration

Suppose vision misread cis-stilbene as trans-stilbene.

1. Identify: `C(=C/c1ccccc1)/c1ccccc1` (incorrectly trans).
2. `load_smiles(...)`. `render_canvas` → Read PNG. Rendered shows
   phenyls on opposite sides; source shows them on the same side.
   Mismatch — emit `vision_consistency_mismatch`.
3. Re-identify as cis: `C(=C\c1ccccc1)/c1ccccc1`. Reload, re-render.
   Match this time. Emit `vision_consistency_verified`. Export.

If three iterations all mismatch, refuse: `{"smiles": null, "reason":
"vision reconstruction inconsistent with source after 3 attempts"}`.

## Refusing non-chemical images

When the supplied image is not a chemical structure (a reaction arrow alone,
formula text, a spectrum, a blank canvas, a photograph), refuse:

```json
{ "smiles": null, "reason": "image is not a chemical structure" }
```

Do not invent SMILES. There is no OCR fallback — Imago-style OCR
hallucinates SMILES on non-chemistry inputs (e.g. `reaction_arrow_only.png`
→ `CC`, `formula_text_only.png` → `C[Y]`, `spectrum_not_structure.png`
→ branched alkane) and is not on the MCP surface for that reason.

## Adversarial filenames

Trust the pixels, not the file path. Images like
`phenol_but_filename_says_toluene.png` (phenol),
`caffeine_but_caption_says_aspirin.png` (caffeine),
`rotated_not_aspirin.png` (caffeine) are intentional distractors — the
visual content is authoritative.
