/**
 * StereoTransferCompiler — local parity-transfer stereo (v3 core).
 *
 * Theory (image_to_smiles_stereo_connectivity_implementation_instructions_v3.md
 * §3): a stereocenter's chirality in a 2D depiction is a function of exactly
 * three things — the cyclic order of the drawn neighbors, which neighbor
 * carries the out-of-plane indicator, and whether that neighbor faces toward
 * or away from the viewer. It does NOT depend on absolute coordinates.
 *
 * The agent transcribes, per stereocenter, the clockwise order of the drawn
 * neighbors as seen in the source image plus the wedge (outOfPlaneNeighbor +
 * facing). Ketcher builds the flat skeleton, runs clean() once, and freezes a
 * globally consistent 2D layout. This compiler reads the frozen layout,
 * recomputes the clockwise neighbor order from Ketcher's coordinates, compares
 * the two cyclic orders per stereocenter, and flips the facing when Ketcher
 * mirrored that center. Every step is local: each stereocenter is reconciled
 * against its own neighborhood only.
 *
 * The implicit hydrogen never appears here — see §3.3 of the v3 doc: it is the
 * dependent fourth slot, placed identically by Indigo on both sides of the
 * comparison, so it cancels. An implicit-H center contributes a 3-element
 * drawnNeighborsCW; a quaternary center contributes a 4-element one;
 * comparisonTriple reduces both to a clean 3-neighbour comparison set.
 *
 * This module is pure — no Ketcher, no I/O. The translator
 * (layoutPolicy: "ketcher_clean_locked") feeds it frozen coordinates and
 * applies the CompiledWedge results via set_wedge_bond.
 */

// Matches the schema's wedgePrimitiveStereoEntry.facing union. 'wavy' /
// 'unknown' are unreadable-wedge declarations the translator normalizes to
// stereo_unknown BEFORE compileWedge runs (LOCK 22); compileWedge additionally
// fails closed on them rather than coercing toward/away (see the guard there).
export type Facing = 'toward' | 'away' | 'wavy' | 'unknown';
export type Projection = 'wedge' | 'haworth' | 'fischer';

/** One stereocenter's drawing-native stereo facts (v3 doc §6, §9.1). */
export type StereoTransferEntry = {
  /** The stereocenter atom id. */
  center: number;
  /**
   * All drawn (explicit) neighbors, in clockwise visual order as seen in the
   * source image. Length 3 (one implicit H) or 4 (fully substituted).
   */
  drawnNeighborsCW: number[];
  /**
   * The drawn neighbor carrying the wedge. Normally a member of
   * drawnNeighborsCW. When `wedgeToImplicitH` is `true` it instead refers to
   * the (not-yet-materialized) implicit H on `center` and is NOT a member of
   * `drawnNeighborsCW`.
   */
  outOfPlaneNeighbor: number;
  /** Whether outOfPlaneNeighbor projects toward or away from the viewer. */
  facing: Facing;
  /** Drawing convention. "wedge" is the v3 core; "haworth"/"fischer" route via projection-adapter. */
  projection: Projection;
  /** Agent self-rated transcription confidence 0-1. Diagnostic only; does not gate. */
  confidence: number;
  /**
   * W1 — wedge points at the implicit H on `center`. `outOfPlaneNeighbor` is
   * an agent-chosen id for the H and is NOT a member of `drawnNeighborsCW`.
   * The translator materializes an explicit H and the wedge is applied there.
   * The comparison triple is the three real drawn neighbors unchanged (v3
   * §3.3: the implicit H is the dependent fourth slot and cancels from parity).
   */
  wedgeToImplicitH?: boolean;
  /**
   * W2 — for Haworth/Fischer projections, the agent's single pixel bit for the
   * stereo-bearing substituent: "up" means drawn above the Haworth ring line
   * (or vertical-up in Fischer); "down" means below (or vertical-down).
   * Required when `projection` is `"haworth"` / `"fischer"`; ignored
   * otherwise. Mapped to wedge-projection `facing` via a single global
   * calibration constant (`HAWORTH_VERTICAL_TOWARD`).
   */
  verticalSense?: 'up' | 'down';
};

/** Frozen post-clean() coordinate set, keyed by the same id space as the entries. */
export type FrozenCoords = Record<number, { x: number; y: number }>;

/** The translator applies this via set_wedge_bond(center, outOfPlaneNeighbor, wedge). */
export type CompiledWedge = {
  center: number;
  outOfPlaneNeighbor: number;
  wedge: 'solid' | 'hashed';
};

export type Parity = 'same' | 'opposite' | 'error';

/**
 * Single global calibration constant (v3 doc §10). Determined ONCE, empirically,
 * by the Section 12 experiment — never per-center, never per-run.
 *
 * clockwiseNeighborOrderFromCoords assumes Ketcher's get_state coordinates are
 * Cartesian y-up, so visual clockwise is decreasing atan2. If the Section 12
 * experiment shows ALL stereocenters inverted, the convention is globally
 * flipped and this is set to true. A MIX of correct/inverted centers is a real
 * bug, not a calibration issue — do not flip the constant for that.
 *
 * RESOLVED VALUE: `true`. The Section 12 experiment (penicillin G, fixture
 * A002) confirmed Variant C reproduces the known (2S,5R,6R) stereochemistry
 * with this constant set to `true`; with `false` every center inverts. The
 * reason is that Ketcher's `get_state` coordinates use a y-DOWN screen
 * convention, so visual clockwise corresponds to ASCENDING `atan2` — the
 * reverse of the naive y-up assumption. See
 * `.claude/skills/ketcher-_shared/graph-intent-schema.md` for the resolved
 * value's documentation.
 */
export const CALIBRATION_INVERT = true;

/**
 * W2 — single global calibration constant for Haworth/Fischer projection
 * decoding (analogous to CALIBRATION_INVERT). The agent transcribes a single
 * pixel bit per stereocenter (`verticalSense: "up" | "down"`) — never the
 * chemistry. This constant defines which direction corresponds to "toward the
 * viewer" once projected onto the wedge-projection `facing` axis:
 *
 *   true  — `verticalSense: "up"`   maps to `facing: "toward"` (solid wedge)
 *   false — `verticalSense: "up"`   maps to `facing: "away"`   (hashed wedge)
 *
 * In both cases `"down"` maps to the opposite. After mapping, the entry is
 * routed through the standard `compileWedge` per-center parity, so a Ketcher
 * sub-ring that gets mirrored on global `layout` is auto-corrected.
 *
 * RESOLVED VALUE: `true`. The α-D-glucopyranose Haworth calibration
 * experiment under
 * `outputs/cat1-haworth-calibration/cat1-haworth-calibration.ts` runs the
 * Haworth pixel facts (verticalSense per ring center, drawnNeighborsCW =
 * the visual CW walk of the 3 real heavy neighbors) twice — once with this
 * constant `true`, once `false`. The `true` run reproduces the literature
 * α-D-glucopyranose canonical SMILES
 * `OC[C@H]1O[C@H](O)[C@H](O)[C@@H](O)[C@@H]1O` exactly (after Indigo
 * canonicalization); the `false` run produces the all-inverted enantiomer.
 * Discipline mirrors `CALIBRATION_INVERT`: one constant, global, decided
 * once by experiment.
 *
 * Discipline note: do NOT calibrate per-center or per-substrate. If a single
 * Haworth substrate ever appears to require the opposite mapping while
 * α-D-glucopyranose still produces the literature value, that is a real bug
 * — not a calibration issue — and must be investigated (transcription error,
 * Ketcher layout pathology) rather than papered over by flipping this
 * constant.
 */
export const HAWORTH_VERTICAL_TOWARD = true;

/** Fail-closed error carrying the v3 doc §9.5 diagnostic. */
export class StereoTransferError extends Error {
  readonly diagnostic: string;
  constructor(diagnostic: string) {
    super('StereoTransferCompiler failure');
    this.name = 'StereoTransferError';
    this.diagnostic = diagnostic;
  }
}

/** toward <-> away. */
export function invertFacing(facing: Facing): Facing {
  return facing === 'toward' ? 'away' : 'toward';
}

/**
 * Structural checks shared by validateStereoTransferEntry (translator step 1)
 * and compileWedge. Checks 1-4 of v3 doc §9.1 are pure (entry only); check 5
 * (coords present) runs only when frozenCoords is supplied.
 *
 * W1: when `wedgeToImplicitH` is set, `outOfPlaneNeighbor` is the implicit-H
 *     id and is NOT expected in `drawnNeighborsCW` (which carries the 3 real
 *     drawn neighbors). The membership check is skipped in that case;
 *     `drawnNeighborsCW` must be length 3 (an implicit-H center has exactly
 *     three real heavy/drawn neighbors).
 * W2: `projection: "haworth" | "fischer"` is accepted here and routed by the
 *     projection adapter in `compileWedge`. The adapter requires `verticalSense`.
 */
function structuralIssues(
  entry: StereoTransferEntry,
  frozenCoords?: FrozenCoords,
): string[] {
  const issues: string[] = [];
  const dn = entry.drawnNeighborsCW;
  if (dn.length !== 3 && dn.length !== 4) {
    issues.push(`drawnNeighborsCW length is ${dn.length} (must be 3 or 4)`);
  }
  if (new Set(dn).size !== dn.length) {
    issues.push('drawnNeighborsCW contains a duplicate id');
  }
  if (entry.wedgeToImplicitH) {
    if (dn.length !== 3) {
      issues.push(
        `wedgeToImplicitH requires drawnNeighborsCW of length 3 (got ${dn.length})`,
      );
    }
    if (dn.includes(entry.outOfPlaneNeighbor)) {
      issues.push(
        `wedgeToImplicitH outOfPlaneNeighbor ${entry.outOfPlaneNeighbor} must NOT be a member of drawnNeighborsCW (it is the implicit H)`,
      );
    }
  } else if (!dn.includes(entry.outOfPlaneNeighbor)) {
    issues.push(
      `outOfPlaneNeighbor ${entry.outOfPlaneNeighbor} is not in drawnNeighborsCW`,
    );
  }
  if (
    entry.projection !== 'wedge' &&
    entry.projection !== 'haworth' &&
    entry.projection !== 'fischer'
  ) {
    issues.push(
      `projection "${entry.projection}" is unsupported (supported: "wedge", "haworth", "fischer")`,
    );
  }
  if (
    (entry.projection === 'haworth' || entry.projection === 'fischer') &&
    entry.verticalSense === undefined
  ) {
    issues.push(
      `projection "${entry.projection}" requires verticalSense ("up" | "down")`,
    );
  }
  if (frozenCoords) {
    // For wedgeToImplicitH, the implicit-H id has no coord yet — only
    // `center` + the three drawn neighbors are checked.
    const coordIds = entry.wedgeToImplicitH
      ? [entry.center, ...dn]
      : [entry.center, ...dn];
    for (const id of coordIds) {
      if (!frozenCoords[id]) {
        issues.push(`atom ${id} missing from the frozen coordinate set`);
      }
    }
  }
  return issues;
}

/**
 * Full v3 doc §9.1 structural validation, used by the translator at pipeline
 * step 1. Checks 1-4 always; check 5 (coords) when ctx.frozenCoords is given;
 * check 6 (drawnNeighborsCW is exactly the center's graph neighbors) when
 * ctx.graphNeighbors is given. The implicit H is never a graph node, so the
 * center's graph neighbors ARE exactly its explicit drawn neighbors.
 * Returns the list of human-readable issues; empty means valid.
 */
export function validateStereoTransferEntry(
  entry: StereoTransferEntry,
  ctx?: { frozenCoords?: FrozenCoords; graphNeighbors?: ReadonlySet<number> },
): string[] {
  const issues = structuralIssues(entry, ctx?.frozenCoords);
  if (ctx?.graphNeighbors) {
    const want = ctx.graphNeighbors;
    const got = new Set(entry.drawnNeighborsCW);
    const extra = [...got].filter((id) => !want.has(id));
    const missing = [...want].filter((id) => !got.has(id));
    if (extra.length > 0 || missing.length > 0) {
      issues.push(
        `drawnNeighborsCW is not exactly the graph neighbors of center ${entry.center} ` +
          `(extra=[${extra.join(',')}] missing=[${missing.join(',')}])`,
      );
    }
  }
  return issues;
}

/**
 * Clockwise visual order of `neighbors` around `center`, computed from frozen
 * coordinates (v3 doc §9.2). Ketcher / molfile coordinates are Cartesian y-up,
 * so visual clockwise is DECREASING atan2 angle.
 *
 * `calibrationInvert` defaults to the module-global CALIBRATION_INVERT; the
 * explicit parameter exists only so unit tests can exercise both branches.
 */
export function clockwiseNeighborOrderFromCoords(
  center: number,
  neighbors: number[],
  coords: FrozenCoords,
  calibrationInvert: boolean = CALIBRATION_INVERT,
): number[] {
  const pc = coords[center];
  if (!pc) {
    throw new StereoTransferError(
      `clockwiseNeighborOrderFromCoords: center ${center} missing from coords`,
    );
  }
  const withTheta = neighbors.map((n) => {
    const c = coords[n];
    if (!c) {
      throw new StereoTransferError(
        `clockwiseNeighborOrderFromCoords: neighbor ${n} missing from coords`,
      );
    }
    return { n, theta: Math.atan2(c.y - pc.y, c.x - pc.x) };
  });
  withTheta.sort((a, b) => b.theta - a.theta);
  const order = withTheta.map((t) => t.n);
  return calibrationInvert ? order.reverse() : order;
}

/**
 * The 3-neighbour comparison set (v3 doc §9.3). An implicit-H center's
 * drawnNeighborsCW is already 3 elements — returned unchanged. A quaternary
 * center's is 4 elements — the out-of-plane neighbor is dropped because its 2D
 * angle does not affect the chirality sign (it supplies displacement, not
 * planar order). Restricting to three neighbors also removes the "third
 * necklace" 4-cycle case that has no single-flip compensation.
 *
 * W1: a `wedgeToImplicitH` entry always has drawnNeighborsCW length 3 (the
 * three real heavy neighbors); `outOfPlaneNeighbor` is the implicit H and is
 * not a member of the list, so the filter is a no-op and the triple is the
 * three drawn neighbors unchanged — same as a regular implicit-H center
 * (v3 §3.3 proof: the implicit H cancels from the parity comparison).
 */
export function comparisonTriple(entry: StereoTransferEntry): number[] {
  if (entry.drawnNeighborsCW.length === 3) {
    return [...entry.drawnNeighborsCW];
  }
  return entry.drawnNeighborsCW.filter((n) => n !== entry.outOfPlaneNeighbor);
}

function rotations(list: number[]): number[][] {
  return list.map((_, i) => [...list.slice(i), ...list.slice(0, i)]);
}

function sameSequence(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Cyclic-order parity of two 3-element triples over the same id set
 * (v3 doc §9.3). With three distinct labels every permutation is either a
 * rotation of `a` ("same") or a rotation of reverse(`a`) ("opposite"). Anything
 * else — wrong length, mismatched id set — is "error" and a genuine bug that
 * must fail closed.
 */
export function cyclicParity(a: number[], b: number[]): Parity {
  if (a.length !== 3 || b.length !== 3) return 'error';
  if (new Set(a).size !== 3 || new Set(b).size !== 3) return 'error';
  if (!a.every((v) => b.includes(v))) return 'error';
  if (rotations(a).some((r) => sameSequence(r, b))) return 'same';
  if (rotations([...a].reverse()).some((r) => sameSequence(r, b))) return 'opposite';
  return 'error';
}

/** v3 doc §9.5 fail-closed diagnostic block. */
function formatDiagnostic(
  entry: StereoTransferEntry,
  ketcherCW: number[] | null,
  parity: Parity,
  reason: string,
): string {
  return [
    'StereoTransferCompiler failure',
    `- center: ${entry.center}`,
    `- projection: ${entry.projection}`,
    `- drawnNeighborsCW (source):  [${entry.drawnNeighborsCW.join(', ')}]`,
    `- ketcher CW order:           ${ketcherCW ? `[${ketcherCW.join(', ')}]` : 'n/a'}`,
    `- parity: ${parity}            (expected "same" or "opposite")`,
    `- reason: ${reason}`,
  ].join('\n');
}

/**
 * W2 projection adapter — Haworth/Fischer → wedge-projection facts.
 *
 * The agent transcribes a single pixel bit per non-wedge stereocenter
 * (`verticalSense: "up" | "down"`), never the chemistry. This adapter maps
 * that bit through the global calibration constant `HAWORTH_VERTICAL_TOWARD`
 * to a wedge-projection `facing`. The resulting entry is then handed to the
 * standard parity-transfer pipeline — same per-center parity comparison,
 * same global `CALIBRATION_INVERT` for the Ketcher coord convention. A
 * Haworth ring whose layout Ketcher mirrors is therefore auto-corrected by
 * the same mechanism that auto-corrects mirrored wedge sub-rings.
 *
 * Fischer / Haworth share the adapter intentionally: by convention a Fischer
 * horizontal-bond points "toward" and a vertical-bond points "away", and the
 * agent's `verticalSense` is the bit (vertical-up vs vertical-down) on the
 * vertical bond carrying `outOfPlaneNeighbor`. The geometric mapping reduces
 * to the same one-bit-to-facing function as Haworth, calibrated by
 * `HAWORTH_VERTICAL_TOWARD`.
 */
function adaptProjectionEntry(
  entry: StereoTransferEntry,
  haworthVerticalToward: boolean,
): StereoTransferEntry {
  if (entry.projection === 'wedge') return entry;
  if (entry.verticalSense === undefined) {
    // structuralIssues already flags this, but keep a tight invariant here.
    return entry;
  }
  const verticalIsToward = haworthVerticalToward
    ? entry.verticalSense === 'up'
    : entry.verticalSense === 'down';
  const adapted: StereoTransferEntry = {
    ...entry,
    facing: verticalIsToward ? 'toward' : 'away',
  };
  return adapted;
}

/**
 * Compile one stereocenter's drawing-native facts into a Ketcher wedge against
 * the frozen post-clean() layout (v3 doc §9.4). Fails closed (throws
 * StereoTransferError with the §9.5 diagnostic) on any structural defect or
 * "error" parity — trial-and-flip is never used to recover.
 *
 * There is no implicit hydrogen anywhere in this algorithm's parity comparison.
 * That is correct and intentional (§3.3 proof). For a W1 `wedgeToImplicitH`
 * entry the H is the dependent fourth slot exactly like a regular implicit-H
 * center — it cancels from the parity comparison; only its `wedge` polarity
 * is computed here, and the translator owns materializing the H atom.
 *
 * W2: Haworth/Fischer entries go through `adaptProjectionEntry` first to
 * translate `verticalSense` into wedge-projection `facing`, then take the
 * standard parity-transfer path. The compiled `outOfPlaneNeighbor` is the
 * adapted entry's value (the vertical-bond neighbor for Haworth/Fischer).
 */
export function compileWedge(
  entry: StereoTransferEntry,
  frozenCoords: FrozenCoords,
  calibrationInvert: boolean = CALIBRATION_INVERT,
  haworthVerticalToward: boolean = HAWORTH_VERTICAL_TOWARD,
): CompiledWedge {
  const structural = structuralIssues(entry, frozenCoords);
  if (structural.length > 0) {
    throw new StereoTransferError(
      formatDiagnostic(entry, null, 'error', structural.join('; ')),
    );
  }
  // Fail closed on an unreadable-wedge facing. The translator maps
  // wavy/unknown to stereo_unknown and never reaches here for them (LOCK 22);
  // this guard guarantees compileWedge can never silently coerce wavy/unknown
  // into a solid/hashed wedge if a future caller skips that normalization.
  if (entry.facing === 'wavy' || entry.facing === 'unknown') {
    throw new StereoTransferError(
      formatDiagnostic(
        entry,
        null,
        'error',
        `facing '${entry.facing}' is an unreadable-wedge declaration — it must be ` +
          'normalized to stereo_unknown (no wedge applied), not compiled',
      ),
    );
  }
  const adapted = adaptProjectionEntry(entry, haworthVerticalToward);

  // Full drawn-neighbour clockwise orders, source (image) and Ketcher (layout).
  const ketcherFull = clockwiseNeighborOrderFromCoords(
    adapted.center,
    adapted.drawnNeighborsCW,
    frozenCoords,
    calibrationInvert,
  );

  // Reduce both to the 3-neighbour comparison triple. For a quaternary center
  // this drops outOfPlaneNeighbor from each; for an implicit-H center the
  // triple is the full 3-element list unchanged. For a W1 wedgeToImplicitH
  // entry the filter is a no-op (outOfPlaneNeighbor is not a member).
  const source = comparisonTriple(adapted);
  const sourceIds = new Set(source);
  const ketcher = ketcherFull.filter((id) => sourceIds.has(id));

  const parity = cyclicParity(source, ketcher);
  if (parity === 'error') {
    throw new StereoTransferError(
      formatDiagnostic(
        adapted,
        ketcher,
        parity,
        'cyclic parity is neither "same" nor "opposite" — transcription mistake, ' +
          'duplicated id, or a degenerate Ketcher layout',
      ),
    );
  }

  const ketcherFacing = parity === 'same' ? adapted.facing : invertFacing(adapted.facing);
  const wedge = ketcherFacing === 'toward' ? 'solid' : 'hashed';

  return {
    center: adapted.center,
    outOfPlaneNeighbor: adapted.outOfPlaneNeighbor,
    wedge,
  };
}

/**
 * Compile every stereocenter's wedge against one frozen coordinate set.
 * Throws StereoTransferError on the first entry that fails closed.
 */
export function compileAllWedges(
  entries: StereoTransferEntry[],
  frozenCoords: FrozenCoords,
  calibrationInvert: boolean = CALIBRATION_INVERT,
  haworthVerticalToward: boolean = HAWORTH_VERTICAL_TOWARD,
): CompiledWedge[] {
  return entries.map((entry) =>
    compileWedge(entry, frozenCoords, calibrationInvert, haworthVerticalToward),
  );
}
