/**
 * Dense-draft signal (dense-vision targeted-readback plan §4.1).
 *
 *   isDenseDraft := fusedRingPairs(rings) >= 2  AND  atoms.length >= 18
 *   fusedRingPairs := count of unordered ring pairs sharing >= 2 declared
 *                     atom ids (i.e. a shared edge ⇒ fused, not spiro/disjoint).
 *
 * Pure + deterministic, computed from the declared GraphIntent topology only
 * (no coords, no pixels, no chemistry). Gates the dense zoom-verify SKILL
 * instruction and the crop-after-validate relaxation. A no-op on simple inputs
 * — this is the "fast on easy" guarantee.
 *
 * Frozen on measured evidence: fires on every dense-vision failure (A004 fp3/
 * h62, A009 fp7/h60, A011 fp3/h34, A009H_marked fp8/h62, A011H fp3/h35) and is
 * OFF on the easy floor (I001/I015 fp0/h6). The `heavy >= 18` clause exempts
 * tiny clear fused cages (adamantane h10) so they keep the fast path; no
 * observed failure is below h34, so the floor is safe.
 */

const DENSE_HEAVY_FLOOR = 18;

/**
 * Number of unordered ring pairs that share >= 2 declared atom ids. A shared
 * edge (>=2 atoms) means the rings are fused; spiro (1 shared atom) and
 * disjoint (0) rings do not count.
 */
export function fusedRingPairs(rings: ReadonlyArray<{ atoms: number[] }>): number {
  let pairs = 0;
  for (let i = 0; i < rings.length; i++) {
    const a = new Set(rings[i].atoms);
    for (let j = i + 1; j < rings.length; j++) {
      let shared = 0;
      for (const id of rings[j].atoms) {
        if (a.has(id)) {
          shared++;
          if (shared >= 2) break;
        }
      }
      if (shared >= 2) pairs++;
    }
  }
  return pairs;
}

/**
 * A draft is "dense" when it is a fused polycyclic core (>= 3 mutually fused
 * rings ⇒ fusedRingPairs >= 2) AND large enough to warrant the extra
 * zoom-verify pass (heavy atom count >= DENSE_HEAVY_FLOOR).
 */
export function isDenseDraft(graph: {
  atoms: ReadonlyArray<unknown>;
  rings: ReadonlyArray<{ atoms: number[] }>;
}): boolean {
  return (
    graph.atoms.length >= DENSE_HEAVY_FLOOR && fusedRingPairs(graph.rings) >= 2
  );
}

/** Declaration-INDEPENDENT dense prior: a draft is a dense CANDIDATE on size
 * alone (heavy-atom floor), regardless of whether the agent has yet declared
 * the ring fusion. Used for the ENABLING dense surfaces (crop-unlock, M0
 * example advisory) so a malformed/under-declared draft cannot evade the help
 * (fixes GAP-A). isDenseDraft (fusedRingPairs) stays for the relayout, where
 * skipping is fail-safe. Fail-open: only ever ADDS help, never withholds. */
export function isDenseCandidate(graph: { atoms: ReadonlyArray<unknown> }): boolean {
  return graph.atoms.length >= DENSE_HEAVY_FLOOR;
}

/**
 * Does this graph declare any tetrahedral wedge stereo (the `bond.wedge` or
 * `atom.wedge_to_implicit_h` carriers)? Paired with `isDenseDraft` to gate the
 * dense relayout (translator step 13): a dense fused core that declares wedge
 * stereo has the backend re-idealize the coordinate frame via clean() AFTER the
 * wedge flag is assigned, healing by-eye coord-CW errors (the idx60 class).
 * E/Z-only graphs do NOT qualify — bond.geom is label-authoritative and
 * frame-independent, so they gain nothing from a relayout.
 */
export function hasWedgeStereo(graph: {
  atoms: ReadonlyArray<{ wedge_to_implicit_h?: unknown }>;
  bonds: ReadonlyArray<{ wedge?: unknown }>;
}): boolean {
  return (
    graph.bonds.some((b) => b.wedge != null) ||
    graph.atoms.some((a) => a.wedge_to_implicit_h != null)
  );
}
