/**
 * Per-center R/S target solver (handoff-rs-direct §B). For each stereocenter
 * with a target `stereo_label` of 'R' or 'S', greedily picks the wedge
 * configuration that produces the target CIP via Indigo. Operates on a
 * V2000 molfile directly — adjacent-chiral conflicts that defeat
 * `setWedgeBond` are bypassed because the file is read in one pass.
 *
 * Algorithm (mirrors gate3e-direct-molfile.py):
 *
 *   1. Strip all wedges from the baseline molfile.
 *   2. Sort centers by constrainedness (fewer non-target heavy neighbors
 *      first) so already-determined centers don't lock the solver out of
 *      configurations the harder centers need.
 *   3. For each center, iterate (heavy_neighbor, wedge_kind) until one
 *      produces the target CIP. Commit the working state; move on.
 *   4. On failure for any single center, throw an `unreachable` error
 *      naming the center and target. The translator surfaces this as
 *      `BuildFromGraphError('stereo_cip_unreachable')`.
 *
 * Centers with `stereo_label: 'unknown'` are skipped (no wedge applied).
 */

import {
  heavyNeighbors,
  parseV2000,
  setV2000ChiralFlag,
  setWedge,
  writeV2000,
} from './molfile-stereo';
import { indigoComputeCIPLabels } from './indigo-stereo';

export type StereoLabelTarget = {
  center: number;           // canvas (0-based) atom id — same id space as graph intent
  target: 'R' | 'S' | 'unknown';
};

export type SolverPick = {
  center: number;          // canvas atom id (0-based)
  neighbor: number;        // canvas atom id (0-based)
  kind: 'solid' | 'hashed';
};

export type SolverResult = {
  finalMolfile: string;
  picks: SolverPick[];
};

export class StereoCIPUnreachableError extends Error {
  readonly center: number;
  readonly target: 'R' | 'S';
  constructor(center: number, target: 'R' | 'S') {
    super(`stereo_cip_unreachable: center=${center}, target=${target}`);
    this.name = 'StereoCIPUnreachableError';
    this.center = center;
    this.target = target;
  }
}

/**
 * Resolve targets against the baseline molfile. `atomIdMap` maps canvas
 * (0-based) ids → V2000 molfile (1-based) ids. For the standard translator
 * path the map is identity-plus-one (state.atoms[i].id === i), but the
 * solver should not assume that — callers compute the map explicitly.
 */
export async function solveStereoLabels(
  baselineMolfile: string,
  targets: StereoLabelTarget[],
  canvasIdToMolfile1Based: Map<number, number>,
): Promise<SolverResult> {
  // Baseline parse — wedges from wedge-primitive entries (if any) are PRESERVED.
  // The solver only mutates bonds incident to a target center, leaving the
  // rest of the canvas untouched. Pure R/S-direct intents arrive with no
  // wedges; mixed intents arrive with wedge-primitive wedges already applied.
  const baseline = parseV2000(baselineMolfile);

  // Sort: most-constrained (fewest non-target heavy nbrs) centers first so
  // their (limited) wedge options are picked while the working state is
  // clean, then less-constrained centers fit around them. Mirrors the
  // gate3e-direct sort.
  const actionable = targets.filter(
    (t) => t.target !== 'unknown',
  ) as Array<{ center: number; target: 'R' | 'S' }>;
  const targetCenterSet = new Set(actionable.map((t) => t.center));
  const constrainedness = (center: number): number => {
    const c1 = canvasIdToMolfile1Based.get(center);
    if (c1 === undefined) return Number.POSITIVE_INFINITY;
    const nbrs1 = heavyNeighbors(baseline, c1);
    // count non-target heavy neighbors (target centers are themselves chiral,
    // so leave them for later)
    return nbrs1.filter((n1) => {
      const canvasId = molfile1BasedToCanvasId(n1, canvasIdToMolfile1Based);
      return canvasId !== null && !targetCenterSet.has(canvasId);
    }).length;
  };
  actionable.sort((a, b) => constrainedness(a.center) - constrainedness(b.center));

  let working = baseline;
  const picks: SolverPick[] = [];

  for (const { center, target } of actionable) {
    const c1 = canvasIdToMolfile1Based.get(center);
    if (c1 === undefined) {
      throw new StereoCIPUnreachableError(center, target);
    }
    const nbrs1 = heavyNeighbors(working, c1);
    // sort: non-target neighbors first (their wedges have stable meaning,
    // chiral-to-chiral wedges are noisier)
    nbrs1.sort((a, b) => {
      const aCanvas = molfile1BasedToCanvasId(a, canvasIdToMolfile1Based);
      const bCanvas = molfile1BasedToCanvasId(b, canvasIdToMolfile1Based);
      const aChiral = aCanvas !== null && targetCenterSet.has(aCanvas) ? 1 : 0;
      const bChiral = bCanvas !== null && targetCenterSet.has(bCanvas) ? 1 : 0;
      return aChiral - bChiral;
    });

    let found: SolverPick | null = null;
    const savedSnapshot = writeV2000(working);
    for (const nbr1 of nbrs1) {
      for (const kind of ['solid', 'hashed'] as const) {
        // rebuild working from snapshot so prior candidate doesn't leak
        const candidate = parseV2000(savedSnapshot);
        setWedge(candidate, c1, nbr1, kind);
        const candidateMb = writeV2000(candidate);
        const cipMap = await indigoComputeCIPLabels(candidateMb);
        if (cipMap.get(c1) === target) {
          const nbrCanvas = molfile1BasedToCanvasId(nbr1, canvasIdToMolfile1Based);
          if (nbrCanvas === null) continue;
          found = { center, neighbor: nbrCanvas, kind };
          working = candidate;
          break;
        }
      }
      if (found) break;
    }
    if (!found) {
      throw new StereoCIPUnreachableError(center, target);
    }
    picks.push(found);
  }

  if (picks.length > 0) {
    setV2000ChiralFlag(working, true);
  }

  return { finalMolfile: writeV2000(working), picks };
}

function molfile1BasedToCanvasId(
  molfile1Based: number,
  canvasIdToMolfile1Based: Map<number, number>,
): number | null {
  for (const [canvasId, m1] of canvasIdToMolfile1Based) {
    if (m1 === molfile1Based) return canvasId;
  }
  return null;
}
