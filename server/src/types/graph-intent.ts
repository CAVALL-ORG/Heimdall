import { z } from 'zod';

const ELEMENT_PATTERN = /^[A-Z][a-z]?$/;

// ── ADR-0002 — shorthand-glyph expansion provenance (W1) ─────────────────
// One off-table glyph's declared expansion, in the SAME table-entry shape the
// deterministic shorthand table emits (`ShorthandSubgraph` in
// `adapter/visual-graph/shorthand-table.ts`: `decomposeShorthand()`'s success
// return). Mirrored here field-for-field so the types module stays decoupled
// from the adapter (no import of the table). The agent supplies "the table
// entry the table lacks"; W2 wires `expandShorthand` to splice it via the same
// path the table entries take. Atom ids are LOCAL (0-indexed) into `atoms`,
// exactly like the table's local subgraph.
const shorthandExpansionAtomSchema = z
  .object({
    element: z.string().regex(ELEMENT_PATTERN, 'element must be a 1-2 char symbol like C / Cl'),
    drawn_H: z.number().int().min(0).max(8).optional(),
    // LOCK 23: nuclear mass number for isotope-labeled atoms (¹³C → 13).
    isotope: z.number().int().positive().optional(),
  })
  .strict();

const shorthandExpansionBondSchema = z
  .object({
    a: z.number().int().nonnegative(),
    b: z.number().int().nonnegative(),
    order: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  })
  .strict();

export const shorthandExpansionSchema = z
  .object({
    atoms: z.array(shorthandExpansionAtomSchema).min(1),
    bonds: z.array(shorthandExpansionBondSchema),
    /** Index in `atoms` of the atom that attaches to the parent (anchor). */
    attachment_atom_offset: z.number().int().nonnegative(),
  })
  .strict();

export type ShorthandExpansion = z.infer<typeof shorthandExpansionSchema>;

// ADR-0002 — declared provenance for an OFF-table glyph expansion. Optional,
// additive: a row whose glyphs are all in the deterministic table omits it and
// stays byte-identical (the fast-on-easy invariant). It records WHO supplied
// the meaning the table lacks:
//   - `paper_legend`   — the glyph was resolved against the paper's own
//                        declared abbreviation key; `legend_ref` cites the run
//                        glyph-dictionary entry (which carries the page/region).
//   - `agent_inference`— the agent expanded it from chemistry knowledge; NO
//                        `legend_ref` (none exists).
// `expansion` is the table-entry-shaped subgraph (same shape the table emits).
// Structural rules (legend_ref presence, must-co-occur-with-`shorthand`) are
// enforced by `intentAtomSchema`'s superRefine below. The table-collision rule
// (reject a glyph the table ALREADY covers — table wins, one source per glyph)
// is semantic and lives in the validator path (it needs the table); see
// `validate.ts` / `shorthand-expand.ts`. W2 wires `expandShorthand` to consume
// `expansion`; this slice is schema + structural validation ONLY.
export const shorthandResolutionSchema = z
  .object({
    source: z.union([z.literal('paper_legend'), z.literal('agent_inference')]),
    expansion: shorthandExpansionSchema,
    // REQUIRED iff source === 'paper_legend' (enforced in superRefine). Id into
    // the per-run glyph dictionary, which carries the page/region citation.
    legend_ref: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();

export type ShorthandResolution = z.infer<typeof shorthandResolutionSchema>;

export const intentAtomSchema = z
  .object({
    id: z.number().int().nonnegative(),
    element: z.string().regex(ELEMENT_PATTERN, 'element must be a 1-2 char symbol like C / Cl'),
    // Task 5F — shorthand-glyph carrier. RAW TEXT the agent read on a
    // collapsed glyph node (`OMe`, `Ph`, `Et`, `iPr`, `tBu`, `Boc`, `Ts`, …).
    // The agent NEVER decomposes; the backend expands this verbatim via the
    // deterministic shorthand table (`adapter/visual-graph/shorthand-table.ts`)
    // during a pre-skeleton pass in the translator. When `shorthand` is set:
    //   - `element` is a REQUIRED placeholder that is IGNORED (the schema still
    //     enforces the 1-2 char shape so callers keep emitting a syntactically
    //     valid token; convention is a neutral `'C'`). The shorthand node is
    //     deleted during expansion and replaced by the decomposed atoms, so
    //     its `element` is never read downstream.
    //   - `drawn_H` / `charge` / `radical` / `isotope` on the placeholder are
    //     likewise ignored — the expansion table owns the H counts of the
    //     expanded atoms.
    // Unknown shorthand (not in the table, not a bare element, not an isotope)
    // surfaces as an `unknown_shorthand` diagnostic at validate_graph and a
    // schema_invalid build error — the agent zooms and re-emits explicit atoms
    // or refuses. The verbatim glyph text is the ONLY transcription the agent
    // owns; the heavy-atom expansion is backend-deterministic (LOCK 11).
    shorthand: z.string().min(1).optional(),
    // ADR-0002 (W1) — declared provenance for an OFF-table glyph. Optional +
    // additive; only valid on an atom that ALSO carries `shorthand` (the glyph
    // text being resolved). See shorthandResolutionSchema above for the link
    // semantics and the superRefine below for the structural rules. The
    // table-collision rule (glyph already in the table) is semantic and lives
    // in the validator path, NOT here (it needs the adapter table).
    shorthand_resolution: shorthandResolutionSchema.optional(),
    drawn_H: z.number().int().min(0).max(8).nullable(),
    charge: z.number().int().min(-4).max(4),
    radical: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    ring: z.string().nullable(),
    x: z.number().optional(),
    y: z.number().optional(),
    // Wedge bond drawn to an implicit-H vertex on this atom. Translator
    // promotes one implicit H to an explicit H atom, bonds it, and applies
    // the wedge from this atom to the new H. Schema keeps the H as part of
    // the parent's H count; only the wedge target materializes.
    wedge_to_implicit_h: z
      .union([z.literal('solid'), z.literal('hashed')])
      .nullable()
      .optional(),
    // Agent could not confidently read wedge polarity at this atom.
    // Last-resort flag — default is commit. Translator no-op; grader treats
    // the center as match-any when checking stereo.
    stereo_unknown: z.boolean().optional(),
    // DEPRECATED + optional. Historically required by validate_graph's LOCK-24
    // orphan-wedge check, but the build path never read it (the translator derives
    // the stereocenter from wedge_from directly), so the check was removed. Still
    // accepted for back-compat; agents should OMIT it.
    stereo: z.union([z.literal('declared'), z.null()]).optional(),
    // LOCK 23: nuclear mass number for isotope labels (¹³C → 13, ²H → 2,
    // ¹⁵N → 15, etc.). Optional; backend defaults to natural abundance.
    isotope: z.number().int().positive().optional(),
    // LOCK 23: maps to Ketcher's MDL stereo-group atom field. Captures
    // printed `(R)`/`(S)`/`abs`/`rel`/`or<N>`/`and<N>` labels on the source.
    stereo_group: z
      .object({
        kind: z.union([
          z.literal('abs'),
          z.literal('rel'),
          z.literal('or'),
          z.literal('and'),
        ]),
        id: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    // LOCK 5 atom-level placeholders. Each `needs_zoom` requires a matching
    // unresolved[] entry on the GraphIntent. Closes the tautomer/protomer/
    // drawn-H drift class (D035 metformin / D040 histidine / D046 cytosine).
    drawn_H_confidence: z
      .union([z.literal('high'), z.literal('needs_zoom')])
      .optional(),
    charge_confidence: z
      .union([z.literal('high'), z.literal('needs_zoom')])
      .optional(),
    radical_confidence: z
      .union([z.literal('high'), z.literal('needs_zoom')])
      .optional(),
  })
  .strict()
  // ADR-0002 (W1) — pure-structural rules for `shorthand_resolution`. The
  // table-collision rule (glyph already covered by the deterministic table) is
  // semantic and enforced in the validator path; it is NOT here because it
  // would couple this types module to the adapter table.
  .superRefine((atom, ctx) => {
    const res = atom.shorthand_resolution;
    if (res === undefined) return;
    // Rule: a resolution may only ride an atom that also carries the `shorthand`
    // glyph text it resolves. Without the glyph there is nothing to resolve.
    if (atom.shorthand === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shorthand_resolution'],
        message:
          'shorthand_resolution requires `shorthand` on the same atom (the glyph text being resolved)',
      });
    }
    // Rule: legend_ref present iff source === 'paper_legend'. Required for a
    // paper_legend resolution (cites the run glyph-dictionary entry); forbidden
    // for agent_inference (no legend entry exists for an inferred expansion).
    if (res.source === 'paper_legend' && res.legend_ref === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shorthand_resolution', 'legend_ref'],
        message: "legend_ref is required when source === 'paper_legend'",
      });
    }
    if (res.source === 'agent_inference' && res.legend_ref !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shorthand_resolution', 'legend_ref'],
        message: "legend_ref is forbidden when source === 'agent_inference'",
      });
    }
  });

export const intentBondSchema = z
  .object({
    a: z.number().int().nonnegative(),
    b: z.number().int().nonnegative(),
    order: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    wedge: z.union([z.literal('solid'), z.literal('hashed')]).nullable(),
    wedge_from: z.number().int().nonnegative().nullable(),
    geom: z.union([z.literal('cis'), z.literal('trans')]).nullable().optional(),
  })
  .strict();

export const intentRingSchema = z
  .object({
    id: z.string().min(1),
    atoms: z.array(z.number().int().nonnegative()).min(3),
    kind: z.union([z.literal('kekule'), z.literal('aromatic'), z.literal('aliphatic')]),
  })
  .strict();

// Phase 2 / Task E — dense polycycle partial-draft path. Allows the agent
// to declare `counts.heavy` / `counts.rings` with explicit confidence so
// validate-graph can advance rounds while the agent still iterates on
// unresolved regions. Bare-number form is preserved for back-compat —
// every existing fixture / row that wrote `heavy: 25` keeps working.
// `readCountValue` normalizes both forms at the consumption seam (see
// validate.ts:256, validator.ts:236, translator counts checks).
export const countWithConfidenceSchema = z.union([
  z.number().int().nonnegative(),
  z
    .object({
      value: z.number().int().nonnegative(),
      confidence: z.union([z.literal('high'), z.literal('needs_zoom')]),
    })
    .strict(),
]);

export type CountWithConfidence = z.infer<typeof countWithConfidenceSchema>;

/**
 * Normalize a `counts.heavy` / `counts.rings` field to its `{ value,
 * isNeedsZoom }` form. Bare numbers map to `{ value, isNeedsZoom: false }`.
 * Object form returns `{ value, isNeedsZoom: confidence === 'needs_zoom' }`.
 *
 * Consumers MUST go through this helper rather than reading `.value` or
 * branching on typeof — that keeps the schema-shape decision in one
 * place if we later add more confidence tiers.
 */
export function readCountValue(c: CountWithConfidence): {
  value: number;
  isNeedsZoom: boolean;
} {
  if (typeof c === 'number') {
    return { value: c, isNeedsZoom: false };
  }
  return { value: c.value, isNeedsZoom: c.confidence === 'needs_zoom' };
}

export const intentCountsSchema = z
  .object({
    heavy: countWithConfidenceSchema,
    rings: countWithConfidenceSchema,
    // LOCK 14 + LOCK 16: explicit components count for multi-component
    // scenes (salts, counterions). validate_graph cross-checks against
    // computed components from declared bonds.
    components: z.number().int().nonnegative().optional(),
    heteroatoms: z.record(z.string(), z.number().int().nonnegative()),
    drawn_H_atoms: z.array(z.number().int().nonnegative()).optional(),
    degree_sequence: z
      .array(z.tuple([z.string(), z.number().int().nonnegative()]))
      .optional(),
  })
  .strict();

// --- v3 local parity-transfer stereo (layoutPolicy "ketcher_clean_locked") ---
// One stereocenter's drawing-native stereo facts (v3 doc §6, §9.1). The
// translator's StereoTransferCompiler reconciles these against Ketcher's
// frozen post-clean layout. Entries carry geometry only — never R/S, @/@@, or
// any CIP assignment (`.strict()` + the absence of any such field enforces it).
export const wedgePrimitiveStereoEntrySchema = z
  .object({
    // The stereocenter atom id.
    center: z.number().int().nonnegative(),
    // All drawn (explicit) neighbors, clockwise as seen in the source image.
    // Length 3 (one implicit H) or 4 (fully substituted).
    drawnNeighborsCW: z.array(z.number().int().nonnegative()).min(3).max(4),
    // The drawn neighbor carrying the wedge. Normally a member of
    // drawnNeighborsCW. When `wedgeToImplicitH: true`, it instead refers to
    // the (not-yet-materialized) implicit hydrogen on `center` and is NOT a
    // member of `drawnNeighborsCW`. The numeric id is the agent's chosen id
    // for the H; the translator materializes one explicit H and applies the
    // compiled wedge to it.
    outOfPlaneNeighbor: z.number().int().nonnegative(),
    // Whether outOfPlaneNeighbor projects toward or away from the viewer.
    // LOCK 22: facing extends to 'wavy' / 'unknown' for epimer mixtures or
    // unreadable wedges after zoom. Backend maps both to stereo_unknown
    // (HISTORY row 8). validate_graph accepts without throwing; chemistry_gate
    // handles iso_match honestly.
    facing: z.union([
      z.literal('toward'),
      z.literal('away'),
      z.literal('wavy'),
      z.literal('unknown'),
    ]),
    // Drawing convention.
    //   "wedge"   — skeletal wedge/hash drawing (v3 core).
    //   "haworth" — Haworth projection (sugars: substituent drawn above/below
    //               the ring line). Requires `verticalSense`.
    //   "fischer" — Fischer projection (horizontal bonds point toward viewer,
    //               vertical bonds point away). Requires `verticalSense`.
    projection: z.union([
      z.literal('wedge'),
      z.literal('haworth'),
      z.literal('fischer'),
    ]),
    // Agent self-rated transcription confidence; diagnostic only, does not gate.
    confidence: z.number().min(0).max(1),
    // Additive optional (W1). When true, the wedge in this entry points at the
    // stereocenter's implicit H rather than at one of the three real drawn
    // neighbors. `drawnNeighborsCW` carries the three real drawn neighbors;
    // `outOfPlaneNeighbor` is the agent-chosen id for the H and is NOT a
    // member of `drawnNeighborsCW`. The translator materializes one explicit
    // H on `center` and applies the compiled wedge to that H bond. Use this
    // for ring-junction H wedges (e.g. cholesterol C8/C9/C14/C17).
    wedgeToImplicitH: z.boolean().optional(),
    // Additive optional (W2). Required when `projection` is `"haworth"` or
    // `"fischer"`. For Haworth: `"up"` when the stereo-bearing substituent is
    // drawn ABOVE the ring line, `"down"` when below. For Fischer: `"up"` /
    // `"down"` describes the orientation of the vertical bond carrying
    // `outOfPlaneNeighbor` (vertical-up vs vertical-down). The compiler maps
    // this single pixel bit through one global calibration constant
    // (HAWORTH_VERTICAL_TOWARD) to a wedge-projection `facing`, then routes
    // through the standard parity-transfer path. Ignored for
    // `projection: "wedge"`.
    verticalSense: z.union([z.literal('up'), z.literal('down')]).optional(),
    // Predecessor Fix 1 — explicit-skip flag. When `true`, the validator
    // accepts the center as accounted-for without applying any wedge. The
    // grader treats this center as match-any. Semantically equivalent to a
    // `stereoLabelEntry` with `stereo_label: 'unknown'`.
    stereo_unknown: z.boolean().optional(),
  })
  .strict();

// R/S-direct entry (handoff-rs-direct §A). Carries one of R / S / unknown /
// beyond_protocol for the named center. The translator's per-center CIP
// solver picks a wedge configuration that produces the target R/S.
// `unknown` is the explicit-skip form (no wedge applied). `beyond_protocol`
// (Stage 5a of PLAN-a004-class-robustness-2026-05-22) is the refusal class
// for stereo features outside the current protocol — axial chirality,
// allene, chair-without-coords, hypervalent, indigo-indeterminate. The
// translator treats it like `unknown` for the build-completion check (no
// wedge applied, no V2000 flag) but the build response's
// `confidence_per_center` records `mode_used: 'beyond_protocol'` and
// `agreement: 'unknown'` so downstream reporters can surface the refusal
// distinctly from a generic `unknown`. The grader's
// `beyond_protocol_gate` reads the agent's declared reasons and emits a
// row-level `refuse-with-reason` verdict. Pure label — no geometry.
export const stereoLabelEntrySchema = z
  .object({
    center: z.number().int().nonnegative(),
    stereo_label: z.union([
      z.literal('R'),
      z.literal('S'),
      z.literal('unknown'),
      z.literal('beyond_protocol'),
    ]),
    // Required when `stereo_label === 'beyond_protocol'`. One of the five
    // graph-level detector classes from PLAN-a004-class-robustness-2026-05-22
    // §E.G3 — the agent does not chemistry-reason; the GraphIntent surfaces
    // exactly which structural pattern triggered the refusal so the
    // row-level reporter can attribute the partial answer.
    beyond_protocol_reason: z
      .union([
        z.literal('axial_chirality'),
        z.literal('allene'),
        z.literal('chair_without_coords'),
        z.literal('hypervalent'),
        z.literal('indigo_indeterminate'),
      ])
      .optional(),
  })
  .strict();

// Discriminated union over the two transcription modes. zod tries each branch
// in order; the schema is unambiguous because the stereoLabel branch has only
// `center` + `stereo_label` while the wedge-primitive branch lacks
// `stereo_label` and has the geometry fields.
export const stereoTransferEntrySchema = z.union([
  stereoLabelEntrySchema,
  wedgePrimitiveStereoEntrySchema,
]);

// Representation-neutral stereo observation ledger. Carries what the agent
// visually read from the source (or Step-0 canvas), independent of the backend
// encoding path selected later (wedge primitives vs R/S labels).
export const stereoObservationSchema = z
  .object({
    center: z.number().int().nonnegative(),
    representation: z.union([
      z.literal('wedge_hash'),
      z.literal('implicit_h_wedge'),
      z.literal('projection_haworth'),
      z.literal('projection_fischer'),
      z.literal('double_bond_geom'),
      z.literal('rs_label'),
      z.literal('unknown'),
    ]),
    represented_neighbor: z.number().int().nonnegative().nullable().optional(),
    direction: z
      .union([
        z.literal('toward'),
        z.literal('away'),
        z.literal('up'),
        z.literal('down'),
        z.literal('cis'),
        z.literal('trans'),
        z.literal('unknown'),
      ])
      .optional(),
    confidence: z.number().min(0).max(1).optional(),
    zoom_used: z.boolean().optional(),
    source_frame: z.union([z.literal('source_image'), z.literal('step0_canvas')]).optional(),
    explicit_skip: z.boolean().optional(),
    source_limited_reason: z.string().min(1).optional(),
  })
  .strict();

export type WedgePrimitiveStereoEntry = z.infer<typeof wedgePrimitiveStereoEntrySchema>;
export type StereoLabelEntry = z.infer<typeof stereoLabelEntrySchema>;
export type StereoTransferEntry = z.infer<typeof stereoTransferEntrySchema>;
export type StereoObservation = z.infer<typeof stereoObservationSchema>;
// TopologyLedger / CoverageCheck / DirectPathAdmissionCertificate types
// deleted 2026-05-26 with their schemas (dense state machine).

export function isStereoLabelEntry(e: StereoTransferEntry): e is StereoLabelEntry {
  return 'stereo_label' in e;
}

export function isWedgePrimitiveEntry(
  e: StereoTransferEntry,
): e is WedgePrimitiveStereoEntry {
  return 'drawnNeighborsCW' in e;
}

// LOCK 5: GraphIntent gains a top-level `unresolved[]` array (was previously
// worksheet-only). Direct GraphIntent rows can now carry placeholders.
// Mirrors the worksheet's VisualUnresolved schema.
export const graphIntentUnresolvedSchema = z
  .object({
    field: z.union([
      z.literal('node_kind'),
      z.literal('node_glyph_text'),
      z.literal('segment_endpoint'),
      z.literal('segment_type'),
      z.literal('wedge_orientation'),
      z.literal('ez_geometry'),
      z.literal('loop_membership'),
      z.literal('loop_relationship'),
      z.literal('attachment_anchor'),
      z.literal('drawn_H'),
      z.literal('charge'),
      z.literal('radical'),
    ]),
    record_id: z.string().min(1),
    note: z.string().min(1),
    state: z.union([z.literal('needs_zoom'), z.literal('source_limited')]),
    source_limited_reason: z.string().optional(),
  })
  .strict();

export type GraphIntentUnresolved = z.infer<typeof graphIntentUnresolvedSchema>;

// Coarse "I cannot confidently read this area" escape box (Task 5A). The
// agent draws an approximate circle (source-image pixel coords, LOCK 8
// top-left origin / Y-down; `radius` in pixels) around a region it could not
// transcribe, plus a free-text pixel-cue note. This is the coarse replacement
// for the worksheet's fine-grained per-record `unresolved[]`/`needs_zoom`
// machinery (it won the transcription probe). ADVISORY: `validate_graph`
// surfaces each box as a crop target (coverage_regions) so the agent can zoom
// it; it never blocks build and never flips `ok`. Note is free-form pixel
// language only — never chemistry-naming (same contract as CROP_RATIONALE).
export const unsureRegionSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    radius: z.number().nonnegative(),
    note: z.string().min(1),
  })
  .strict();

export type UnsureRegion = z.infer<typeof unsureRegionSchema>;

// ── Tranche-B′ committed-ports black box (dense-stitch fix) ──────────────
// PLAN-dense-stitch-blackbox-experiments-v2-2026-05-31 + report
// 2026-05-31-dense-stitch-blackbox-gates. ONE optional, dense-gated carrier.
// Easy rows OMIT it → byte-identical (the fast-on-easy invariant). It carries
// the agent's COMMITTED perimeter (`boundary_atoms`, GLOBAL ids on the declared
// scaffold) plus the fusion-bond PORTS crossing that perimeter. The backend:
//   (1) FREEZES it across validate rounds — once committed, later rounds may
//       only ADD interior; deleting/relabeling a committed boundary atom or
//       re-pointing a port is a structural rejection (the lever, per G3: the
//       freeze — not the orientation framing — is what recovers the wiring;
//       prompt-only "commit skeleton first" was disconfirmed, so this is
//       enforced STRUCTURALLY, not by prose). Lives in validate.ts (row-state).
//   (2) CHECKS coherence at preflight AND build (validateBlackBoxRegions):
//       every boundary/port atom exists; each port has a matching crossing
//       bond out of the region. FP=0 by construction — it can only reject a
//       self-contradictory submission. Lives in validator.ts (single source).
// `local_frame` is the LIGHT cw/ccw handedness flag (G3: the flag read at 8/8
// agreement; a full walk-order buys nothing). Infers NO chemistry — the splice
// is a mechanical attachment of declared ports.
export const blackBoxPortSchema = z
  .object({
    id: z.string().min(1),
    // A committed perimeter atom (must be a member of the region's
    // boundary_atoms) that a fusion/crossing bond leaves through.
    boundary_atom: z.number().int().nonnegative(),
    order: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    // Light handedness flag anchored to the fusion bond (G3 orientation grade).
    // Diagnostic/orientation payload only; never an R/S or CIP assignment.
    local_frame: z.union([z.literal('cw'), z.literal('ccw')]).nullable().optional(),
  })
  .strict();

export const blackBoxRegionSchema = z
  .object({
    id: z.string().min(1),
    boundary_atoms: z.array(z.number().int().nonnegative()).min(2),
    ports: z.array(blackBoxPortSchema).min(1),
    status: z.union([z.literal('open'), z.literal('resolved')]),
  })
  .strict();

export type BlackBoxPort = z.infer<typeof blackBoxPortSchema>;
export type BlackBoxRegion = z.infer<typeof blackBoxRegionSchema>;

export const graphIntentSchema = z
  .object({
    version: z.literal(1),
    label: z.string().optional(),
    // LOCK 14: panel_index disambiguates multi-molecule source images.
    panel_index: z.number().int().nonnegative().optional(),
    atoms: z.array(intentAtomSchema).min(1),
    bonds: z.array(intentBondSchema),
    rings: z.array(intentRingSchema),
    counts: intentCountsSchema,
    // LOCK 5: top-level unresolved[] array. Every record with
    // confidence:'needs_zoom' (on atom drawn_H_confidence / charge_confidence /
    // radical_confidence, or bond stereo) requires a matching entry here.
    unresolved: z.array(graphIntentUnresolvedSchema).optional(),
    // Task 5A — coarse `unsure_regions` escape boxes. Advisory: validate_graph
    // surfaces each as a crop target; never blocks build, never flips ok.
    unsure_regions: z.array(unsureRegionSchema).optional(),
    // Tranche-B′ committed-ports black box (dense-stitch fix). Optional + dense-
    // gated → easy rows omit it (byte-identical). Frozen across validate rounds
    // + coherence-checked at build. See blackBoxRegionSchema above.
    black_box_regions: z.array(blackBoxRegionSchema).optional(),
    // When "ketcher_clean_locked" the translator runs the v3 doc §8 pipeline
    // (flat build → clean → freeze coords → compile wedges). Required for
    // intents with K >= 3 stereocenters; such intents must carry no
    // stereo-critical pixel coordinates.
    layoutPolicy: z.literal('ketcher_clean_locked').optional(),
    // One StereoTransferEntry per stereocenter (v3 doc §6).
    stereoTransfer: z.array(stereoTransferEntrySchema).optional(),
    // Optional representation-neutral stereo evidence ledger. The wedge-
    // primitive build path consumes `stereoTransfer`; `stereoObservations`
    // carries the original visual marks for forensics.
    stereoObservations: z.array(stereoObservationSchema).optional(),
    // topologyLedger / coverageCheck / directPathAdmission / stereoMode
    // removed 2026-05-26 — dense state machine deleted. Mode C selective
    // V2000 solver re-apply handles K>=9 without ledger/admission gating.
    // All builds commit stereo on the first call (no two-phase deferred).
  })
  .strict();

export type IntentAtom = z.infer<typeof intentAtomSchema>;
export type IntentBond = z.infer<typeof intentBondSchema>;
export type IntentRing = z.infer<typeof intentRingSchema>;
export type IntentCounts = z.infer<typeof intentCountsSchema>;
export type GraphIntent = z.infer<typeof graphIntentSchema>;

export const HALOGEN_ELEMENTS = new Set(['F', 'Cl', 'Br', 'I']);

/**
 * Element symbols Ketcher's molfile / SMILES parser accepts as bare-atom
 * tokens. Used by `decomposeShorthand` to pass through single-element
 * glyph nodes (e.g. paclitaxel's bare `O` ester / hydroxyl oxygens)
 * without falling into the `unknown_shorthand` diagnostic.
 *
 * Scope: common organic + main-group + first-row transition metals
 * already observed in repo fixtures. Do not bloat with rare-earths
 * unless a real fixture needs them.
 */
export const KNOWN_ELEMENT_SYMBOLS: ReadonlySet<string> = new Set([
  'H',
  'B', 'C', 'N', 'O', 'F',
  'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl',
  'K', 'Ca', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn',
  'As', 'Se', 'Br',
  'Pd', 'Pt', 'Ag', 'Cd', 'In', 'Sn', 'Sb', 'Te', 'I',
  'Au', 'Hg', 'Pb',
  'Li', 'Be',
]);

export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}
