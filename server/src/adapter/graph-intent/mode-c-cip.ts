/**
 * Mode C — derive "intended R/S" from a wedge-primitive entry's pixel facts.
 *
 * The agent transcribes per-chiral-center: `drawnNeighborsCW` (CW order of 4
 * substituents in the source image), `outOfPlaneNeighbor` (the wedge tip),
 * and `facing` ('toward' = solid wedge, neighbor projects toward viewer;
 * 'away' = hashed wedge, neighbor projects away). The 4 substituent atoms
 * carry pixel coordinates.
 *
 * This module computes the R/S label IMPLIED BY those pixel facts using a
 * first-shell-atomic-number CIP shortcut ("poor-man CIP"). On ties at the
 * first shell, refuses with `reason: 'tie'` — the full CIP digraph descent
 * is out of scope here; the caller falls back to Indigo's perception in
 * those cases.
 *
 * The translator compares this intended label against Indigo's perceived
 * label on the post-build canvas. On disagreement, re-applies via the V2000
 * solver path (applyStereoLabels) — which writes parity bits directly to
 * the molfile, layout-invariant.
 *
 * Why this matters: HISTORY row 11 — paclitaxel K=11 stereo oscillates
 * 3/11 → 6/11 across reruns because Ketcher's auto-layout produces
 * different 2D coordinates at saddle junctions, and Indigo's CIP perception
 * follows the canvas geometry. The agent's transcribed wedge intent is the
 * ground truth (pixel facts don't drift); writing parity bits into the
 * molfile locks the intent independent of subsequent layout shuffles.
 */

import type {
  GraphIntent,
  IntentAtom,
  WedgePrimitiveStereoEntry,
} from '../../types/graph-intent';

/**
 * First-shell CIP priority by atomic number. Covers every element on the
 * supported MCP surface. Extend as elements get added to the agent's
 * vocabulary. Unknown elements → caller returns 'incomplete'.
 */
const CIP_ATOMIC_NUMBER: Record<string, number> = {
  H: 1,
  B: 5,
  C: 6,
  N: 7,
  O: 8,
  F: 9,
  Na: 11,
  Mg: 12,
  Al: 13,
  Si: 14,
  P: 15,
  S: 16,
  Cl: 17,
  K: 19,
  Ca: 20,
  Fe: 26,
  Co: 27,
  Ni: 28,
  Cu: 29,
  Zn: 30,
  As: 33,
  Se: 34,
  Br: 35,
  Ag: 47,
  I: 53,
  Pt: 78,
  Au: 79,
  Hg: 80,
  Pb: 82,
};

export type IntendedCIPResult =
  | { label: 'R' | 'S' }
  | {
      label: null;
      reason:
        | 'tie'
        | 'incomplete'
        | 'no_coords'
        | 'unsupported_projection'
        | 'stereo_unknown'
        | 'degenerate_geometry';
    };

/**
 * Derive R/S from a wedge-primitive entry using the signed-volume
 * formulation:
 *
 *   sign(det([P1 - P4, P2 - P4, P3 - P4]))
 *
 * where P1..P4 are the 4 substituents in CIP-priority order (P1 highest).
 * In a right-handed coordinate frame (X right, Y up, Z out of page toward
 * viewer):
 *   det > 0 → S (P1→P2→P3 CCW when viewed with P4 at back)
 *   det < 0 → R (CW)
 *
 * Image coordinates have Y-down (LOCK 8). We flip Y → math-Y before the
 * determinant.
 *
 * Out-of-plane neighbor (the wedge tip) gets z = ±mean-bond-length:
 *   `facing: 'toward'` (solid wedge) → z = +len  (in front of plane)
 *   `facing: 'away'` (hashed wedge)  → z = -len  (behind plane)
 *
 * Refusals (label: null):
 *   stereo_unknown            — entry self-marked unknown
 *   unsupported_projection    — haworth / fischer / wedgeToImplicitH
 *                                (handled elsewhere)
 *   no_coords                 — any required atom missing coordinates
 *   incomplete                — unknown element, missing facing, etc.
 *   tie                       — first-shell CIP ambiguity (needs digraph
 *                                descent; out of scope here)
 *   degenerate_geometry       — signed volume ~0 (colinear neighbors)
 */
export function deriveIntendedCIPFromWedgePrimitive(
  entry: WedgePrimitiveStereoEntry,
  atomById: Map<number, IntentAtom>,
): IntendedCIPResult {
  if (entry.stereo_unknown) return { label: null, reason: 'stereo_unknown' };
  if (entry.facing === 'wavy' || entry.facing === 'unknown') {
    return { label: null, reason: 'incomplete' };
  }
  if (entry.projection !== 'wedge') {
    return { label: null, reason: 'unsupported_projection' };
  }
  if (entry.wedgeToImplicitH) {
    return { label: null, reason: 'unsupported_projection' };
  }
  if (entry.drawnNeighborsCW.length !== 4) {
    return { label: null, reason: 'incomplete' };
  }

  const center = atomById.get(entry.center);
  if (!center || center.x === undefined || center.y === undefined) {
    return { label: null, reason: 'no_coords' };
  }

  const facingIdx = entry.drawnNeighborsCW.indexOf(entry.outOfPlaneNeighbor);
  if (facingIdx < 0) return { label: null, reason: 'incomplete' };

  type N3 = { id: number; x: number; y: number; z: number; cipNum: number };
  const ns: N3[] = [];
  for (const id of entry.drawnNeighborsCW) {
    const a = atomById.get(id);
    if (!a || a.x === undefined || a.y === undefined) {
      return { label: null, reason: 'no_coords' };
    }
    const cipNum = CIP_ATOMIC_NUMBER[a.element];
    if (cipNum === undefined) return { label: null, reason: 'incomplete' };
    ns.push({ id, x: a.x - center.x, y: -(a.y - center.y), z: 0, cipNum });
  }

  // First-shell tie → can't decide without CIP digraph descent. Caller
  // falls back to Indigo's perception.
  const cipNums = ns.map((n) => n.cipNum);
  if (new Set(cipNums).size < cipNums.length) {
    return { label: null, reason: 'tie' };
  }

  const inPlaneLens = ns
    .filter((_, i) => i !== facingIdx)
    .map((n) => Math.hypot(n.x, n.y));
  const bondLen =
    inPlaneLens.reduce((s, x) => s + x, 0) / inPlaneLens.length;
  if (!isFinite(bondLen) || bondLen === 0) {
    return { label: null, reason: 'no_coords' };
  }

  ns[facingIdx].z = entry.facing === 'toward' ? +bondLen : -bondLen;

  const ranked = [...ns].sort((a, b) => b.cipNum - a.cipNum);
  const [P1, P2, P3, P4] = ranked;

  const dx1 = P1.x - P4.x;
  const dy1 = P1.y - P4.y;
  const dz1 = P1.z - P4.z;
  const dx2 = P2.x - P4.x;
  const dy2 = P2.y - P4.y;
  const dz2 = P2.z - P4.z;
  const dx3 = P3.x - P4.x;
  const dy3 = P3.y - P4.y;
  const dz3 = P3.z - P4.z;

  const det =
    dx1 * (dy2 * dz3 - dz2 * dy3) -
    dy1 * (dx2 * dz3 - dz2 * dx3) +
    dz1 * (dx2 * dy3 - dy2 * dx3);

  // Degenerate tolerance scaled by bond length so the test is unit-aware:
  // a 1% sliver of (bondLen)^3 is the cutoff.
  const epsilon = 1e-2 * Math.pow(bondLen, 3);
  if (Math.abs(det) < epsilon) {
    return { label: null, reason: 'degenerate_geometry' };
  }

  return { label: det > 0 ? 'S' : 'R' };
}

/**
 * Convenience entrypoint: derive intended R/S labels for every wedge-
 * primitive entry in the graph. Used by the translator's Mode C re-apply
 * pass.
 */
export function deriveIntendedCIPForGraph(
  graph: GraphIntent,
): Map<number, IntendedCIPResult> {
  const atomById = new Map(graph.atoms.map((a) => [a.id, a]));
  const out = new Map<number, IntendedCIPResult>();
  for (const entry of graph.stereoTransfer ?? []) {
    if (!('drawnNeighborsCW' in entry)) continue;
    out.set(
      entry.center,
      deriveIntendedCIPFromWedgePrimitive(entry, atomById),
    );
  }
  return out;
}
