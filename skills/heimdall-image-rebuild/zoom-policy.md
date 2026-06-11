# Zoom policy — the crop / zoom validate loop (owner)

Reference and the owner for the crop/zoom validate loop. The kernel
[SKILL.md](SKILL.md) routes any `needs_zoom` / region-to-zoom here; on
conflict, SKILL.md wins.

Each zoom is **one `crop_source_image` call + one `Read` + one
`CROP_RATIONALE` line**.

**Threading + the preflight.** Pass your chosen `rowId` (see SKILL.md "Row
identity") on every call, plus `sourceImagePath` on the calls that read the
image (`validate_graph`, `crop_source_image`). `rowId` is required on
`build_from_graph` / `render_canvas` / `export_smiles` / `crop_source_image`;
you never invent `outputDir` (the server derives it from `rowId`).
`validate_graph` is a pure preflight: it returns `ok: true`, or `ok: false`
with `unresolved_remaining[]` (each names a `record_id`, `field`, and the
`(x_center, y_center, bbox_radius)` to crop) plus `diagnostics[]` (each names
ONE `record_id` — repair only that record). It also samples the source image
directly and rejects atoms declared at white pixels
(`vertex_not_visible_at_coord`), bonds whose line crosses no drawn stroke
(`bond_line_not_drawn`), and drafts with more than half their atoms in
`needs_zoom` (`over_deferred_draft`) — re-read the named region and repair.

## When to mark a placeholder during initial draft

Mark a record `confidence: 'needs_zoom'` + one matching `unresolved[]`
entry whenever pixel confidence on the relevant field is not high —
glyph text you cannot read, a segment endpoint you cannot place on one
specific vertex, a wedge whose wide-end you cannot point at, a charge
glyph whose anchor is not clear, a tautomer-prone NH/N or OH/O state
you cannot pin from pixels. Decide from the pixels you can or cannot
point at, not from a category list.

Invariant: every `confidence: 'needs_zoom'` record has exactly one
matching `unresolved[]` entry. Preflight rejects mismatch.

If, while drafting, you cannot confidently read wedge orientation at a
chiral center, add an `unresolved[]` entry with `field:
'wedge_orientation'` and `record_id` matching the bond id (or atom id
for atom-level placeholders). The preflight names the coordinates to
crop on.

(Dense-core deferral and the dense per-center stereo-crop WORKFLOW are
dense-only tactics in [dense-core-protocol.md](dense-core-protocol.md); the
universal crop SIZES for a stereocenter are below ("Stereocenter crop sizes"),
and the universal zoom mechanics below apply to every row.)

## Zoom mechanism

```ts
crop_source_image(sourceImagePath: string, x: number, y: number, w: number, h: number)
  → { path: string, window: { left, top, right, bottom }, capturedN, outputN }
```

`(x,y)` is the **CENTER** of the crop (`left = x − floor(N/2)`), not a
corner. Center the crop on the feature's source pixel. To map a pixel
`(px,py)` in the returned crop back to source coordinates, use the
returned window + scale — never a guessed corner:
```
source_x = left + px·(capturedN/outputN)
source_y = top  + py·(capturedN/outputN)
```
`window.left`/`top` may be negative when the window runs off-source (that
region is white pad); the back-map is still exact.

`crop_source_image` refuses crops that do not match a region the
preflight just named — preemptive scope-reconnaissance is structurally
unavailable. Center each crop on the coordinates `validate_graph`
returned in the matching `unresolved_remaining` entry. Two placeholders
nearby in the image share one merged crop centered on the midpoint.

If the source resolution is too low for crops to remain useful, the
crop tool returns a low-resolution diagnostic; respond by calling
`refuse` with a `source_resolution_too_low` framing.

## Stereocenter crop sizes (cluster-for-ordering vs tight-for-fill)

Two crop sizes read a wedge stereocenter, chosen by what you need:

- **Cluster-for-ordering (~4×)** — to read a wedge's polarity in context (and
  the drawn neighbor ordering), frame the **full local cluster**: the chiral
  center + ALL its drawn neighbor atoms + the wedge stroke. Empirically ~4×
  keeps all of them in frame; ~8× over-zooms past the neighbors and the
  polarity becomes meaningless without them. Prefer ~4×; do NOT zoom so far
  that a drawn neighbor falls outside the crop.
- **Tight-for-fill** — to re-decide ONLY a single stroke's fill (solid vs
  hashed) — e.g. a `methyl_wedge` re-check or a STEREO_READBACK MISMATCH — take
  an ink-centered tight crop on that one stroke (on a dense core the crop tool
  ink-centers automatically; the returned `window`/`recentered` reflect it) so
  the stroke fills the frame.

(Dense per-center stereo-crop workflow — driven by the backend advisory family
— lives in [dense-core-protocol.md](dense-core-protocol.md); the stereo rules
themselves are in [stereo-policy.md](stereo-policy.md).)

## `CROP_RATIONALE` line

Immediately after each crop + Read, emit one line:
```
CROP_RATIONALE: <crop_path> resolved <prefixed_record_id>:<field>=<value> from <pixel_cue>
```

`<pixel_cue>` is a pixel-grounded observation:
- "printed glyph reads 'N'"
- "two parallel strokes visible between atoms 14 and 17"
- "wedge wide-end at upper-left, narrow tip at right"
- "ring closes via three short segments back to atom 8"

**Forbidden in `<pixel_cue>`:** any chemistry-naming language. You don't
need to know which names are rejected — don't write any chemistry name in
this field. If the cue could go on a chemistry exam, it's too high-level.
Canonical-form mentions (`InChIKey`, `canonical SMILES`, `formula match`)
are also forbidden — those aren't pixel observations.

## Update protocol

After resolving a placeholder:
1. Flip `confidence: 'needs_zoom'` → `'high'`.
2. Remove the matching `unresolved[]` entry.
3. Add any new visible records the zoom revealed.
4. Re-submit to `validate_graph`.

**Before building, re-`Read` the full source** if you have taken several crops
or it has been a while since the last full read — vision attention degrades
across many cropped sub-views.

If the same `(record_id, field)` returns twice in a row, the backend
treats the topology as unreadable — the next build will be rejected.
Call `refuse` with a pixel description of the unreadable region.
