/**
 * ring-coherence.ts — pure pre-build coherence checks for GraphIntent rings.
 *
 * Implements C1 (Euler scalar one-sided) and C3 (fusion continuity, >=2 threshold).
 * C2 already exists as V12 "ring-walk plausibility" in validator.ts:233-245; it verifies
 * every consecutive ring-atom pair (including wrap-around) is bonded — not reimplemented here.
 *
 * Returns [] when the ring declaration is coherent.
 * Never throws (malformed input treated as empty).
 * Pure: no Ketcher canvas, no Indigo, no chemistry.
 */

export type RingCoherenceFinding =
  | { kind: 'ring_underdeclared'; note: string }
  | { kind: 'ring_fusion_unrepresented'; note: string };

/**
 * Checks C1 and C3 ring-coherence invariants on a GraphIntent fragment.
 *
 * @param graph - Minimal GraphIntent slice: atoms (id only), bonds (a/b), rings (id/atoms)
 * @returns Array of findings. Empty when coherent.
 */
export function checkRingCoherence(graph: {
  atoms: ReadonlyArray<{ id: number }>;
  bonds: ReadonlyArray<{ a: number; b: number }>;
  rings: ReadonlyArray<{ id: string; atoms: number[] }>;
}): RingCoherenceFinding[] {
  const findings: RingCoherenceFinding[] = [];

  const atoms = graph.atoms ?? [];
  const bonds = graph.bonds ?? [];
  const rings = graph.rings ?? [];

  // ── C1: Euler scalar (one-sided under-declaration check) ──────────────────
  //
  // bondCyclomatic = E - V + components.
  // Flag ONLY when rings.length < bondCyclomatic.
  // The other direction (rings.length > bondCyclomatic) is the legitimate
  // bridged-cage case (e.g. cubane: 6 declared faces vs Euler 5) — stay silent.

  const V = atoms.length;
  const E = bonds.length;

  // Own tiny BFS/DFS component count over GraphIntent {a,b} bonds.
  // Cannot import graph.ts's componentCount: that function expects Ketcher
  // internal structs (bond.begin/.end), not GraphIntent {a, b} format.
  const components = countComponents(atoms, bonds);

  const bondCyclomatic = E - V + components;
  const declaredRings = rings.length;

  if (declaredRings < bondCyclomatic) {
    findings.push({
      kind: 'ring_underdeclared',
      note: `bonds form ${bondCyclomatic} independent cycle(s) but only ${declaredRings} ring(s) were declared — re-read the fused core (you likely split a fused system into disjoint ring blocks)`,
    });
  }

  // ── C3: fusion continuity (>=2 inter-ring bonds threshold) ────────────────
  //
  // For each unordered ring pair (i, j):
  //   shared = |atoms_i ∩ atoms_j|
  //   interRingBonds = bonds with one endpoint exclusively in set_i and the
  //                    other exclusively in set_j
  //
  // Flag when shared < 2 AND interRingBonds >= 2.
  //
  // WHY >=2 and NOT >=1:
  //   A single inter-ring bond is a legitimate biaryl / linker / pendant-ring
  //   (biphenyl, phenyl-cyclohexane, etc.) — flagging it would FALSE-POSITIVE
  //   on correct graphs including A004pass.graph.json (rB~oxet, shared0/inter1),
  //   coord-cw-A004H.graph.json (ringB~oxet), and any plain biphenyl.
  //   The >=2 threshold is FP=0 on all committed fixtures and biphenyl/spiro/
  //   ortho-fused while still firing on the under-declared fusion pattern
  //   (two atoms share <2 declared atoms but 2 bonds cross between them).

  // Build atom sets for each ring
  const ringSets: Array<{ id: string; set: Set<number> }> = rings.map((r) => ({
    id: r.id,
    set: new Set(r.atoms),
  }));

  // Pre-cache bond pair list
  const bondPairs: Array<[number, number]> = bonds.map((b) => [b.a, b.b]);

  for (let i = 0; i < ringSets.length; i++) {
    for (let j = i + 1; j < ringSets.length; j++) {
      const { id: id_i, set: set_i } = ringSets[i];
      const { id: id_j, set: set_j } = ringSets[j];

      // Count shared atoms
      let shared = 0;
      for (const atom of set_i) {
        if (set_j.has(atom)) shared++;
      }

      // Skip if already properly declared as fused (>=2 shared atoms)
      if (shared >= 2) continue;

      // Count inter-ring bonds: one endpoint exclusively in set_i, other exclusively in set_j
      let interRingBonds = 0;
      for (const [a, b] of bondPairs) {
        const aInI = set_i.has(a);
        const aInJ = set_j.has(a);
        const bInI = set_i.has(b);
        const bInJ = set_j.has(b);

        // Endpoint a exclusively in i and endpoint b exclusively in j, or vice versa
        if ((aInI && !aInJ && bInJ && !bInI) || (bInI && !bInJ && aInJ && !aInI)) {
          interRingBonds++;
        }
      }

      if (interRingBonds >= 2) {
        findings.push({
          kind: 'ring_fusion_unrepresented',
          note: `rings ${id_i} and ${id_j} share ${shared} atom(s) but ${interRingBonds} bond(s) cross between them — they are likely one fused system you split apart; re-read that junction region`,
        });
      }
    }
  }

  return findings;
}

// ── Internal: tiny BFS component counter for GraphIntent {a,b} bonds ────────
//
// Does NOT import from graph.ts — that module expects Ketcher internal structs
// with bond.begin/.end, not the GraphIntent {a, b} format.

function countComponents(
  atoms: ReadonlyArray<{ id: number }>,
  bonds: ReadonlyArray<{ a: number; b: number }>,
): number {
  if (atoms.length === 0) return 0;

  // Build adjacency map from atom id
  const adj = new Map<number, number[]>();
  for (const atom of atoms) {
    adj.set(atom.id, []);
  }
  for (const bond of bonds) {
    // Bonds may reference atom ids not in atoms[] if graph is malformed;
    // be defensive and skip unknown endpoints rather than throwing.
    if (adj.has(bond.a)) adj.get(bond.a)!.push(bond.b);
    if (adj.has(bond.b)) adj.get(bond.b)!.push(bond.a);
  }

  const visited = new Set<number>();
  let components = 0;

  for (const atom of atoms) {
    if (visited.has(atom.id)) continue;
    components++;
    // BFS
    const queue: number[] = [atom.id];
    let head = 0;
    while (head < queue.length) {
      const curr = queue[head++];
      if (visited.has(curr)) continue;
      visited.add(curr);
      for (const neighbor of adj.get(curr) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
  }

  return components;
}
