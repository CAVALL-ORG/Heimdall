# MCP tool reference

Heimdall exposes a single stdio MCP server keyed **`heimdall`**. Every tool is
addressed as `mcp__heimdall__<tool>` from a client (Claude Code, Cursor, Codex);
the bare name is used below for brevity. These are the **only** tools the server
provides — there is no editing, reaction, or chemistry-derivation surface.

Most canvas-touching tools take a **`rowId`** — a stable per-molecule identifier
that keeps each molecule's canvas isolated when several rows run at once. Pass
the same `rowId` on every call for a given molecule. `rowId` is required on
`build_from_graph`, `export_smiles`, `render_canvas`, and `crop_source_image`,
and optional (but recommended for trace alignment) on `validate_graph` and
`refuse`.

## Ingest — load a molecule onto the canvas

### `load_smiles`
Load a molecule from a caller-supplied SMILES string. Used only by the ingest
path; **forbidden on image-rebuild rows** (the agent must reconstruct, not type
a SMILES it recognizes).
**Args:** `smiles` (string).

### `load_molfile`
Load a molecule from an MDL molfile (V2000/V3000) supplied by the caller.
**Args:** `molfile` (string).

### `load_canonical`
Load a molecule by name from a curated, reviewed SMILES library shipped with the
server (e.g. complex natural products / drugs), so callers can name a structure
without authoring its SMILES. **Forbidden on image-rebuild rows** — the
name-lookup shortcut would defeat the point of reconstructing from pixels.
**Args:** `name` (string; one of the registered names, see `list_canonical`).

### `list_canonical`
Enumerate the names registered in the canonical library.
**Args:** none.

## Build — reconstruct a molecule from a transcribed graph

### `build_from_graph`
The image-rebuild path's core tool. Consumes a `GraphIntent` JSON (atoms + bonds
+ rings + counts, plus optional wedge primitives and shorthand glyphs) and
produces one atomic commit on the canvas. The translator builds the skeleton,
applies element/bond-order/charge/radical overrides, perceives aromaticity,
places drawn hydrogens, resolves wedge stereo, cross-checks the declared counts,
tidies the layout, and **reverts** on a count mismatch or schema invalidity. The
build is gated on a passing `validate_graph` round for the same graph.
**Args:** `graph` (GraphIntent), `rowId` (required).

## Validate — preflight and inspect

### `validate_graph`
A **stateless** preflight for a draft `GraphIntent`. Returns `ok: true`, or
`ok: false` naming the regions that still need a closer look. Does not touch the
canvas; it is the gate `build_from_graph` checks against.
**Args:** `graph` (GraphIntent), `rowId` (optional).

### `validate_state`
Validate the current canvas state (structural sanity checks on the loaded
molecule).
**Args:** `rowId` (optional).

### `get_state`
Return the current canvas as structured data — atoms (with element/label,
charge, etc.) and bonds (endpoints, order) by ID. Use it to inspect what is on
the canvas without rendering.
**Args:** `rowId` (optional).

## Crop & render — look at pixels

### `crop_source_image`
The in-row zoom tool: crop a named region out of the source image so the agent
can re-read an unclear feature. Refused unless `validate_graph` has just named
the region (it cannot be used to free-roam the image).
**Args:** the region to crop (named by the preceding `validate_graph`), `rowId`
(required).

### `crop_molecule`
Crop **one** molecule out of a PDF page by pointing at it. Given seed point(s)
on the molecule, the tool renders the page, finds the connected ink
component(s) at the seeds, masks out every other component, and writes a tight
standalone PNG — a label stays attached, separated captions / neighbors / arrows
are removed. The primary crop path for the PDF-extract skill.
**Args:** `pdfPath`, `page`, `seeds[]`, `outputDir`, optional `label`, `within`
(box to cut a physically-bridged neighbor), `dpi`, `threshold`, `dilationPx`,
`marginPx`. Errors: `NO_INK_AT_SEED` (move the seed onto visible ink),
`WITHIN_CLIPS_ALL` (widen the `within` box).

### `render_canvas`
Render the current canvas to a PNG (or SVG) so the structure can be eyeballed —
e.g. to verify charges, stereo, or a multi-fragment build before exporting.
**Args:** `rowId` (required), optional `showAtomIds`, format flag.

## PDF — rasterize and crop a page region

### `render_pdf_region`
Rasterize one PDF page (no bbox; ~150 DPI) or a normalized-bbox region (~400 DPI)
to a PNG via poppler. Stateless and canvas-free; the upstream surface for
locating structures in the PDF-extract skill. `whiteout` paints crop-relative
rects white to erase foreign ink (neighbor atoms, captions, arrows); `trim`
shrinks the white border to the drawn content and re-adds a small margin (a
deterministic tight crop that can never clip the molecule's own ink). The result
flags `edgeInk` on any side where ink touches the crop edge (a "you clipped —
expand that edge" advisory).
**Args:** `pdfPath`, `page`, optional `bbox`, `dpi`, `outputDir` (required),
`label`, `whiteout`, `trim`. Requires `poppler-utils` (`POPPLER_MISSING`
otherwise).

## Export — get the answer out of Ketcher

### `export_smiles`
Export the current canvas as a SMILES string. **This is the only tool allowed to
author a SMILES** — the answer to an image-rebuild row is whatever this returns.
With Indigo enabled it can return a canonical SMILES; in standalone mode the
result is valid but non-canonical and carries a degrade advisory.
**Args:** `rowId` (required), optional `canonical` (requires Indigo/remote mode).

### `export_ket`
Export the current canvas in Ketcher's native KET JSON format.
**Args:** `rowId` (optional).

### `export_molfile`
Export the current canvas as an MDL molfile (V2000).
**Args:** `rowId` (optional).

## Refuse — the no-answer terminal

### `refuse`
The terminal call when the input is **not** a single transcribable chemical
structure — a reaction arrow, an R-group/Markush drawing, an illegible scan, or
a non-molecule image. Emits no SMILES. The reason must be pixel-grounded (a
visible obstruction), never a runtime cap. A dense polycycle is hard, not
refusable.
**Args:** a pixel-grounded reason, `rowId` (optional).
