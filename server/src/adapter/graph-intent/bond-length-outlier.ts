/**
 * bond-length-outlier.ts — pure pre-build geometry advisory for GraphIntent bonds.
 *
 * Connectivity analog of ring-coherence's ring_incoherent, for the "merged-path"
 * mis-wire class: when an agent collapses a 3-vertex path into one bond (skipping
 * the junction atoms in between), that bond is drawn much LONGER than its
 * neighbors. Flag a bond whose drawn length (from the agent's seed coords) is a
 * large outlier vs the in-frame median → "did you skip atoms on this line?".
 *
 * Returns [] when no bond is an outlier OR there is insufficient coord data.
 * Never throws (malformed/missing coords treated as absent — that bond is skipped).
 * Pure: no Ketcher canvas, no Indigo, no chemistry.
 *
 * ADVISORY only — the validate.ts wiring pushes these findings as WARNINGs that
 * never flip `ok`. A production false-positive is a harmless spurious hint.
 */

export type BondLengthFinding = { kind: 'bond_length_outlier'; note: string };

// Minimum coord-bearing bonds before the median is trusted. Below this the
// median is unstable on a tiny sample (a 2-bond graph with one long bond would
// false-fire), so we stay silent.
const MIN_BONDS_FOR_MEDIAN = 4;

// Outlier threshold: len > 2.5 × median(in-frame bond lengths).
// FP=0 sweep over the 4 committed correct fixtures: the worst correct
// max-ratio is 2.08× (coord-cw-A004H), so 2.5× clears every correct fixture
// with margin. A merged 3-vertex path lands at ~2× per skipped vertex (≈3× for
// one skip), so 2.5× fires on the mis-wire while staying silent on correct work.
const OUTLIER_RATIO = 2.5;

/**
 * Checks for bond-length outliers on a GraphIntent fragment.
 *
 * @param graph - Minimal GraphIntent slice: atoms (id + optional x/y), bonds (a/b)
 * @returns Array of findings, ordered by bond index. Empty when clean or
 *          coord data is insufficient (< MIN_BONDS_FOR_MEDIAN coord-bearing bonds).
 */
export function checkBondLengthOutliers(graph: {
  atoms: ReadonlyArray<{ id: number; x?: number; y?: number }>;
  bonds: ReadonlyArray<{ a: number; b: number }>;
}): BondLengthFinding[] {
  const atoms = graph.atoms ?? [];
  const bonds = graph.bonds ?? [];

  // id → {x, y}, only for atoms that carry BOTH numeric coords.
  const coord = new Map<number, { x: number; y: number }>();
  for (const a of atoms) {
    if (typeof a.x === 'number' && typeof a.y === 'number') {
      coord.set(a.id, { x: a.x, y: a.y });
    }
  }

  // Measure each bond's length ONLY when BOTH endpoints have coords.
  // One-sided / coordless bonds are not measured and not flagged.
  const measured: Array<{ index: number; a: number; b: number; len: number }> = [];
  bonds.forEach((bond, index) => {
    const pa = coord.get(bond.a);
    const pb = coord.get(bond.b);
    if (!pa || !pb) return;
    const len = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    measured.push({ index, a: bond.a, b: bond.b, len });
  });

  // Median is unstable on a tiny sample — stay silent below the floor.
  if (measured.length < MIN_BONDS_FOR_MEDIAN) return [];

  const median = medianOf(measured.map((m) => m.len));
  // Degenerate (all-zero-length) frame: nothing to compare against.
  if (!(median > 0)) return [];

  const findings: BondLengthFinding[] = [];
  // measured is already in ascending bond-index order (forEach over bonds).
  for (const m of measured) {
    if (m.len > OUTLIER_RATIO * median) {
      findings.push({
        kind: 'bond_length_outlier',
        note:
          `bond (${m.a},${m.b}) is ${Math.round(m.len)}px vs median ${Math.round(median)}px ` +
          `(${(m.len / median).toFixed(1)}×) — did you skip atoms on this line? ` +
          `re-read that segment for a missed junction`,
      });
    }
  }

  return findings;
}

// ── Internal: median of a numeric list (does not mutate the caller's array) ──
function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
