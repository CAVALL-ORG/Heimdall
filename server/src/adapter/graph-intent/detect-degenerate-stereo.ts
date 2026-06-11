/**
 * Lever A (detect-only) — degenerate stereocenter geometry advisory.
 * Plan: stereocenter coordinate-fidelity.
 *
 * A dense wedge stereocenter whose two IN-PLANE neighbors (the drawn neighbors
 * other than the wedge target) are drawn near-collinear (~180° apart) has an
 * ill-conditioned 2D frame: Indigo's CIP perceiver decodes the wrong R/S from
 * that geometry even when the wedge stroke is read correctly (A009 atom 19 =
 * 177.5°). This pure detector flags those centers so the agent can re-read the
 * in-plane bond DIRECTIONS from a crop. It is ADVISORY — it never mutates the
 * canvas or the exported SMILES.
 *
 * Honest limit (proven in the plan): it CANNOT catch A011 atom 17 (23.2° off
 * collinear, first-shell carbon tie). No backend-only lever catches that; only
 * an agent-supplied source-faithful angle does. The detector is deliberately
 * narrow (true collinearity, tight ε) so it never false-flags a legitimate
 * skewed-but-correct drawing — per `feedback_no_over_requirement`.
 *
 * Pure + deterministic (no coords mutated, no chemistry). Modeled on the pure
 * planner shape of `ez-coordinate-lock.ts` / `dense-signal.ts`.
 */

const DEFAULT_EPSILON_DEG = 8;

export interface DegenerateStereoFinding {
  center: number; // stereocenter atom id (intent space)
  pair: [number, number]; // the near-collinear in-plane neighbor pair
  pairAngleDeg: number; // angle between the two in-plane neighbor bonds, [0,180]
  minSeparationToStraight: number; // |180 − pairAngleDeg| for the most-collinear pair
  collinear: boolean; // true ⇒ within ε of collinear ⇒ advise a re-read
}

export function detectDegenerateStereoGeometry(
  centers: ReadonlyArray<number>,
  inPlaneNeighborsOf: (center: number) => ReadonlyArray<number>,
  coordOf: (id: number) => { x: number; y: number } | undefined,
  epsilonDeg: number = DEFAULT_EPSILON_DEG,
): DegenerateStereoFinding[] {
  const findings: DegenerateStereoFinding[] = [];
  for (const center of centers) {
    const cpos = coordOf(center);
    if (!cpos) continue;

    // Direction (atan2) of each in-plane neighbor bond that has a known coord.
    const dirs: Array<{ id: number; ang: number }> = [];
    for (const n of inPlaneNeighborsOf(center)) {
      const p = coordOf(n);
      if (!p) continue;
      const dx = p.x - cpos.x;
      const dy = p.y - cpos.y;
      if (dx === 0 && dy === 0) continue;
      dirs.push({ id: n, ang: Math.atan2(dy, dx) });
    }
    if (dirs.length < 2) continue;

    // The pair whose separation is closest to 180° (most collinear).
    let best: { pair: [number, number]; pairAngle: number; sep: number } | null = null;
    for (let i = 0; i < dirs.length; i++) {
      for (let j = i + 1; j < dirs.length; j++) {
        let d = (Math.abs(dirs[i].ang - dirs[j].ang) * 180) / Math.PI;
        if (d > 180) d = 360 - d; // fold into [0,180]
        const sep = Math.abs(180 - d);
        if (best === null || sep < best.sep) {
          best = { pair: [dirs[i].id, dirs[j].id], pairAngle: d, sep };
        }
      }
    }
    if (!best) continue;

    if (best.sep < epsilonDeg) {
      findings.push({
        center,
        pair: best.pair,
        pairAngleDeg: best.pairAngle,
        minSeparationToStraight: best.sep,
        collinear: true,
      });
    }
  }
  return findings;
}
