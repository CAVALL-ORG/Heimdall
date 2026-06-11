# Stereo policy (the single stereo owner)

Backend reference and the one owner for every stereo rule. The kernel
[SKILL.md](SKILL.md) routes any wedge / E/Z row here; on conflict, SKILL.md
wins. Other docs link here for stereo and never re-describe it.

## The one stereo-encoding table (normative)

This is the single normative source for how the agent declares stereo. Other
docs link here; none re-describe it. The agent declares PIXEL OBSERVATIONS
only — never `R`/`S`, `@`/`@@`, `/`/`\`, or CIP priority.

| stereo kind | carrier the agent emits | what the agent states | backend |
|---|---|---|---|
| **wedge / tetrahedral center** (the default for ALL wedge stereo — sparse molecule OR dense fused core) | `bond.wedge` (`solid`/`hashed`) + `bond.wedge_from` (the chiral center) + chiral-cluster coords. **No `layoutPolicy`.** | the wedge stroke polarity + the local cluster coords | pins coords, `set_wedge_bond` orients center as `bond.begin`, Indigo perceives CIP. On a dense fused core the backend additionally surfaces every still-undefined stereocenter as a worklist (see "Backend stereo advisory family" below) so completeness is driven by backend enumeration, not by eye |
| **Haworth / Fischer projection** (sugars — pyranose OR furanose, incl. nucleotide ribose; the anomeric carbon is a stereocenter here too) | top-level `stereoTransfer` entry + `layoutPolicy: "ketcher_clean_locked"` + `projection: "haworth" \| "fischer"` + `verticalSense: "up" \| "down"` (no coords) | `center`, `drawnNeighborsCW` (the drawn neighbor order), and which substituent is drawn up/down on the ring or vertical — a ring substituent's up/down POSITION is the stereo signal even with no drawn wedge stroke, so such a center is NOT `stereo_unknown` | parity-transfer pipeline (ring-size-agnostic); `HAWORTH_VERTICAL_TOWARD` maps `verticalSense` → facing; Indigo perceives CIP |
| **E/Z double bond** | `bond.geom: 'cis' \| 'trans'` (on the `order: 2` bond) | "the two substituents are on the same / opposite side" — no coords | label-authoritative planner reflects a stereocenter-free half to satisfy the declared label at export |
| **unreadable after zoom** | `stereo_unknown: true` on the center (or `stereo_label: 'unknown'` entry) | nothing — the lack of stereo IS the diagnostic | emits canvas with stereo unspecified on that center |

**Why a dense core differs in DISCIPLINE, not in CARRIER.** Sparse and dense
both declare wedges as the coord-pinned `bond.wedge` — the carrier is the same.
A dense fused core adds two disciplines on top: (1) freeze the ring-to-ring
WIRING as per-ring `black_box_regions` BEFORE stereo (Stage A in
[dense-core-protocol.md](dense-core-protocol.md)); (2) let the backend's
undefined-stereocenter worklist drive per-center completeness, because a dense
core has many centers and silently skipping one (`stereo_unknown`) exports the
wrong isomer. The earlier `stereoTransfer`/`drawnNeighborsCW` "dense default"
was **withdrawn**: it caused a bulk-escape under live load (the agent punted
whole molecules to `stereo_unknown`), and the achievable dense rows are
coord-agnostic (every committed wedge is already correct — the only gap is the
*un-wedged* centers, which completeness closes). `stereoTransfer`/`drawnNeighborsCW`
now carries Haworth/Fischer projections and the R/S escape only. The agent never
authors `R`/`S`, CIP priority, `@`/`@@`, `/`/`\`; `stereo_label: 'R' | 'S'` is
the rare backend escape only when orientation is unreadable after zoom.

## Declare stereo up front (in the first build)

Read every drawn wedge AND every E/Z double bond while you draft, and put them
ALL into the first GraphIntent you build — do not build the flat skeleton then
back-fill wedges reactively.

- **Every drawn wedge → a `bond.wedge` (+ `wedge_from` + chiral-cluster coords)
  in the first build.** Building flat first and reading wedges one-at-a-time off
  later crops is the failure mode — it mis-reads polarity and skips centers. One
  pass: enumerate the visible wedges, crop each before the first build, declare
  them together.
- **`stereo_unknown` is ONLY for a center with NO drawn wedge after you have
  zoomed it.** A wedge that is present but hard to read must be cropped and
  declared, never skipped. The apex of converging wedges IS a drawn wedge — read
  its polarity, do not skip it.
- **Every drawn double bond with two distinguishable substituents → declare
  `bond.geom: 'cis' | 'trans'` in the first build.** Do not leave acyclic E/Z to
  coordinate inference; an unlabelled diene exports the wrong geometry.

The crop sizes for reading a stereocenter (cluster-for-ordering ~4× vs
tight-for-fill) live in [zoom-policy.md](zoom-policy.md).

## Backend stereo advisory family (dense completeness)

On a dense fused core the backend perceives every stereocenter (Indigo) after
each build and surfaces a single advisory family — `stereoAdvisory { centers[],
reason }` — naming the centers that still need attention, so completeness comes
from backend enumeration, never from the agent's own count (agent self-rating of
"am I done with stereo" was historically unstable). The `reason` discriminates
how you respond:

- **`completeness`** — a perceived stereocenter carries no wedge and was not
  explicitly skipped. Two surfaces: as a **`stereo_transfer_failed` build error**
  the build does NOT commit and its `unaccounted` list names each center; as a
  warning on a *committed* build (`data.stereoAdvisory`, `centerIntentIds`) the
  named centers are ones you marked `stereo_unknown` that ARE real stereocenters.
  Address every one — add a `bond.wedge`, or keep `stereo_unknown: true` only
  after an ink-centered crop genuinely fails.
- **`methyl_wedge`** (`data.methylWedgeAdvisory`, `centerIntentIds`) — a
  ring-fusion carbon whose wedge goes to a terminal methyl; a HASHED wedge to a
  short methyl stub is easily misread as SOLID. Do ONE thing: re-look at that
  single methyl stroke in isolation (parallel dashes = hashed, filled triangle =
  solid), fix its `bond.wedge` if wrong, rebuild — re-examine nothing else.
- **`geometry`** (`data.stereoGeometryAdvisory`, near-collinear in-plane
  neighbors) — detailed in "Stereocenter coordinate fidelity" below.

Of these, only `methyl_wedge` re-examines an already-committed wedge;
`completeness` and `geometry` only flag centers that still lack a definite one —
the committed-polarity catch is the STEREO_READBACK self-check below. The
warnings are WARNING-only on a committed build (they never flip
`validate_graph`'s `ok` and never throw); only the `stereo_transfer_failed`
error form blocks the commit. When Indigo is unreachable the Indigo-perceived
reasons (`completeness`, `geometry`) go silent (graceful degrade — declare the
wedges you can read and proceed); the graph-only `methyl_wedge` reason still
fires. Stage B (dense core) is done when the build commits and every perceived
stereocenter is either wedged or a center you have already cropped-and-skipped.

## Stereocenter coordinate fidelity (in-plane bond DIRECTIONS — the dense residual)

A wedge stroke read correctly can STILL export the wrong R/S if the
stereocenter's in-plane neighbor atoms are drawn at the wrong 2D angle: the CIP
perceiver derives handedness from the canvas geometry, so a neighbor placed
collinear (~180° across the center) or tens of degrees off its true direction
flips the center even with a perfect wedge. This — not a polarity misread — is
the dominant dense-stereo residual (e.g. a neighbor drawn at ~177.5° =
near-collinear, or ~93° off its true direction).

So for each dense wedge stereocenter, the `x`/`y` you transcribe for its drawn
neighbors must reproduce the **bond DIRECTIONS you see in the source crop**, not
a schematic/idealized layout. Read each in-plane bond's angle off the ink (the
ink-centered per-center crop makes this legible) and place the neighbor on that
ray; never draw two in-plane substituents collinear unless the source truly
draws them so. This is a SECOND readback alongside the stroke-polarity check
above: compare each center's in-plane neighbor angles in the render against the
source, not only the wedge fill.

The backend flags the detectable case: a successful dense build returns
`data.stereoGeometryAdvisory` (dense-gated, null otherwise) naming centers whose
in-plane neighbor pair is **near-collinear** — an ill-conditioned frame that will
mis-decode. For each named center, re-crop, re-read the two in-plane bond
directions, re-place those neighbors, and rebuild. It is WARNING-only (never
flips `ok`, never moves a coordinate itself). It catches the collinear class
ONLY; a non-degenerate but still-distorted angle is invisible to the backend, so
the direction re-read is the primary guard and the advisory is a backstop.

## Coordinates: two regimes by carrier

The two wedge carriers handle coordinates oppositely. Choose the regime by
carrier; they are mutually exclusive.

- **`bond.wedge` (sparse + dense fused core; NO `layoutPolicy`)** — the agent
  **supplies** chiral-cluster coords (mandatory: validator rules 13/18, the V9
  gate — coordless wedges flipped R/S in production). The translator pins them
  (translator step 4) and assigns the wedge flag against them (step 11). On a
  **sparse** graph `clean()` does not run, so the pinned frame survives to
  export. On a **dense fused core** (`isDenseDraft`) carrying wedge stereo, the
  backend then runs `clean()` (step 13) to OWN the final coordinate frame —
  re-idealizing the cluster so a by-eye coord-CW error heals and Indigo
  perceives CIP off the cleaned frame. Either way the agent supplies its best
  by-eye coords as a SEED, never authors R/S; `wedge_from` is always the chiral
  center. (See the relayout verdict report; this corrects the older absolute
  never-clean-with-coords wording, which overfit to a coordless diagnostic and
  did not hold for the dense fused-core case — V9 mandatory-coord is unchanged.)
  A dense build still
  does NOT set `layoutPolicy` — the coord-pinned wedge needs its coords, and
  `ketcher_clean_locked` would reject them. (Stage A's `black_box_regions`
  freeze is enforced in `validate_graph`, independent of the translator's
  layout step, so the wiring stays frozen whether or not `layoutPolicy` is set.)
- **`stereoTransfer` + `layoutPolicy: "ketcher_clean_locked"` (Haworth/Fischer
  projections)** — the agent supplies **NO** `x`/`y` on any stereo-critical atom;
  `assertLayoutLockedValid` rejects them, because the translator owns the
  coordinate frame (it builds the flat skeleton, runs `ketcher.layout()`, freezes
  the post-layout coords) and derives the intended geometry from the agent's
  `drawnNeighborsCW` order + `verticalSense`, not from agent coords.

Either way the agent never authors R/S; `wedge_from` (on the `bond.wedge` path)
is always the chiral center.

## Stereo readback self-check (MANDATORY when any `bond.wedge` is declared)

This is the catch-net for a mis-read wedge **polarity** — the residual after
the backend owns the frame (relayout) and enumerates completeness (the advisory
family). It is REQUIRED on any build that declared a `bond.wedge`, and skipped
entirely on a graph with none.

After `build_from_graph` succeeds, re-read **EACH** declared wedge center
**independently from the source** — this is the readback, and it is not a
render-only glance or a re-use of your first crop. For EVERY center carrying a
`bond.wedge`: take a NEW ink-centered tight crop of that center from the SOURCE
image and read its wedge polarity (`solid`/`hashed`) **from scratch**, as if you
had never read it. THEN `render_canvas` and, per center, compare your fresh
source read against the render's polarity. **The independent fresh re-read is
the whole point:** a wedge you misread the first time is *self-consistent* — it
reads the SAME wrong way when you only compare the render to your *original*
crop or your memory, so a render-only or first-crop-only check silently passes
the error. That is the dense-core stereo failure mode (idx-recurring polarity
flips). One fresh source crop per center, every center, every build — do not
skip a center because it "looks right" against your own prior reading. Compare
polarity, NOT absolute geometric direction: the cleaned/relaid-out canvas
geometry differs from the drawn source, but a solid wedge stays solid. Emit one
line per center:

```
STEREO_READBACK: <center_id> render=<solid|hashed> source=<solid|hashed> <match|MISMATCH>
```

On a MISMATCH — your fresh source read disagrees with the render (or with your
first read) — the declared `bond.wedge` polarity is wrong: correct that
`bond.wedge` and rebuild before `export_smiles`; or, if the polarity is still
undiscriminable after the fresh ink-centered crop, mark the center
`stereo_unknown` (see "Source-limited stereo"). This catches what the completeness worklist
cannot (it names *missing* wedges, never re-decides a committed one). The
readback is agent-applied; the backend never flips `ok` on it.

The encoding carriers (wedge `bond.wedge` for sparse AND dense / Haworth-Fischer
`stereoTransfer` / E/Z `bond.geom`) are the one table above — the backend
pipeline that consumes them is the parity-transfer compiler
([stereo-transfer.ts](../../server/src/adapter/graph-intent/stereo-transfer.ts))
+ the V2000 solver
([rs-direct-solver.ts](../../server/src/adapter/graph-intent/rs-direct-solver.ts)),
which re-applies layout-invariantly where parity-transfer disagrees with
Indigo. Final canvas is layout-stable.

## Source-limited stereo

If wedge orientation or E/Z geometry is genuinely unreadable **after an
ink-centered crop** (the dense crop tool recenters small off-center features —
take that crop before you concede a center), set `stereo_unknown: true` on the
chiral center atom. An honest skip is strictly better than a guessed polarity:
the grader credits a skipped center match-any, while a confident-but-wrong
`solid`/`hashed` is a hard isomeric fail. Never substitute a wedge guessed from
remembered chemistry or "what this molecule is". `source_limited` is legal ONLY
for stereo-local fields (`wedge_orientation`, `ez_geometry`). Topology-defining
fields cannot be waived — they must be resolved or the row refuses.

**Refuse, don't mass-skip:** the build now rejects an all-`stereo_unknown`
export over ≥5 centers (the C3 gate). When most centers of a row are unreadable,
prefer the whole-row pixel-grounded `refuse` over mass-skipping (the evaluator
polices mass stereo dodge).

When stereo-local fields are source-limited, the backend emits a canvas
with stereo unspecified on those centers and `export_smiles` returns the
SMILES with the corresponding stereo bits dropped. The agent does not
author any diagnostic — the lack of stereo IS the diagnostic.

## Backend R/S escape

When wedge orientation is unreadable even after zoom, add a
`stereoTransfer` entry with `stereo_label: 'R' | 'S' | 'unknown'`
pointing at the chiral center (`StereoLabelEntry` schema below). The
backend uses the V2000 solver directly with the R/S label, bypassing
parity-transfer. This is NOT a way to skip transcription — evaluator
vision-compare catches mass-emission attempts to dodge stereo. CIP
priority + R/S determination rules: [../_shared/cip-reference.md](../_shared/cip-reference.md).

## Stereo carrier schemas (projection + escape; not the default path)

The DEFAULT stereo carrier for every image-rebuild row — sparse OR dense
fused core — is `bond.wedge` (+ `bond.wedge_from` + chiral-cluster coords),
defined in the `bonds[]` section of
[graph-intent-schema.md](../_shared/graph-intent-schema.md). The
carriers below are NARROW: `stereoTransfer`/`drawnNeighborsCW` is the
Haworth/Fischer-projection carrier (sugars) and the R/S-label escape only;
both require `layoutPolicy: "ketcher_clean_locked"`. Canonical TypeScript
source: [`server/src/types/graph-intent.ts`](../../server/src/types/graph-intent.ts).

### `layoutPolicy` + `stereoTransfer` (Haworth/Fischer projections)

When `layoutPolicy: "ketcher_clean_locked"` is present the translator runs
the parity-transfer pipeline instead of the coord-pin wedge passes: build the
flat skeleton → a global Indigo `layout` → freeze coordinates → compile one
wedge per `stereoTransfer` entry against the frozen layout → apply via
`set_wedge_bond` → build-integrity assertion. An intent with `layoutPolicy`
set must carry a non-empty `stereoTransfer` array and **no** `x`/`y` on any
stereocenter atom or `drawnNeighborsCW` atom — the translator owns the
coordinate frame and rejects stereo-critical coordinates. This is the
Haworth/Fischer carrier (transcription rules + worked Haworth trace:
[haworth-fischer-stereo.md](../_shared/haworth-fischer-stereo.md),
loaded on demand only when a Haworth/Fischer drawing is detected). The
`projection: "wedge"` / `drawnNeighborsCW` form remains accepted but is not
the default for any image-rebuild path.

```ts
interface StereoTransferEntry {
  center: number;              // stereocenter atom id
  drawnNeighborsCW: number[];  // all drawn neighbors, clockwise in the image;
                               //   length 3 (one implicit H) or 4 (quaternary)
  outOfPlaneNeighbor: number;  // the wedged neighbor; member of drawnNeighborsCW
                               //   (EXCEPT when wedgeToImplicitH is true)
  facing: "toward" | "away";   // solid wedge = toward; hashed = away
                               //   (ignored for haworth/fischer; the adapter
                               //    derives facing from verticalSense)
  projection: "wedge" | "haworth" | "fischer";  // "chair" is not supported
  confidence: number;          // 0–1 self-rating; diagnostic only, does not gate

  // Optional — wedge points at the stereocenter's implicit H rather than at
  // one of the three real drawn heavy neighbors. drawnNeighborsCW carries
  // the 3 real drawn neighbors; outOfPlaneNeighbor is the agent-chosen id
  // for the H and is NOT a member of drawnNeighborsCW. The translator
  // materializes one explicit H on the center, positions it opposite the
  // heavy-neighbor centroid, and applies the compiled wedge to that H bond.
  wedgeToImplicitH?: boolean;

  // Optional — required when projection is "haworth" or "fischer". For
  // Haworth: "up" when outOfPlaneNeighbor is drawn ABOVE the ring line,
  // "down" when below. For Fischer: orientation of the vertical bond
  // carrying outOfPlaneNeighbor. Routed through HAWORTH_VERTICAL_TOWARD →
  // facing → standard parity-transfer pipeline.
  verticalSense?: "up" | "down";

  // Explicit-skip flag. When true, the translator accepts the center as
  // accounted-for and applies NO wedge. The grader treats the center as
  // match-any. Equivalent to a StereoLabelEntry with stereo_label:'unknown'.
  stereo_unknown?: boolean;
}
```

### R/S-label entry (escape hatch)

The alternative `stereoTransfer` entry shape carries an R/S target label
instead of wedge geometry. Used ONLY when the agent genuinely cannot
transcribe the wedge orientation from pixels (needs_zoom triggers exhaust
after zoom). The grader's `stereo_escape_hatch_gate` enforces that every
`stereo_label: 'unknown'` entry has a matching `unresolved[]` entry with
`field: 'wedge_orientation'` in the same submitted graph.

```ts
interface StereoLabelEntry {
  center: number;                                           // stereocenter atom id
  stereo_label: "R" | "S" | "unknown" | "beyond_protocol";  // target CIP at center
  beyond_protocol_reason?:                                  // required for beyond_protocol
    | "axial_chirality"    // biaryl
    | "allene"             // cumulated double bond
    | "chair_without_coords"
    | "hypervalent"        // degree > 4
    | "indigo_indeterminate";
}
```

The translator's solver picks the wedge configuration that produces the
requested backend label; `'unknown'` is the explicit-skip form (no wedge).
This is an encoding path, not source evidence. `'beyond_protocol'` is the
refusal class for stereo features outside the current protocol; the grader's
`beyond_protocol_gate` emits a row-level `refuse-with-reason` so users see
"stereo beyond current protocol; partial SMILES with achiral encoding at
center X" instead of a silent wrong answer. Entries carry geometry only —
never R/S, `@`/`@@`, or any CIP assignment authored by the agent.

### Calibration constants (backend; do NOT per-center calibrate)

- **`CALIBRATION_INVERT = true`** — `clockwiseNeighborOrderFromCoords` reads
  Ketcher `get_state` coordinates (y-down screen convention), so visual
  clockwise is *ascending* `atan2`. Penicillin G confirms Variant C
  reproduces (2S,5R,6R) with `true`; `false` inverts every center. Lives in
  `server/src/adapter/graph-intent/stereo-transfer.ts`.
- **`HAWORTH_VERTICAL_TOWARD = true`** — maps `verticalSense` → `facing`
  (`"up"` → `"toward"`). α-D-glucopyranose calibration confirms the
  literature α-anomer with `true`; `false` mirrors every center. A substrate
  that appears to need the opposite mapping while glucose still produces the
  literature value is a real bug, not a calibration issue.

(`stereoObservations[]` is a backend forensics/metadata ledger, not an agent
authoring surface; the translator drives mutations from `stereoTransfer` only.
See the TypeScript source if you need it.)
