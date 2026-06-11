# Haworth / Fischer Stereo — Transcription Rules

`Read` this only when the kernel
[heimdall-image-rebuild/SKILL.md](../heimdall-image-rebuild/SKILL.md) dispatch
table routes a row here — i.e. the image shows a Haworth (flat ring,
substituents above/below the ring line; any ring size, pyranose OR furanose,
including a nucleotide ribose) or Fischer (vertical `+`-cross ladder)
projection. Wedge-projection tasks never load this doc — keeping the rules
out-of-band keeps the common path lean.

**Not a Haworth sugar (bail back to the wedge path in
[../heimdall-image-rebuild/stereo-policy.md](../heimdall-image-rebuild/stereo-policy.md)):**
a ring with no ring-O or no anomeric carbon, or one drawn in normal
zig-zag/perspective rather than as a flat front-edge Haworth with strictly
vertical substituents — e.g. a fused taxane oxane/oxetane or a thiazolidine. A
ring merely *containing* oxygen is not enough; the Haworth drawing style +
ring-O + anomeric carbon together are the trigger.

This doc is a **data dir** companion to the `heimdall-image-rebuild` skill
(no SKILL.md of its own; not a separate skill). The agent transcribes pixel
features only — the chemistry decoding ("up means α", "vertical bond points
away in Fischer") lives in the translator/compiler via the global
`HAWORTH_VERTICAL_TOWARD` calibration constant, never in the agent's head.

## What this is for

The `stereoTransfer` schema already carries `projection: "haworth" |
"fischer"` (see [graph-intent-schema.md](graph-intent-schema.md)).
The compiler's projection adapter accepts a single additional pixel bit per
stereocenter — `verticalSense: "up" | "down"` — and maps it to a
wedge-projection `facing` via `HAWORTH_VERTICAL_TOWARD`. After the adapter,
the entry takes the standard parity-transfer path (per-center cyclic
reconciliation against Ketcher's frozen layout) — so a Ketcher-mirrored
sub-ring is auto-corrected exactly like a wedge-projection sub-ring.

The agent's job at a Haworth/Fischer stereocenter is therefore short:

1. Identify the two in-plane ring neighbors (or the two horizontal-bond
   neighbors, for Fischer).
2. Identify the vertical-bond substituent.
3. Read one bit: is that substituent drawn **above** the ring line / **above**
   the horizontal axis (`"up"`), or **below** (`"down"`)?

Nothing else. No R/S, no α/β, no D/L. The translator does the rest.

## Haworth (cyclic-sugar) transcription

A Haworth projection draws the pyranose / furanose ring as a flat hexagon /
pentagon in perspective, with the ring O typically at the upper-right of the
hexagon. Each ring carbon is a 3-real-heavy-neighbor center (the implicit H
is the dependent fourth slot — same as a normal wedge implicit-H center).
The three real heavy neighbors are:

- the previous ring atom (one in-plane neighbor),
- the next ring atom (the other in-plane neighbor),
- the **vertical** substituent (OH, OR, CH2OH, etc.).

### Per-center pixel facts

For each ring stereocenter the agent records one `stereoTransferEntry`:

```jsonc
{
  "center": <ring-carbon id>,
  // Clockwise visual walk of the three real heavy neighbors as seen in the
  // image. A stable convention is [vertical-substituent, ring-CW-next,
  // ring-CW-prev], but any consistent CW walk works — the compiler does NOT
  // depend on the agent picking a specific starting neighbor; it depends
  // only on the cyclic order.
  "drawnNeighborsCW": [<sub>, <next>, <prev>],
  "outOfPlaneNeighbor": <sub>,         // the vertical-bond substituent
  "facing": "toward",                   // IGNORED for haworth — adapter sets it
  "projection": "haworth",
  "confidence": 0.0–1.0,
  "verticalSense": "up" | "down"        // REQUIRED — the single pixel bit
}
```

`verticalSense`:

- `"up"`  — the vertical substituent is drawn **above** the ring line in
  the source image.
- `"down"` — drawn **below** the ring line.

The implicit H on the ring carbon is always opposite the named substituent
(if OH is up, H is down) and is not listed.

### What you do NOT transcribe

- Do NOT write `facing: "toward" | "away"` based on your own chemistry
  reasoning. The field is required by the schema for backwards compatibility
  but is overwritten by the projection adapter for Haworth/Fischer entries.
- Do NOT label entries as `α`, `β`, `D`, `L`, `R`, `S`. The adapter + the
  parity-transfer compiler + `HAWORTH_VERTICAL_TOWARD` produce the
  CIP-correct result.
- Do NOT pin any `x, y` on stereocenters or their neighbors — `layoutPolicy:
  "ketcher_clean_locked"` rejects stereo-critical coordinates. The translator
  owns the coordinate frame.

## Fischer (acyclic-sugar / amino-acid) transcription

A Fischer projection draws the carbon skeleton vertically, with the most
oxidized carbon on top, and each stereocenter as a `+` cross: horizontal
bonds point **toward** the viewer, vertical bonds point **away**. Each
stereocenter has two horizontal and two vertical bonds.

For the projection adapter the agent records the same shape of entry as
Haworth — the two horizontal-bond neighbors take the role of the in-plane
ring neighbors, and the vertical-bond neighbor takes the role of the
vertical substituent.

```jsonc
{
  "center": <stereo-C id>,
  "drawnNeighborsCW": [<vertical>, <horizontal-right>, <horizontal-left>],
  "outOfPlaneNeighbor": <vertical>,    // a vertical-bond neighbor
  "facing": "toward",                   // IGNORED for fischer
  "projection": "fischer",
  "confidence": 0.0–1.0,
  "verticalSense": "up" | "down"        // "up" = the vertical bond points up
                                        //         from the center
                                        // "down" = the vertical bond points
                                        //          down from the center
}
```

In a typical Fischer projection every stereocenter has both an up-vertical
and a down-vertical bond (continuing the chain). Pick whichever vertical
bond carries the stereo-bearing substituent you want to label, and record
its direction. Symmetry across the two verticals is fine — both choices
encode the same chirality once routed through the adapter.

## What the projection adapter does (background; not needed to transcribe)

The compiler's adapter computes:

```
verticalIsToward = HAWORTH_VERTICAL_TOWARD ? (verticalSense === "up")
                                           : (verticalSense === "down")
facing           = verticalIsToward ? "toward" : "away"
```

then routes the entry — now with `facing` derived from pixels — through the
standard `compileWedge` per-center parity comparison and the global
`CALIBRATION_INVERT`. The compiled wedge is applied to the bond
`(center, outOfPlaneNeighbor)` via `set_wedge_bond`.

`HAWORTH_VERTICAL_TOWARD` is **resolved to `true`** by the α-D-glucopyranose
calibration experiment under
[`outputs/cat1-haworth-calibration/`](../../outputs/cat1-haworth-calibration/).
Discipline note: the constant is global. If a single Haworth substrate ever
appears to require the opposite mapping while glucose still produces the
literature value, that is a real bug (transcription mistake, Ketcher layout
pathology) — not a calibration issue. Do not flip the constant per-substrate.

## Worked Haworth trace — α-D-glucopyranose

The chemically-correct α-D-glucopyranose canonical SMILES (Indigo) is
`OC[C@H]1O[C@H](O)[C@H](O)[C@@H](O)[C@@H]1O`. The standard Haworth drawing
has:

- C1 (anomeric): OH **down**  (α = down by definition)
- C2: OH **down**
- C3: OH **up**
- C4: OH **down**
- C5: CH2OH **up**  (D-sugar)

### Atom table

| id | element | drawn_H | charge | radical | ring | role             |
|----|---------|---------|--------|---------|------|------------------|
| 1  | C       | null    | 0      | 0       | r1   | C1 (anomeric)    |
| 2  | C       | null    | 0      | 0       | r1   | C2               |
| 3  | C       | null    | 0      | 0       | r1   | C3               |
| 4  | C       | null    | 0      | 0       | r1   | C4               |
| 5  | C       | null    | 0      | 0       | r1   | C5               |
| 6  | O       | null    | 0      | 0       | r1   | ring O (O5)      |
| 7  | O       | 1       | 0      | 0       | null | OH on C1         |
| 8  | O       | 1       | 0      | 0       | null | OH on C2         |
| 9  | O       | 1       | 0      | 0       | null | OH on C3         |
| 10 | O       | 1       | 0      | 0       | null | OH on C4         |
| 11 | C       | null    | 0      | 0       | null | C6 (CH2)         |
| 12 | O       | 1       | 0      | 0       | null | OH on C6         |

Bond table: ring single bonds 1–2, 2–3, 3–4, 4–5, 5–6, 6–1 (closing through
O5); substituent single bonds 1–7, 2–8, 3–9, 4–10, 5–11, 11–12. No
`bond.wedge` anywhere — every wedge fact is in `stereoTransfer`.

### COUNT

```
COUNT: heavy=12, rings=1, heteroatoms={O:6}
```

### `stereoTransfer` (parity-transfer mode)

One entry per ring stereocenter (5 entries — C1–C5). Each
`drawnNeighborsCW` is the CW walk of the three real heavy neighbors as seen
in the image: [vertical-substituent, ring-CW-next, ring-CW-prev]. The
implicit H is omitted; no coordinates are pinned.

```json
[
  { "center": 1, "drawnNeighborsCW": [7, 2, 6],  "outOfPlaneNeighbor": 7,
    "facing": "toward", "projection": "haworth", "confidence": 0.95, "verticalSense": "down" },
  { "center": 2, "drawnNeighborsCW": [8, 3, 1],  "outOfPlaneNeighbor": 8,
    "facing": "toward", "projection": "haworth", "confidence": 0.95, "verticalSense": "down" },
  { "center": 3, "drawnNeighborsCW": [9, 4, 2],  "outOfPlaneNeighbor": 9,
    "facing": "toward", "projection": "haworth", "confidence": 0.95, "verticalSense": "up" },
  { "center": 4, "drawnNeighborsCW": [10, 5, 3], "outOfPlaneNeighbor": 10,
    "facing": "toward", "projection": "haworth", "confidence": 0.95, "verticalSense": "down" },
  { "center": 5, "drawnNeighborsCW": [11, 6, 4], "outOfPlaneNeighbor": 11,
    "facing": "toward", "projection": "haworth", "confidence": 0.95, "verticalSense": "up" }
]
```

### Translator + compiler trace (informational)

1. Flat skeleton built from `atoms[]` + `bonds[]`; aromatize / drawn_H /
   charge / radical passes complete.
2. Global `layout` runs once; per-atom coords frozen.
3. For each entry the projection adapter maps `verticalSense` → `facing` via
   `HAWORTH_VERTICAL_TOWARD = true`:
   - C1: `"down"` → `facing: "away"` → hashed (after per-center parity)
   - C2: `"down"` → `facing: "away"` → hashed
   - C3: `"up"`   → `facing: "toward"` → solid
   - C4: `"down"` → `facing: "away"` → hashed
   - C5: `"up"`   → `facing: "toward"` → solid
   (The exact "hashed/solid" assignment depends on whether Ketcher mirrors
   the sub-ring during `layout`; the parity comparison handles it.)
4. `set_wedge_bond` applies each compiled wedge.
5. Build-integrity assertion + count check pass.
6. `export_smiles` returns the canonical α-D-glucopyranose SMILES.

After running this through `loadSmiles` + `exportCanonicalSmiles` against
the Indigo reference, the result matches `OC[C@H]1O[C@H](O)[C@H](O)[C@@H](O)[C@@H]1O`
exactly. See
[`outputs/cat1-haworth-calibration/`](../../outputs/cat1-haworth-calibration/)
for the calibration artifact that pinned `HAWORTH_VERTICAL_TOWARD = true`.

## What is NOT supported

- `projection: "chair"` — out of scope; the schema rejects it. If the image
  is a chair (or boat) conformation, refuse via the `refuse` tool.
- Mixed projections in one molecule (e.g. a Haworth pyranose with a wedge
  side chain) — emit one consistent `projection` per entry; if some
  stereocenters are clearly wedge-projection drawn while others are
  Haworth-projection drawn, give each entry its own `projection` value.
