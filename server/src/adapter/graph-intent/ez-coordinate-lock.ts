/**
 * P1.1 — lock declared `bond.geom` (cis/trans) against the post-layout
 * coordinate frame on the `ketcher_clean_locked` build path.
 *
 * The clean_locked path runs a global Indigo `layout()` (translator.ts
 * `applyLayoutLockedStereo` step 3) that recomputes EVERY atom coordinate from
 * scratch to untangle dense fused systems for the parity-transfer stereo pass.
 * That global redraw is blind to the agent's drawn double-bond geometry, so a
 * declared cis double bond can come out trans (and vice-versa). On the
 * coord-bearing non-locked path this never happens — the agent's pixel coords
 * are pinned and `clean()` is skipped, so the drawn E/Z survives to export.
 * The clean_locked path had no equivalent: `verifyDeclaredGeomFromCanvas` only
 * *detects* the mismatch (advisory diagnostic) and never repairs it.
 *
 * `setBondStereo(CIS_TRANS=3)` is NOT an option — it corrupts Indigo's SMILES
 * writer (see the ez-verify.ts header). The supported lever is coordinates:
 * Indigo perceives E/Z from the 2-D layout, so re-pinning the geometry fixes
 * the exported SMILES. This module computes that re-pin as a pure plan; the
 * translator applies it via `setAtomXY`.
 *
 * Strategy — reflect one half of the molecule across the double-bond axis:
 * for an acyclic 1,2-disubstituted declared-geom bond whose built geometry
 * contradicts the declared cis/trans, reflecting the connected component on
 * ONE side of the bond across the line through the two double-bond atoms flips
 * the bond's cis/trans while preserving every intra-half bond length and angle
 * (a reflection is a rigid isometry). The two halves may visually overlap after
 * the reflection — irrelevant, because the exported SMILES encodes topology +
 * stereo, not coordinates, and the only geometry Indigo reads for THIS bond's
 * E/Z is the now-corrected local arrangement of its immediate neighbors.
 *
 * Safety — the reflected half must contain NO stereocenter. A reflection
 * inverts chirality, so reflecting a half that carries a tetrahedral center
 * would flip that center's perceived R/S. We run AFTER the tetrahedral stereo
 * pass (wedge primitives + Mode C V2000 re-apply), at which point centers whose
 * intent disagreed with perception are already locked by layout-invariant
 * parity bits — but centers that agreed rely on wedge + coordinates, so moving
 * their coordinates is unsafe. We therefore only ever reflect a
 * stereocenter-free half. When BOTH halves carry a stereocenter (an E/Z bond
 * sandwiched between two stereo regions) we skip and leave the advisory
 * diagnostic to fire — an honest limitation, not a silent wrong answer.
 *
 * This module is pure — no Ketcher, no I/O. It mirrors ez-verify.ts's split:
 * the pure plan here, the runtime application + Indigo verification in the
 * translator.
 */

import type { GraphIntent } from '../../types/graph-intent';
import type { FrozenCoords } from './stereo-transfer';

/** One reflected-atom coordinate update, keyed by GraphIntent atom id. */
export type EZCoordUpdate = { id: number; x: number; y: number };

/** Per declared-geom bond outcome — forensic record. */
export type EZLockRecord = {
  /** GraphIntent endpoints of the double bond. */
  a: number;
  b: number;
  declared: 'cis' | 'trans';
  action: 'already_correct' | 'reflected' | 'skipped';
  /** Which half was reflected (only when action === 'reflected'). */
  reflectedHalf?: 'a' | 'b';
  /** Why the bond was skipped (only when action === 'skipped'). */
  reason?:
    | 'not_disubstituted'
    | 'ring_bond'
    | 'no_coords'
    | 'colinear'
    | 'between_stereocenters';
};

export type EZCoordinateLockPlan = {
  updates: EZCoordUpdate[];
  records: EZLockRecord[];
};

/** Cross-product z of (B−A) × (P−A); its sign is the side of line AB that P is on. */
function sideOfLine(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  return ux * (p.y - a.y) - uy * (p.x - a.x);
}

/** Reflect point `p` across the infinite line through `a` and `b`. */
function reflectAcrossLine(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { x: p.x, y: p.y };
  // Project (p − a) onto the axis, then reflect: r = 2·proj − p.
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const projx = a.x + t * dx;
  const projy = a.y + t * dy;
  return { x: 2 * projx - p.x, y: 2 * projy - p.y };
}

/**
 * BFS the connected component reachable from `start` over `graph.bonds` with
 * the single edge `(skipA, skipB)` removed. Returns the set of atom ids
 * (includes `start`).
 */
function componentWithout(
  graph: GraphIntent,
  start: number,
  skipA: number,
  skipB: number,
): Set<number> {
  const adj = new Map<number, number[]>();
  for (const atom of graph.atoms) adj.set(atom.id, []);
  for (const bond of graph.bonds) {
    const isSkipped =
      (bond.a === skipA && bond.b === skipB) ||
      (bond.a === skipB && bond.b === skipA);
    if (isSkipped) continue;
    adj.get(bond.a)?.push(bond.b);
    adj.get(bond.b)?.push(bond.a);
  }
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of adj.get(cur) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

/** Heavy (non-H) neighbors of `atomId`, excluding `exclude`. */
function heavyNeighbors(
  graph: GraphIntent,
  elementById: Map<number, string>,
  atomId: number,
  exclude: number,
): number[] {
  const out: number[] = [];
  for (const bond of graph.bonds) {
    let other: number | null = null;
    if (bond.a === atomId) other = bond.b;
    else if (bond.b === atomId) other = bond.a;
    if (other === null || other === exclude) continue;
    if ((elementById.get(other) ?? 'C') === 'H') continue;
    out.push(other);
  }
  return out;
}

/**
 * Plan the coordinate re-pin needed to make every declared-geom double bond's
 * built geometry agree with its `cis` / `trans` label, given the frozen
 * post-layout coordinates.
 *
 * `stereocenterIds` is the set of GraphIntent atom ids that carry tetrahedral
 * stereo (on the clean_locked path: every `stereoTransfer[].center`). A half
 * containing any of these is never reflected.
 *
 * Pure: no mutation of inputs, no I/O. The translator applies `updates` via
 * `setAtomXY` and may dump `records` for forensics.
 */
export function planEZCoordinateLock(args: {
  graph: GraphIntent;
  frozenCoords: FrozenCoords;
  stereocenterIds: ReadonlySet<number>;
}): EZCoordinateLockPlan {
  const { graph, frozenCoords, stereocenterIds } = args;
  const elementById = new Map(graph.atoms.map((a) => [a.id, a.element]));
  const updates: EZCoordUpdate[] = [];
  const records: EZLockRecord[] = [];

  for (const bond of graph.bonds) {
    if (bond.geom !== 'cis' && bond.geom !== 'trans') continue;
    const declared = bond.geom;
    const a = bond.a;
    const b = bond.b;

    const n1s = heavyNeighbors(graph, elementById, a, b);
    const n2s = heavyNeighbors(graph, elementById, b, a);
    if (n1s.length !== 1 || n2s.length !== 1) {
      // Tri/tetra-substituted or terminal =CH2: the cis/trans reference is
      // ambiguous without explicit refs. Leave geometry to layout (advisory
      // verifier still reports it).
      records.push({ a, b, declared, action: 'skipped', reason: 'not_disubstituted' });
      continue;
    }
    const n1 = n1s[0];
    const n2 = n2s[0];

    const pa = frozenCoords[a];
    const pb = frozenCoords[b];
    const pn1 = frozenCoords[n1];
    const pn2 = frozenCoords[n2];
    if (!pa || !pb || !pn1 || !pn2) {
      records.push({ a, b, declared, action: 'skipped', reason: 'no_coords' });
      continue;
    }

    const bComponent = componentWithout(graph, b, a, b);
    if (bComponent.has(a)) {
      // Removing the bond left the endpoints connected → the bond is in a ring.
      // No clean bipartition to reflect; ring E/Z is layout-constrained.
      records.push({ a, b, declared, action: 'skipped', reason: 'ring_bond' });
      continue;
    }
    const aComponent = componentWithout(graph, a, a, b);

    const s1 = sideOfLine(pn1, pa, pb);
    const s2 = sideOfLine(pn2, pa, pb);
    if (s1 === 0 || s2 === 0) {
      records.push({ a, b, declared, action: 'skipped', reason: 'colinear' });
      continue;
    }

    const currentlyCis = s1 > 0 === s2 > 0;
    const wantCis = declared === 'cis';
    if (currentlyCis === wantCis) {
      records.push({ a, b, declared, action: 'already_correct' });
      continue;
    }

    // Need to flip. Reflect a stereocenter-free half across the bond axis;
    // either half works (flipping either reference neighbor's side flips the
    // relationship). Prefer the smaller clean half.
    const hasStereo = (comp: Set<number>): boolean => {
      for (const id of comp) if (stereocenterIds.has(id)) return true;
      return false;
    };
    const aClean = !hasStereo(aComponent);
    const bClean = !hasStereo(bComponent);
    let half: 'a' | 'b' | null = null;
    if (aClean && bClean) {
      half = aComponent.size <= bComponent.size ? 'a' : 'b';
    } else if (bClean) {
      half = 'b';
    } else if (aClean) {
      half = 'a';
    }
    if (half === null) {
      records.push({ a, b, declared, action: 'skipped', reason: 'between_stereocenters' });
      continue;
    }

    const component = half === 'a' ? aComponent : bComponent;
    for (const id of component) {
      const p = frozenCoords[id];
      if (!p) continue;
      const r = reflectAcrossLine(p, pa, pb);
      // The two shared axis atoms (a, b) sit on the line → reflection is a
      // no-op; skip them to avoid redundant setAtomXY churn.
      if (Math.abs(r.x - p.x) < 1e-9 && Math.abs(r.y - p.y) < 1e-9) continue;
      updates.push({ id, x: r.x, y: r.y });
    }
    records.push({ a, b, declared, action: 'reflected', reflectedHalf: half });
  }

  return { updates, records };
}
