# GraphIntent — Schema Reference

Canonical TypeScript source: [`server/src/types/graph-intent.ts`](../../server/src/types/graph-intent.ts).
This doc is a prose mirror; the TS file is the source of truth.

GraphIntent is the backend-facing intermediate representation for
`build_from_graph`. This is the **one submission shape** for image rebuild
and all other producers. The common path is **atoms + bonds + rings +
counts** (+ `bond.wedge` for stereo). Two narrow carriers live in
load-on-demand refs and never touch a sparse row:

- **stereo projections + R/S escape** (Haworth/Fischer sugars,
  `stereoTransfer`, `layoutPolicy`, calibration constants) →
  [heimdall-image-rebuild/stereo-policy.md](../heimdall-image-rebuild/stereo-policy.md).
- **fused-core black boxes** (`black_box_regions`) →
  [heimdall-image-rebuild/dense-core-protocol.md](../heimdall-image-rebuild/dense-core-protocol.md).

## Top-level shape

```ts
interface GraphIntent {
  version: 1;
  label?: string;
  panel_index?: number;                    // multi-molecule disambiguation
  atoms: IntentAtom[];
  bonds: IntentBond[];
  rings: IntentRing[];
  counts: IntentCounts;
  unresolved?: GraphIntentUnresolved[];    // top-level placeholder ledger
  // — narrow carriers, documented in their refs (load on demand) —
  unsure_regions?: UnsureRegion[];         // advisory only; build-inert (see note)
  layoutPolicy?: "ketcher_clean_locked";   // stereo-policy.md (projections)
  stereoTransfer?: StereoTransferEntry[];  // stereo-policy.md (projections + R/S escape)
  stereoObservations?: StereoObservation[]; // backend forensics; NOT an authoring surface
  black_box_regions?: BlackBoxRegion[];    // dense-core-protocol.md (fused cores)
}
```

Unknown fields are rejected. Multi-fragment molecules (salts, hydrates,
co-crystals) use one GraphIntent with disconnected atom/bond components
— the translator BFS-detects them.

`unsure_regions` is **advisory only**: `validate_graph` surfaces each box as
a coverage crop target, but it never blocks build and never flips `ok`
(proven build-inert: `tests/runtime-e2e/direct-shape-unsure-regions.e2e.test.ts`).
Deferral on the common path uses `confidence: 'needs_zoom'` + `unresolved[]`
(below), not coarse boxes.

## `atoms[]`

```ts
interface IntentAtom {
  id: number;            // caller-assigned; 1-indexed by convention; unique
  element: string;       // C, N, O, S, P, F, Cl, Br, I, Na, … (1-2 char symbol)
  shorthand?: string;    // RAW glyph text the agent read for a condensed group
                         //   (`OMe`, `Ph`, `Bn`, `Ac`, `Ts`, `Boc`, `Et`,
                         //   `iPr`, `tBu`, …). When set, `element` is a required
                         //   1-2 char PLACEHOLDER the backend ignores (use 'C');
                         //   the deterministic shorthand table expands the text
                         //   into explicit atoms+bonds during a pre-skeleton
                         //   pass. The agent NEVER decomposes. Unknown text →
                         //   `unknown_shorthand` at validate_graph (zoom + re-emit
                         //   explicit atoms, or refuse) — UNLESS a
                         //   `shorthand_resolution` is supplied (below).
  shorthand_resolution?: {   // ADR-0002 provenance for an OFF-TABLE glyph: WHO
                             //   supplied the expansion the table lacks. Only
                             //   valid on an atom that ALSO carries `shorthand`.
    source: "paper_legend" | "agent_inference";
    expansion: ShorthandExpansion;  // table-entry-shaped subgraph (same shape
                                    //   decomposeShorthand() returns; see below)
    legend_ref?: string;   // REQUIRED iff source==="paper_legend" (id into the
                           //   run glyph dictionary); FORBIDDEN for agent_inference
    note?: string;
  };
  drawn_H: number | null; // null = no label drawn; 0 = explicit "no H"; 1/2/3 = NH/NH2/NH3
  charge: number;        // -4 ≤ n ≤ +4
  radical: 0 | 1 | 2;    // unpaired-electron count (translator maps to category code)
  ring: string | null;   // ring id (from rings[].id) or null if acyclic at this atom
  x?: number;            // optional 2D coord (image pixels, top-left origin)
  y?: number;            // optional 2D coord — must accompany x
  wedge_to_implicit_h?: "solid" | "hashed" | null;
                         // wedge drawn from this atom to a separately-drawn H vertex
  stereo_unknown?: boolean;
                         // agent could not commit wedge polarity; grader credits this site
  isotope?: number;      // nuclear mass number (¹³C → 13, ²H → 2, ¹⁵N → 15, …).
                         // Optional; backend defaults to natural abundance when absent.
  stereo_group?: {       // maps to Ketcher MDL stereo-group atom field.
    kind: "abs" | "rel" | "or" | "and";
    id: number;          // group index (0-indexed). Exports as extended-SMILES
  };                     //   |&1:…| (and), |o1:…| (or), abs is unmarked CIP.
  drawn_H_confidence?: "high" | "needs_zoom";  // atom-level placeholder
  charge_confidence?:  "high" | "needs_zoom";
  radical_confidence?: "high" | "needs_zoom";
}
```

- `drawn_H` is the **drawn H label**, not the chemistry-correct H count.
  This is the tautomer carrier: cytosine N1-H tautomer has `drawn_H: 1`
  on the N1 atom; the N3-H tautomer has `drawn_H: 1` on N3. Never
  substitute "the equivalent tautomer".
- `radical` is a **physical electron count**. TEMPO N = 1. Carbene C =
  2. The translator maps this to Ketcher's category code
  (count=1 → code=2 / DOUBLET; count=2 → code=3 / TRIPLET) — callers
  never see the code.
- `wedge_to_implicit_h` carries a wedge bond whose target is an
  implicit-H vertex drawn separately in the image (e.g. ring-junction
  H on cholesterol C8). The translator promotes one implicit H to an
  explicit H atom, positions it opposite the heavy-neighbor centroid,
  and applies the wedge from this atom to the new H.
- `stereo_unknown` is the flag for a center whose wedge polarity you
  genuinely cannot read from the drawn pixels after cropping. Commit a
  `bond.wedge` ONLY for a stroke polarity you can actually SEE (a faint
  but visible stroke is a legitimate low-confidence read). If you cannot
  see the stroke, set `stereo_unknown` — do NOT fill it in from a
  remembered scaffold or "what this molecule is known to be." A wedge
  inferred from memory rather than the drawn mark is the scaffold-memory
  failure the cardinal rule forbids (§0 of
  [heimdall-image-rebuild/SKILL.md](../heimdall-image-rebuild/SKILL.md)),
  even when it happens to be right; on image-truth grading such a flip
  fails `iso_match` exactly as a skip would, but it is ALSO dishonest and
  scores a per-site mismatch where an honest skip is credited match-any.
  So: re-crop and read it if you can; if you truly cannot, skip it
  `stereo_unknown` — never guess from memory. Translator is a no-op for
  this field; the grader treats flagged centers as match-any.
- `shorthand_resolution` (ADR-0002) declares **provenance for an off-table
  glyph** — the expansion the deterministic table lacks, plus WHO supplied it.
  Optional + additive: a row whose glyphs are all in the table omits it and is
  byte-identical to today. It is only valid on an atom that also carries
  `shorthand` (the glyph text being resolved). `source: "paper_legend"` means
  the glyph was decoded against the paper's own declared abbreviation key and
  requires `legend_ref` (an id into the per-run glyph dictionary, which carries
  the page/region cite); `source: "agent_inference"` means the agent expanded it
  from chemistry knowledge and must NOT carry `legend_ref`. `expansion` is a
  `ShorthandExpansion` — the SAME table-entry shape `decomposeShorthand()`
  returns:

  ```ts
  interface ShorthandExpansion {
    atoms: Array<{ element: string; drawn_H?: number; isotope?: number }>;
    bonds: Array<{ a: number; b: number; order: 1 | 2 | 3 }>;  // LOCAL ids
    attachment_atom_offset: number;   // index in atoms[] that bonds to the parent
  }
  ```

  `validate_graph` rejects a `shorthand_resolution` whose glyph is ALREADY in
  the deterministic table (`shorthand_resolution_redundant` — the table wins,
  one source per glyph). NOTE (this slice / W1): the schema + provenance rules
  are in place, but the translator does NOT yet consume `expansion`; an
  off-table glyph still surfaces `unknown_shorthand` at build until W2 wires the
  splice path. The structural rules (legend_ref presence,
  must-co-occur-with-`shorthand`) are enforced by the schema; the
  table-collision rule is enforced in the validator path.

## `bonds[]`

```ts
interface IntentBond {
  a: number;
  b: number;
  order: 1 | 2 | 3;                              // Kekulé only
  wedge: "solid" | "hashed" | null;              // solid=toward viewer, hashed=away
  wedge_from: number | null;                      // chiral atom (origin of wedge)
  geom?: "cis" | "trans" | null;                  // E/Z on a double bond (mutually exclusive with wedge)
}
```

`bond.wedge` is the **default stereo carrier for every image-rebuild row —
sparse OR dense fused core** (chiral-cluster coords required; see
[stereo-policy.md](../heimdall-image-rebuild/stereo-policy.md) for the one
encoding table).

- Aromaticity is **not** a bond field — drawn Kekulé patterns are
  preserved as `order: 1 | 2`, and the translator runs `aromatize()`
  after the skeleton is built. (Non-image producers that want to declare
  aromaticity up front use `IntentRing.kind = "aromatic"`.)
- Wedge metadata: when `wedge !== null`, `wedge_from` MUST be `a` or
  `b`. The translator routes through `setWedgeBond(chiralAtomId,
  neighborAtomId, wedge)` so the chiral atom always ends up as
  `bond.begin` — no `set_bond_stereo` footgun.
- Bond order **must be 1** when `wedge` is set (wedges are only valid
  on single bonds in Ketcher).
- `geom` carries E/Z on a double bond. Requires `order === 2`. Coordinates
  are NOT required on geom bonds — the backend honors the `cis`/`trans`
  label against the post-build coordinate frame (reflecting a
  stereocenter-free half to satisfy the declared label). Mutually
  exclusive with `wedge`.

## `rings[]`

```ts
interface IntentRing {
  id: string;
  atoms: number[];                               // cyclic order
  kind: "kekule" | "aromatic" | "aliphatic";
}
```

- For image rebuild use `kind: "kekule"` (default — the agent transcribes
  double-bond positions, the translator runs `aromatize()` to perceive
  aromaticity).
- `kind: "aromatic"` is reserved for non-image producers that already
  know aromaticity (e.g. a name-to-structure skill).
- `kind: "aliphatic"` is a hint that the ring has no double bonds; the
  bond table is still authoritative.
- **Fused rings MUST share their fusion atoms in BOTH ring entries.** A ring
  fused to a neighbor along an edge lists the two (or more) shared edge atom-ids
  in the `atoms[]` of EVERY ring that shares them. Rings declared as disjoint
  atom-id blocks (no shared ids) describe a NON-fused system — separate rings,
  spiro (1 shared atom), or a mis-transcription. Declaring a fused core as
  disjoint blocks is the dense-connectivity failure the build rejects (see
  [dense-core-protocol.md](../heimdall-image-rebuild/dense-core-protocol.md)).
- `counts.rings` is the **Euler ring count** (`bonds − atoms + components`) and
  equals `rings.length` (rule #9). The build cross-checks the declared count
  against the built canvas; `validate_graph` additionally emits a pre-build
  `ring_incoherent` warning when the declared rings under-count the cycles your
  `bonds[]` form, or when ≥2 bonds cross between rings you declared as sharing
  fewer than 2 atoms (an under-declared fusion).

## `counts`

```ts
interface IntentCounts {
  heavy: number;
  rings: number;
  heteroatoms: Record<string, number>;            // per-element + 'halogens' bucket
  drawn_H_atoms?: number[];                       // ids of atoms with non-null drawn_H
  degree_sequence?: Array<[string, number]>;      // per-atom (element, sum of bond orders)
}
```

See [count-contract.md](count-contract.md) for the counting protocol +
worked examples. `counts.rings` is the **Euler ring count**
(`bonds − atoms + components`), NOT a tally of drawn faces — the two agree
for fused systems but diverge for bridged cages (see count-contract.md).
The validator cross-checks `counts` against the atom table
(atoms.length === heavy, etc.); the translator additionally checks the
observed canvas counts after build.

## Self-consistency rules (validator)

1. Every `bond.a` / `bond.b` references an existing `atom.id`.
2. Every `bond` has unique `(a, b)` pair (no duplicate edges).
3. No self-loops (`bond.a !== bond.b`).
4. Every `ring.atoms[i]` references an existing `atom.id`.
5. `bond.wedge_from` is null iff `bond.wedge` is null.
6. When set, `bond.wedge_from` equals `bond.a` or `bond.b`.
7. When `bond.wedge` is set, `bond.order` is 1.
8. `counts.heavy === atoms.length`.
9. `counts.rings === rings.length`.
10. `counts.heteroatoms` totals match non-C heavy-atom tally (halogens
    bucketed).
11. Unknown top-level / nested fields are rejected.
12. An atom that supplies one of `x` / `y` must supply both.
13. Every wedge cluster (chiral atom + its bonded neighbors) must be
    fully coord-specified whenever `bond.wedge` is set.
14. `bond.geom != null` requires `bond.order === 2`.
15. `bond.geom` and `bond.wedge` are mutually exclusive on a single bond
    entry.
16. When `counts.drawn_H_atoms` is supplied, the id set must equal
    `{ atom.id : atom.drawn_H != null }`.
17. When `counts.degree_sequence` is supplied, it must equal the
    validator-computed per-atom `[element, sum of bond orders]`, sorted
    lexicographically.
18. When an atom carries `wedge_to_implicit_h != null`, the atom AND
    every heavy neighbor in `bonds[]` must be coord-pinned (same
    chiral-cluster surface as the wedge-cluster rule). `stereo_unknown`
    has no structural constraint.

## Translator order (load-bearing)

The `build_from_graph` translator executes the GraphIntent in this
fixed order. Skill-side producers do not invoke these primitives
directly — they emit the JSON and trust the translator.

1. **Skeleton** — per connected component, seed via `addFragment` of a
   single-atom SMILES, then walk outward via
   `addAtomWithSingleBond`, finally close rings via `addBond`.
2. **Element overrides** — `setAtomElement` for any atom whose element
   differs from the seed's element (no-op if skeleton already matches).
3. **Bond orders** — `setBondOrder` for any bond with `order > 1`.
4. **Normalize + pin coords** (only when any atom carries `x, y`):
   centre the coord cluster, rescale so mean bond length is 1.5 model
   units, flip y (image-down → model-up), then `setAtomXY` each
   coord-bearing atom. This pin is what makes wedges / `bond.geom`
   reproducible at export time.
5. **Aromatize** — `aromatize()` (perceives aromatic rings from Kekulé).
6. **Drawn H** — `setAtomImplicitHCount` for any atom with non-null
   `drawn_H` (applied after aromatize so it survives the aromaticity-
   aware valence clamp).
7. **Charges** — `setAtomCharge` for any non-zero charge.
8. **Radicals** — `setAtomRadical` with `radicalCodeFromCount(count)`.
9. **Bond geom (E/Z)** — for any bond with non-null `geom`, the
   label-authoritative planner honors the declared `cis`/`trans` against the
   post-build coordinate frame. The agent-facing carrier is `bond.geom:
   'cis' | 'trans'` ONLY — the agent never calls
   `setBondStereo(…, 'cis_trans')` (that low-level int is rejected on the
   agent surface, and pushing it onto the bond stereo flag corrupts Indigo's
   SMILES writer).
10. **Wedge-to-implicit-H** — for each atom with non-null
    `wedge_to_implicit_h`, materialize one implicit H as an explicit
    H atom, position it opposite the heavy-neighbor centroid, and apply
    the wedge via `setWedgeBond(parent, newH, wedge)`. `stereo_unknown`
    is metadata-only — no canvas mutation.
11. **Wedges** — `setWedgeBond(chiralAtomId, neighborAtomId, wedge)` for
    every bond with non-null `wedge`.
12. **Count check** — `computeCounts(state)` vs `graph.counts`; mismatch
    throws `BuildFromGraphError("count_mismatch", diff)` and
    `runtime.applyMutation` rolls the canvas back.
13. **Layout** — `clean()` runs when `layout === 'clean'`, OR when
    `layout === 'auto'` AND no atom carries coords, OR when `layout === 'auto'`
    AND the graph is a **dense fused core carrying wedge stereo**
    (`isDenseDraft` ∧ `hasWedgeStereo`) — the dense relayout: the backend owns
    the final frame so by-eye coord-CW errors heal. On a sparse coord-bearing
    graph `clean()` does not run, so the pinned frame survives to export.

(Stereo-projection translator steps — `layoutPolicy: "ketcher_clean_locked"`
partition, `compileWedge`, R/S-label solver — run only when `stereoTransfer`
is present; see [stereo-policy.md](../heimdall-image-rebuild/stereo-policy.md).)

## Producers + consumer

- **Producers** (emit GraphIntent): `heimdall-image-rebuild` (vision —
  the direct GraphIntent is the one submission shape); future
  `ketcher-name-to-structure`; future hand-drawn parse.
- **Consumer** (single): `build_from_graph` MCP tool.

Each future producer is a separate SKILL; they all share this schema
+ the translator. The chemistry rules live exactly once — in Ketcher's
implementation of these primitives.
