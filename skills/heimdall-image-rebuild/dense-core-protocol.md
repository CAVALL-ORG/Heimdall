# Dense-core protocol (load-on-demand)

Reference. The normative contract lives in [SKILL.md](SKILL.md); on
conflict, SKILL.md wins. **Read this file only when the molecule has a
tightly-fused polycyclic core** (three or more rings sharing edges, many
overlapping strokes packed together). Sparse molecules never need it —
the 8-step loop in SKILL.md is the whole protocol for them.

This carrier is **dense-gated, not universal**: simple rows declare no
black boxes, get no `stereoAdvisory`, and stay byte-identical (the
`bond.wedge` stereo carrier itself is shared with the sparse path). Stage A
is the default path FOR a fused core, not a mandatory decomposition of
every molecule — and `refuse` on a junction you genuinely cannot read is
always correct.

## Vocabulary (the field names, in pixel terms)

The wire field names are software-flavored; read them as pixel facts:
- **`black_box_regions` entry** = "one ring I have read and am committing —
  its perimeter atoms are now fixed, do not let them move."
- **`boundary_atoms`** = the vertices you can point at around that ring's
  drawn loop.
- **port** = a vertex this ring SHARES with the next ring (the fused edge a
  bond crosses through) — NOT a side-chain. It is the drawn junction where
  two rings touch.
- **freeze** = once committed, a later round may ADD interior detail but may
  NOT move or re-point a vertex you already fixed.
- **`local_frame: cw/ccw`** = which way the drawn bonds wind at that
  junction (a handedness you SEE), never an R/S assignment.

The names do not change what you do: read each ring's loop, commit it, name
the shared junctions, and don't silently re-wire a junction you already
fixed.

## Why a fused core needs more than one read

A dense polycycle is **hard, not refusable**. Refuse only when
transcription is impossible (reaction arrows, Markush, illegible scans).
The failure mode on a tightly-fused core is **one confident whole-core
read**: the local pieces come out right but the global wiring is wrong —
you commit to junctions you did not actually read. The protocol below
prevents this and is the default path for any fused core, not one tactic
among several.

## The protocol — ONE ordered sequence

**First freeze the ring-to-ring WIRING as per-ring black boxes, THEN
declare STEREO on that frozen frame.** A dense-core build emits BOTH
`black_box_regions` (the wiring spine, stage A) AND coord-pinned
`bond.wedge` stereo (stage B), the latter driven to completeness by the
backend's undefined-stereocenter worklist. **Stage A is never skipped and
always comes first; stage B is built on top of it — stereo never replaces
the boxes.** The two are not a choice: a dense core needs both, in order.
The protocol replaces the single whole-core commit (where the wiring
drifts) with a frozen boundary + reliable local interior reads + stereo
declared last as wedges on the frozen frame.

### Stage A — wiring (do this before you build anything)

1. **Read the rings, then commit ONE box PER RING — never one box for the
   whole core.** Transcribe the legible outer ring/chain edges (the lines
   you can point at) at high confidence. Your first `validate_graph` round
   on a dense draft (heavy ≥ 18) returns a `dense_coupling_trigger` — if the
   draft is a fused core, it offers the per-ring-box path: for **each ring
   of the fused core**, declare one `black_box_regions` entry with its
   committed `boundary_atoms` (that ring's atom ids) and its **fusion
   ports** — the atoms this ring SHARES with each adjacent ring, through
   which a bond crosses into the neighboring ring. Each port carries the
   crossing bond's `order` and an optional `cw`/`ccw` `local_frame` (a
   drawn-handedness flag, never an R/S assignment). **The ports are the
   fusion atoms between adjacent rings — NOT the substituent/side-chain
   bonds.** A box whose ports are substituents pins nothing that matters.
   The granularity must be fine enough that each box's interior is a SINGLE
   ring pinned by the fusion bonds it shares with its neighbors. The build
   REQUIRES a **coherent** fused-core graph — your declared `rings[]` must
   be consistent with your `bonds[]`, which the backend enforces (a count
   cross-check rejects the build; `validate_graph` warns `ring_incoherent`
   pre-build). Per-ring black boxes are the **recommended** way to get there
   and the `dense_coupling_trigger` will offer them, but you MAY instead
   declare the shared fusion atom-ids directly across the ring entries. What
   the build checks is COHERENCE, not that you used boxes — building a dense
   draft whose `rings[]` are inconsistent with its `bonds[]` (e.g. a fused
   core declared as disjoint ring blocks) is the wiring-drift failure this
   protocol exists to prevent.

   **Worked example — fused rings share their fusion atoms (decalin, two
   fused 6-rings):**
   - GOOD: `rings: [{ id:"r1", atoms:[1,2,3,4,5,6] }, { id:"r2",
     atoms:[5,6,7,8,9,10] }]` — atoms **5 and 6 appear in BOTH entries** (the
     shared fusion edge). `counts: { heavy:10, rings:2, … }` (Euler:
     11 bonds − 10 atoms + 1 = 2). The backend sees one fused bicyclic.
   - BAD: `rings: [{ id:"r1", atoms:[1,2,3,4,5,6] }, { id:"r2",
     atoms:[7,8,9,10,11,12] }]` — disjoint blocks, no shared atoms. This
     declares TWO SEPARATE rings (12 atoms). Why it builds the wrong
     molecule: if the structure is really fused (10 atoms sharing edge 5–6),
     disjoint blocks either inflate the atom count or leave the declared
     `rings[]` inconsistent with the `bonds[]` — which the build's Euler
     count cross-check rejects (`count_mismatch`) and `validate_graph` warns
     on pre-build (`ring_incoherent`). Share the fusion atom-ids instead.
2. **The boundary is now FROZEN.** Later validate rounds may only ADD
   interior; deleting a committed boundary atom or re-pointing a port
   is rejected (`black_box_freeze_violation`) — re-read and restore it,
   do not silently re-wire. This freeze is what stops the wiring from
   drifting while you work the interior.
3. **Resolve each interior against the frozen ports.** For each ring
   inside the box: defer any junction you cannot yet point at as a
   `confidence: 'needs_zoom'` placeholder (with its matching
   `unresolved[]` entry) and resolve them a few at a time through the
   validate → crop → re-read loop (defer in batches under the
   `over_deferred_draft` threshold — more than half the atoms in
   `needs_zoom`). Re-count each ring's whole closed loop, check every
   line leaving each ring atom, and check which atom each substituent
   attaches to — against the pinned ports. **Account for every drawn
   bond at each ring atom**, including in-ring double bonds and exocyclic
   C=O / C=N substituents — a dropped carbonyl is a wiring miss the same
   as a dropped ring bond. On a dense core you may self-direct these
   crops freely (after a `validate_graph` round the crop tool relaxes
   its named-target requirement); `(x,y)` is the CENTER of the crop, and
   you back-map crop pixels with the returned `window`/`capturedN`/`outputN`,
   never a guessed corner (see [zoom-policy.md](zoom-policy.md)). **Frame
   the WHOLE feature** at the highest magnification that keeps it fully in
   view — do NOT over-tighten past its bonds (an over-zoom that crops a ring
   loop out of frame raises the misread rate); see "Dense crop tactics →
   Crop magnification on dense cores" below.
   Where a focused look plainly shows your draft is wrong, **revise it**;
   where it agrees or you cannot tell, leave it unchanged. Verify
   **efficiently** — one well-framed crop can confirm several adjacent
   features.
4. **Per-ring STOP rule — a ring is DONE once its ports are committed
   AND its interior is resolved against those frozen ports.** Stop
   cropping that ring. You crop a ring to RESOLVE it, not to re-confirm a
   frozen port — re-cropping a committed boundary buys nothing and burns
   the crop budget the rest of the core needs to author its per-ring
   ports. Pair every dense crop with a one-line `CROP_RATIONALE` (see
   [zoom-policy.md](zoom-policy.md)); a crop you cannot justify in one
   pixel-grounded line is a crop you should not take. The stop rule is a
   sufficiency heuristic YOU apply, not a backend cap — and it must NOT
   make you declare fewer `black_box_regions`: commit one box per ring
   first, then stop re-cropping. "Finish the ring" never means "skip
   declaring a ring's box."

### Stage B — stereo (only after every ring's ports are committed)

5. **Declare the wedges you can read as `bond.wedge`, NOT `stereoTransfer`
   — a dense core uses the same coord-pinned wedge carrier as a sparse
   molecule.** With every ring's fusion-atom ports frozen (steps 1–4), for
   each stereocenter whose wedge you can read: add a `bond.wedge`
   (`solid`/`hashed`) + `bond.wedge_from` = the chiral center + by-eye
   `x`/`y` on that center's drawn cluster (the center and its drawn
   neighbors). Do NOT use `stereoTransfer`/`drawnNeighborsCW` on a dense
   core (that is now the Haworth/Fischer-projection carrier only), and do
   NOT set `layoutPolicy` — the coord-pinned wedge needs its coords, which
   `ketcher_clean_locked` would reject.
   On a dense fused core the backend re-idealizes the coordinate frame
   (`clean()`) AFTER applying your wedge flags — so supply your best by-eye
   cluster coords as a SEED; the backend owns the final geometry and heals
   small angular slips. You still never set `layoutPolicy` and never author
   R/S. For a center where you see a wedge but cannot read its polarity,
   mark `stereo_unknown: true` so the build can commit. You state only the
   stroke polarity you see — never R/S, `@`/`@@`, CIP priority.
   **Coherence check before you build:** before building a dense fused core
   carrying `bond.wedge` stereo, confirm your declared `rings[]` are
   consistent with your `bonds[]` — shared fusion atoms across adjacent ring
   entries, no disjoint-block split of a fused core. Per-ring
   `black_box_regions` are the recommended way to have pinned that wiring; if
   you declared none, re-check the fusion before building. Stereo on an
   incoherent frame is the wiring-drift failure wearing a stereo hat.
6. **Build, then clear the backend's undefined-stereocenter worklist.**
   Build. The backend perceives every stereocenter and names the ones
   still undefined — either a `stereo_transfer_failed` error whose
   `unaccounted` list names centers you neither wedged nor skipped (the
   build will not commit until each is addressed), or, once the build
   commits, a `stereoAdvisory` warning whose `centerIntentIds` name
   centers you skipped (`stereo_unknown`) that ARE real stereocenters.
   **Treat both the same:** for EACH listed center, take ONE tight
   per-center crop centered (`(x,y)` is the crop CENTER) on the center +
   ALL its drawn neighbors + the wedge stroke, ~4×; see "Dense crop tactics
   → Per-center stereo-cluster crops" below.
   Read the stroke polarity, back-mapping crop pixels with the returned
   `window`/`capturedN`/`outputN` (never a guessed corner), and add (or
   correct) ONE `bond.wedge` + `wedge_from` + cluster coords on that
   center.
   **Per-center STOP rule — a center is DONE once its `bond.wedge` is
   committed against its tight crop; stop cropping it.** A center you have
   taken a tight crop of and genuinely cannot read stays `stereo_unknown`
   (the lack of stereo IS the diagnostic) — **never substitute a wedge
   guessed from remembered chemistry or "what this molecule is" (a §0
   cardinal-rule violation; a memory-guess that flips R/S is worse than an
   honest skip, which the grader credits match-any).** Take the one tight
   crop first (you have the crop budget for it); only skip if that crop
   cannot resolve it, and do not loop re-cropping one unreadable center.
   The worklist is sourced from backend enumeration — you do not estimate
   which atoms are stereocenters and you do not wedge a center the backend
   did not name.
   (Indigo unreachable ⇒ both channels go silent; declare the wedges you
   can plainly read and proceed.)
7. **Rebuild until the worklist clears, then readback + export.** Rebuild
   with the added wedges; the backend re-perceives — a center you wedged
   drops off the worklist. **Stage B is done when the build commits and
   every perceived stereocenter is either wedged or a center you already
   cropped-and-skipped** — that emptiness is the backend's completeness
   signal, not your own count. Then run the mandatory STEREO_READBACK
   self-check — a **fresh ink-centered source crop + independent re-read of
   EACH declared wedge center** (never a render-only or first-crop-only compare:
   a misread wedge is self-consistent and silently survives that; the trap +
   full spec are in [stereo-policy.md](stereo-policy.md)) — then `export_smiles`.
   The advisory is WARNING-only — it never
   flips `ok`. The backend checks the final build honors every declared
   port (a port with no realized crossing bond is rejected) and splices
   each region mechanically — it infers no chemistry. Where a
   constitution-defining junction genuinely cannot be resolved even after
   zooming, `refuse` rather than guessing.

## Worked success pattern (how a dense row passes)

The reliable shape, start to finish:
1. **topology first** — read the rings, commit one box per ring, share
   fusion atom-ids across adjacent ring entries, and fix EVERY
   `validate_graph` diagnostic (`ring_incoherent`, degree, count) before
   you build;
2. **coords are SEEDS, not measurements** — an imprecise crop-pixel read
   (off by tens of px) is fine, the backend `clean()` heals the geometry,
   so do not burn crops chasing exact coordinates;
3. **stereo in two stages** — build the topology, THEN let the backend's
   undefined-stereocenter worklist (`stereo_transfer_failed` error /
   `stereoAdvisory` warning) name the centers, and take ONE tight
   per-center crop of ONLY those named centers;
4. **discard recognition** — if you recognize the molecule, that fact is
   not evidence and not a check: no SMILES, count, ring tally, or wedge
   comes from a remembered name or formula, and re-verifying your graph
   against a recalled formula is the §0 violation that masks a misread (a
   recalled formula once suppressed the re-read that would have caught a
   merged bond).

This is the well-behaved dense row clearing; the wiring-drift failure (the
BAD decalin split above, a holistic whole-core commit, a memory-guessed
wedge) is what skipping step 1 or step 4 looks like.

## Worked end-to-end trace — a small fused tricyclic

A compact illustration of the DISCIPLINE shape (not a real fixture). A
three-ring fused core, ~20 heavy atoms, two wedge stereocenters at the
ring junctions. The point is the ORDER of moves, not the chemistry.

```
Read inputs/source.png                       # mandatory first action
```

**Round 1 — topology only, per-ring boxes, NO coords, NO stereo.** Read
the three ring loops you can point at. Declare three `black_box_regions`,
one per ring, sharing fusion atoms across adjacent ring entries:

```ts
validate_graph({
  version: 1,
  atoms: [ /* ~20 atoms; ring-junction atoms shared across ring entries */ ],
  bonds: [ /* every drawn line, in-ring + exocyclic; NO wedge yet */ ],
  rings: [
    { id:"r1", atoms:[1,2,3,4,5,6],  kind:"kekule" },
    { id:"r2", atoms:[5,6,7,8,9,10], kind:"kekule" },   // shares 5,6 with r1
    { id:"r3", atoms:[9,10,11,12,13],kind:"kekule" },   // shares 9,10 with r2
  ],
  counts: { heavy: 20, rings: 3, heteroatoms: { /* … */ } },
  black_box_regions: [
    { id:"b1", boundary_atoms:[1,2,3,4,5,6],
      ports:[{ id:"p1", boundary_atom:5, order:1 },
             { id:"p2", boundary_atom:6, order:1 }], status:"open" },
    { id:"b2", boundary_atoms:[5,6,7,8,9,10],
      ports:[{ id:"p3", boundary_atom:5, order:1 },
             { id:"p4", boundary_atom:6, order:1 },
             { id:"p5", boundary_atom:9, order:1 },
             { id:"p6", boundary_atom:10,order:1 }], status:"open" },
    { id:"b3", boundary_atoms:[9,10,11,12,13],
      ports:[{ id:"p7", boundary_atom:9, order:1 },
             { id:"p8", boundary_atom:10,order:1 }], status:"open" },
  ],
})
// → ok:false, ring_incoherent on r3 (you declared 5 atoms but bonds form a
//   6-loop). Re-crop r3, add the missed atom 14, re-submit → ok:true.
```

**Rounds 2–N — resolve interiors, then STOP.** Crop each ring whose
interior you deferred; `CROP_RATIONALE` per crop; flip `needs_zoom` → high.
Once a ring's loop is counted from one in-frame crop and its ports are
committed, STOP cropping it.

**Build — topology commits, stereo worklist names the centers:**

```ts
build_from_graph(clean_topology_draft)
// → stereo_transfer_failed, unaccounted: [atom 5, atom 9]
//   (two perceived stereocenters carry no wedge yet)
```

**Stage B — one tight per-center crop each, add wedges, rebuild:**

```ts
crop_source_image(sourceImagePath, x=<atom5 cx>, y=<atom5 cy>, w=160, h=160)
// CROP_RATIONALE: …/crops/…png resolved bond(5,7):wedge=solid from
//   wide-end at atom 5, narrow tip toward atom 7
// add bond.wedge:'solid', wedge_from:5 + by-eye coords on 5 and neighbors
//   (repeat for atom 9)
build_from_graph(draft_with_wedges)   // → ok; worklist empty
render_canvas                          // compare each wedge vs its crop
export_smiles                          // Ketcher emits the answer
```

```
SMILES: <value export_smiles returned>
```

The shape that passes: **one topology round (coherent rings) → interior
crops to STOP → build → backend names the stereocenters → one crop per
named center → rebuild until the worklist empties → export.** No
whole-molecule prose draft, no scaffold name driving any field.

## Dense crop tactics

These tactics apply to the crops you take in Stage A step 3 (interior
resolution) and Stage B step 6 (per-center stereo). The universal zoom
mechanism (the `(x,y)`-is-CENTER convention + the back-map formula +
`CROP_RATIONALE` template) lives in [zoom-policy.md](zoom-policy.md).

### Crop magnification on dense cores

On a tightly-fused core, **frame the WHOLE feature** you are reading — the
entire ring loop, or the junction plus all the neighbors that define it —
at the highest magnification that still keeps it fully in view. Any crop
capturing fewer than 1000 real source pixels is upsampled to 1000 px, so
the tightest window that still contains the whole feature gives the
highest effective magnification of the strokes you need. Higher
magnification of an in-frame feature measurably lowers the misread rate
(the hemibrevetoxin B 6-ring → correct 7-ring at higher resolution).
**But do not over-tighten past the feature's bonds:** an over-zoom that
crops part of a ring loop out of frame *raises* the misread rate on that
loop — a tight single-arc crop read a 7-ring worse than a whole-ring view
did. Maximize magnification, subject to the whole feature staying in
frame.

**Flagged perimeter ring → prefer a HIGHER-magnification crop, not a threshold
nudge.** A low-resolution perimeter ring can be miscounted (a 7-membered ring
read as 6 at low resolution; the same ring read correctly at higher
resolution). When a perimeter ring's atom count is uncertain, the lever is
RESOLUTION: take a higher-magnification crop of that whole ring (keeping the
full loop in frame), not a re-count at the same scale and never a forced
threshold. If the source itself is too low-resolution for a higher-mag crop to
resolve the ring, that is a documented frontier — `refuse` with
`source_resolution_too_low`, do not guess.

### Per-center stereo-cluster crops

Dense stereo is resolved one center at a time, driven by the backend's
undefined-stereocenter worklist (the `stereoAdvisory` `centerIntentIds` on a
committed build, or the `unaccounted` list of a `stereo_transfer_failed` build
— Stage B above). For EACH center the backend names: crop the stereo cluster —
the center + ALL its drawn neighbors + the wedge stroke — at the highest
magnification that keeps the whole cluster in frame (the ~4× cluster-crop size;
see [zoom-policy.md](zoom-policy.md)), read the wedge stroke polarity, and
declare ONE `bond.wedge` + `wedge_from` + cluster coords. Crop per CENTER, not
per ring: a fused-core stereocenter's drawn neighbors span two rings, so a
per-ring crop clips a neighbor and the wedge becomes unreadable. On a dense
core the crop tool **ink-centers** these per-center crops automatically (it
recenters a small off-center feature onto its ink; the returned
`window`/`recentered` reflect it) — so the wedge fills the frame at full
magnification without you having to nail the center pixel. **Per-center STOP
rule:** a center is DONE once its `bond.wedge` is committed against its tight
crop — stop cropping it; a center you cropped and still cannot read (after that
ink-centered crop) stays `stereo_unknown` — an honest skip beats a guessed
polarity (the grader credits the skip match-any; a wrong guess is a hard fail).

## `black_box_regions[]` schema (dense-gated carrier)

ONE optional, dense-gated carrier for the fused-polycycle "stitch" fix.
Absent on simple rows → byte-identical (fast-on-easy). Canonical
TypeScript source: [`server/src/types/graph-intent.ts`](../../server/src/types/graph-intent.ts).

```ts
black_box_regions?: [{
  id: string;                         // region id, unique within the graph
  boundary_atoms: number[];           // >=2 committed perimeter atoms (GLOBAL ids)
  ports: [{                           // >=1 fusion-bond ports
    id: string;
    boundary_atom: number;            // MUST be a member of boundary_atoms
    order: 1 | 2 | 3;                 // the crossing bond's order
    local_frame?: 'cw' | 'ccw' | null;// light drawn-handedness flag (NOT R/S)
  }];
  status: 'open' | 'resolved';
}]
```

Semantics (all backend-enforced; the agent authors no chemistry):
- **Granularity = ONE region per RING of the fused core, not one box for the
  whole core.** The ports of each ring-box are its **fusion atoms** (the atoms
  it shares with adjacent rings, through which a bond crosses into the
  neighbor) — NOT its substituent/side-chain bonds. A whole-core box (ports =
  substituents) leaves the ring-to-ring wiring unconstrained inside it and pins
  nothing that matters (the stitch lives there). Each box's interior must be a
  single ring pinned by its fusion bonds.
- **A port** is "a committed boundary atom through which a bond LEAVES the
  region." Coherence check (`validateBlackBoxRegions`, runs at BOTH
  `validate_graph` preflight and the build path): every boundary/port atom
  exists; every `port.boundary_atom` is in `boundary_atoms`; each port has a
  realized order-`order` crossing bond out of the region. A declared port with
  no crossing is self-contradiction → rejected. **FP=0 by construction.**
- **Freeze** (`checkBlackBoxFreeze`, across `validate_graph` rounds): once
  committed, later rounds may only ADD interior — deleting/dropping a committed
  boundary atom or re-pointing/removing a committed port (boundary_atom + order)
  is rejected (`black_box_freeze_violation`). The committed reference is sticky
  (persists even if a later round omits the field). The dense-stitch lever;
  STRUCTURAL, not prose. **Only a self-coherent round freezes:** a box you
  submit with a port that has no realized crossing bond is REJECTED that round
  and is NOT frozen — so if you mis-declared a port, just fix it and re-submit
  (the freeze never traps a box that was never valid). The freeze protects only
  wiring that already validated.
- **M0 trigger** (advisory): on a dense draft (`isDenseCandidate`: heavy ≥ 18,
  declaration-INDEPENDENT — so a mis-transcribed disjoint-ring fused core still
  triggers) with no region declared, `validate_graph` emits a
  `dense_coupling_trigger` WARNING surfacing this protocol's first step. It
  never flips `ok` — workflow emphasis, not a build gate or mandatory
  decomposition. Dense-gated by the heavy-atom floor (rows < 18 heavy omit it,
  byte-identical).
