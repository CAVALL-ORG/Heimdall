/**
 * Vision-check candidate fingerprint — pure function over the post-build
 * annotated canvas state.
 *
 * Architectural role (handoff-prevent-rubber-stamp Step A): every
 * VISION_CHECK sub-row gets a SYSTEM-COMPUTED candidate side. The agent no
 * longer authors candidate-side text from their pre-build mental model
 * (rubber-stamp failure mode). Instead the translator emits this structured
 * fingerprint after the build commits; the agent reads it back and uses it
 * verbatim as the `candidate=` value. The agent fills only `source=` from
 * an independent re-read of the source image. The grader independently
 * recomputes a parallel fingerprint from `final_smiles` via RDKit and
 * gates source-vs-grader-candidate.
 *
 * Field set covers the failure classes seen on A004-class polycyclic
 * natural products (paclitaxel, morphine, brevetoxin):
 *   - small-ring heteroatom-position misread
 *   - fused-ring junction misread
 *   - arene-substitution-pattern positional drift
 *   - wedge/charge/drawn-H scalar mismatches
 *
 * The function is pure: takes an AnnotatedState-shaped input + optional
 * canonical SMILES (for cis/trans count) + GraphIntent-drawn-H atom-id list.
 * Returns a structured object the grader can compare on field by field. No
 * Ketcher / RDKit / Indigo dependencies — fully unit-testable from
 * hand-constructed fixtures.
 */

export type FingerprintAtom = {
  id: number;
  label: string;
  charge: number;
};

export type FingerprintBond = {
  id: number;
  beginAtomId: number;
  endAtomId: number;
  order: number;
  stereo: number;
  aromatic: boolean;
  inRing: boolean;
};

export type FingerprintInput = {
  atoms: FingerprintAtom[];
  bonds: FingerprintBond[];
  /** Canvas atom ids whose drawn_H is non-null in the source GraphIntent. */
  drawnHAtomIds: number[];
  /** Canonical (or any) SMILES used only for cis/trans bond counting. */
  canonicalSmiles?: string | null;
};

export type RingDescriptor = {
  id: string;
  size: number;
  aromatic: boolean;
};

export type RingConnectivityEntry = {
  ring_a: string;
  ring_b: string;
  kind: 'fused' | 'bridged' | 'spiro';
};

export type WedgeEntry = {
  a: number;
  b: number;
  kind: 'solid' | 'hashed';
};

export type ChargeEntry = {
  id: number;
  charge: number;
};

export type AreneSubstitutionEntry = {
  ring: string;
  positions: number[];
};

export type RingHeteroatomEntry = {
  ring: string;
  entries: Array<{ element: string; position: number }>;
};

export type RingAtomWalkEntry = {
  ring: string;
  /** Atom-by-atom walk in canonical cyclic order (lowest-id first). */
  atoms: Array<{ id: number; element: string; position: number }>;
};

export type VisionCheckCandidate = {
  heavy: number;
  rings: RingDescriptor[];
  ring_connectivity: RingConnectivityEntry[];
  drawn_H_atoms: number[];
  wedges: WedgeEntry[];
  cis_trans_count: number;
  charges: ChargeEntry[];
  arene_substitution_pattern: AreneSubstitutionEntry[];
  ring_heteroatom_positions: RingHeteroatomEntry[];
  /**
   * Step D fill-in-blank source-side support — full atom-by-atom ring walks.
   * The agent's source-side form prompts per-position blanks; mental-model
   * cache cannot serve an atom-by-atom enumeration, so the agent is forced
   * to re-read the image vertex by vertex.
   */
  ring_atom_walks: RingAtomWalkEntry[];
};

// Ketcher Bond stereo codes (mirrored from ketcher-core/Bond.PATTERN.STEREO).
const KETCHER_STEREO_UP = 1;
const KETCHER_STEREO_DOWN = 6;

function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/**
 * Greedy SSSR via shortest-cycle-per-ring-bond. For each ring-bond (a, b),
 * BFS the shortest a→b path through the in-ring subgraph with that bond
 * removed; close with (b, a) to form a cycle. Dedupe by atom-set signature.
 *
 * Works for the chemistry molecules in scope (≤4 fused rings of varying
 * size, including the A004 paclitaxel A/B/C/D scaffold). Known limitation:
 * cubane-class fully-condensed cages over-count by one ring; not in scope.
 */
export function findSSSR(
  atomIds: number[],
  ringBonds: FingerprintBond[],
): number[][] {
  if (ringBonds.length === 0) return [];

  const adj = new Map<number, Map<number, number>>();
  for (const aid of atomIds) adj.set(aid, new Map());
  for (const b of ringBonds) {
    adj.get(b.beginAtomId)?.set(b.endAtomId, b.id);
    adj.get(b.endAtomId)?.set(b.beginAtomId, b.id);
  }

  const cyclesBySig = new Map<string, number[]>();
  for (const bond of ringBonds) {
    const path = shortestPathExcluding(
      adj,
      bond.beginAtomId,
      bond.endAtomId,
      bond.id,
    );
    if (path === null) continue;
    const sig = [...path].sort((a, b) => a - b).join(',');
    if (!cyclesBySig.has(sig)) cyclesBySig.set(sig, path);
  }

  return Array.from(cyclesBySig.values());
}

function shortestPathExcluding(
  adj: Map<number, Map<number, number>>,
  start: number,
  end: number,
  excludeBondId: number,
): number[] | null {
  if (start === end) return [start];
  const predecessor = new Map<number, number | null>();
  predecessor.set(start, null);
  const queue: number[] = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    const neighbors = adj.get(cur);
    if (!neighbors) continue;
    for (const [next, bondId] of neighbors) {
      if (bondId === excludeBondId) continue;
      if (predecessor.has(next)) continue;
      predecessor.set(next, cur);
      if (next === end) {
        const path: number[] = [];
        let n: number | null = next;
        while (n !== null) {
          path.unshift(n);
          n = predecessor.get(n) ?? null;
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * Canonicalize a ring's atom walk to a structurally-grounded form, atom-id
 * INDEPENDENT (so the grader's RDKit recompute on `final_smiles` and the
 * translator's JS compute on the canvas state produce the same walk, even
 * though their atom-id spaces differ).
 *
 * The locant-minimization rule (IUPAC-style):
 *   1. Enumerate every rotation + its reverse — 2N candidate walks for a
 *      ring of size N.
 *   2. For each, build a score tuple:
 *      (heteroatom positions ascending, substituent positions ascending,
 *       element string lex order around the walk).
 *   3. Pick the candidate whose score tuple is lex-smallest. Ties (e.g.
 *      benzene — fully symmetric) resolve identically on both sides because
 *      the score depends only on element + neighbor topology, not atom ids.
 *
 * `elemByAtom` gives each ring atom's element. `hasExternalNeighbor` flags
 * ring atoms that have a non-ring non-H neighbor (used for substituent
 * locant tie-breaking). Both are derived inside `computeVisionCheckCandidate`
 * from the incoming fingerprint input.
 */
function canonicalizeRingWalk(
  atoms: number[],
  elemByAtom: Map<number, string>,
  hasExternalNeighbor: Map<number, boolean>,
): number[] {
  const n = atoms.length;
  if (n === 0) return atoms;
  if (n === 1) return [...atoms];

  const variants: number[][] = [];
  for (let start = 0; start < n; start++) {
    const forward: number[] = [];
    for (let i = 0; i < n; i++) forward.push(atoms[(start + i) % n]);
    variants.push(forward);
    const reverse: number[] = [forward[0]];
    for (let i = n - 1; i >= 1; i--) reverse.push(forward[i]);
    variants.push(reverse);
  }

  function score(walk: number[]): {
    heteroLocants: number[];
    subLocants: number[];
    elementWalk: string[];
  } {
    const heteroLocants: number[] = [];
    const subLocants: number[] = [];
    const elementWalk: string[] = [];
    walk.forEach((aid, i) => {
      const elem = elemByAtom.get(aid) ?? 'C';
      elementWalk.push(elem);
      if (elem !== 'C' && elem !== 'H') heteroLocants.push(i + 1);
      if (hasExternalNeighbor.get(aid) === true) subLocants.push(i + 1);
    });
    return { heteroLocants, subLocants, elementWalk };
  }

  function cmpTuple(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  }

  function cmpStringWalk(a: string[], b: string[]): number {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  }

  let best = variants[0];
  let bestScore = score(best);
  for (let i = 1; i < variants.length; i++) {
    const s = score(variants[i]);
    const c1 = cmpTuple(s.heteroLocants, bestScore.heteroLocants);
    if (c1 < 0) {
      best = variants[i];
      bestScore = s;
      continue;
    }
    if (c1 > 0) continue;
    const c2 = cmpTuple(s.subLocants, bestScore.subLocants);
    if (c2 < 0) {
      best = variants[i];
      bestScore = s;
      continue;
    }
    if (c2 > 0) continue;
    const c3 = cmpStringWalk(s.elementWalk, bestScore.elementWalk);
    if (c3 < 0) {
      best = variants[i];
      bestScore = s;
    }
  }
  return best;
}

export function computeVisionCheckCandidate(
  input: FingerprintInput,
): VisionCheckCandidate {
  const { atoms, bonds, drawnHAtomIds, canonicalSmiles } = input;

  const heavy = atoms.filter((a) => a.label !== 'H').length;

  const ringBonds = bonds.filter((b) => b.inRing);
  const rawRings = findSSSR(
    atoms.map((a) => a.id),
    ringBonds,
  );

  // Element + neighbor index lookups for canonicalization.
  const elemByAtom = new Map(atoms.map((a) => [a.id, a.label]));
  const allRingAtoms = new Set<number>();
  for (const ring of rawRings) for (const aid of ring) allRingAtoms.add(aid);

  const atomNeighbors = new Map<number, number[]>();
  for (const a of atoms) atomNeighbors.set(a.id, []);
  for (const b of bonds) {
    atomNeighbors.get(b.beginAtomId)?.push(b.endAtomId);
    atomNeighbors.get(b.endAtomId)?.push(b.beginAtomId);
  }

  // Per ring (later: ring-specific). For canonicalization, a ring atom's
  // "external neighbor" excludes other atoms in the SAME ring. Compute
  // per-ring below; this map is the global-non-ring-non-H placeholder.
  const hasExternalNonRingNonH = new Map<number, boolean>();
  for (const aid of allRingAtoms) {
    const neighbors = atomNeighbors.get(aid) ?? [];
    const hasExt = neighbors.some((n) => {
      if (allRingAtoms.has(n)) return false;
      const nLabel = elemByAtom.get(n) ?? 'C';
      return nLabel !== 'H';
    });
    hasExternalNonRingNonH.set(aid, hasExt);
  }

  const canonicalRings = rawRings.map((walk) =>
    canonicalizeRingWalk(walk, elemByAtom, hasExternalNonRingNonH),
  );

  // Deterministic ring order: sort by element-walk sequence (atom-id
  // independent), then size. Compare element walks of canonical rings.
  function elementWalk(walk: number[]): string[] {
    return walk.map((aid) => elemByAtom.get(aid) ?? 'C');
  }
  canonicalRings.sort((r1, r2) => {
    if (r1.length !== r2.length) return r1.length - r2.length;
    const e1 = elementWalk(r1);
    const e2 = elementWalk(r2);
    for (let i = 0; i < e1.length; i++) {
      if (e1[i] !== e2[i]) return e1[i] < e2[i] ? -1 : 1;
    }
    return 0;
  });

  const atomById = new Map(atoms.map((a) => [a.id, a]));
  const bondByPair = new Map<string, FingerprintBond>();
  for (const b of bonds) bondByPair.set(pairKey(b.beginAtomId, b.endAtomId), b);

  // A ring is aromatic iff every ring bond is flagged aromatic.
  const rings: RingDescriptor[] = canonicalRings.map((walk, idx) => {
    const aromatic = walk.every((aid, i) => {
      const nextId = walk[(i + 1) % walk.length];
      const bond = bondByPair.get(pairKey(aid, nextId));
      return bond?.aromatic === true;
    });
    return {
      id: `r${idx}`,
      size: walk.length,
      aromatic,
    };
  });

  // Ring connectivity: spiro / fused / bridged.
  const ringConnectivity: RingConnectivityEntry[] = [];
  for (let i = 0; i < canonicalRings.length; i++) {
    const setI = new Set(canonicalRings[i]);
    const edgesI = ringEdgeSet(canonicalRings[i]);
    for (let j = i + 1; j < canonicalRings.length; j++) {
      const sharedAtoms = canonicalRings[j].filter((a) => setI.has(a)).length;
      if (sharedAtoms === 0) continue;
      const edgesJ = ringEdgeSet(canonicalRings[j]);
      let sharedBonds = 0;
      for (const e of edgesI) if (edgesJ.has(e)) sharedBonds++;
      let kind: 'fused' | 'bridged' | 'spiro';
      if (sharedAtoms === 1 && sharedBonds === 0) kind = 'spiro';
      else if (sharedAtoms === 2 && sharedBonds === 1) kind = 'fused';
      else kind = 'bridged';
      ringConnectivity.push({ ring_a: `r${i}`, ring_b: `r${j}`, kind });
    }
  }

  // Wedges (solid / hashed) from bond.stereo.
  const wedges: WedgeEntry[] = [];
  for (const b of bonds) {
    if (b.stereo === KETCHER_STEREO_UP) {
      wedges.push({ a: b.beginAtomId, b: b.endAtomId, kind: 'solid' });
    } else if (b.stereo === KETCHER_STEREO_DOWN) {
      wedges.push({ a: b.beginAtomId, b: b.endAtomId, kind: 'hashed' });
    }
  }

  // cis/trans count from canonical SMILES slashes (each E/Z double bond
  // emits two `/` or `\` characters in the canonical SMILES).
  let cisTransCount = 0;
  if (canonicalSmiles) {
    const slashes = (canonicalSmiles.match(/[\\/]/g) ?? []).length;
    cisTransCount = Math.floor(slashes / 2);
  }

  const charges: ChargeEntry[] = atoms
    .filter((a) => a.charge !== 0)
    .map((a) => ({ id: a.id, charge: a.charge }));

  // Arene substitution pattern: per aromatic ring, walk canonical cyclic
  // order and emit 1-indexed positions whose ring atom has a non-ring
  // non-H neighbor.
  const arene: AreneSubstitutionEntry[] = [];
  for (let i = 0; i < canonicalRings.length; i++) {
    if (!rings[i].aromatic) continue;
    const walk = canonicalRings[i];
    const ringSet = new Set(walk);
    const positions: number[] = [];
    walk.forEach((aid, pos) => {
      const neighbors = atomNeighbors.get(aid) ?? [];
      const hasSubstituent = neighbors.some((n) => {
        if (ringSet.has(n)) return false;
        const nAtom = atomById.get(n);
        return nAtom !== undefined && nAtom.label !== 'H';
      });
      if (hasSubstituent) positions.push(pos + 1);
    });
    arene.push({ ring: `r${i}`, positions });
  }

  // Ring heteroatom positions: per ring containing any non-C non-H atom,
  // walk canonical order, record (element, position) for each non-C atom.
  const ringHetero: RingHeteroatomEntry[] = [];
  for (let i = 0; i < canonicalRings.length; i++) {
    const walk = canonicalRings[i];
    const entries: Array<{ element: string; position: number }> = [];
    walk.forEach((aid, pos) => {
      const elem = atomById.get(aid)?.label ?? 'C';
      if (elem !== 'C' && elem !== 'H') {
        entries.push({ element: elem, position: pos + 1 });
      }
    });
    if (entries.length > 0) {
      ringHetero.push({ ring: `r${i}`, entries });
    }
  }

  // Full atom-by-atom walks for Step D fill-in-blank source-side form.
  const ringAtomWalks: RingAtomWalkEntry[] = canonicalRings.map(
    (walk, idx) => ({
      ring: `r${idx}`,
      atoms: walk.map((aid, pos) => ({
        id: aid,
        element: atomById.get(aid)?.label ?? 'C',
        position: pos + 1,
      })),
    }),
  );

  const drawnH = [...new Set(drawnHAtomIds)].sort((a, b) => a - b);

  return {
    heavy,
    rings,
    ring_connectivity: ringConnectivity,
    drawn_H_atoms: drawnH,
    wedges,
    cis_trans_count: cisTransCount,
    charges,
    arene_substitution_pattern: arene,
    ring_heteroatom_positions: ringHetero,
    ring_atom_walks: ringAtomWalks,
  };
}

function ringEdgeSet(walk: number[]): Set<string> {
  const edges = new Set<string>();
  for (let i = 0; i < walk.length; i++) {
    edges.add(pairKey(walk[i], walk[(i + 1) % walk.length]));
  }
  return edges;
}
