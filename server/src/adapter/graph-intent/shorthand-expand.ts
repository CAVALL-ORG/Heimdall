/**
 * Task 5F — shorthand-glyph pre-expansion for the direct GraphIntent path.
 *
 * The agent transcribes a collapsed glyph (`OMe`, `Ph`, `Et`, `tBu`, `Boc`,
 * …) as RAW TEXT on a single atom node via the `shorthand` field. This pass
 * runs BEFORE the translator's skeleton build and rewrites the graph so every
 * shorthand atom is replaced by its deterministically-decomposed heavy-atom
 * subgraph (`decomposeShorthand`, the single source of truth — never
 * re-implemented here). The agent NEVER decomposes (LOCK 11); the backend does.
 *
 * Contract (un-orphans `shorthand-table.ts`, whose only consumer — the deleted
 * worksheet compiler — went away in Task 5E):
 *   - Each shorthand atom S is removed. Its decomposed atoms get FRESH ids
 *     (allocated above the current max so they never collide). The decomposed
 *     internal bonds are spliced in.
 *   - Every bond that referenced S is re-wired to the decomposition's
 *     attachment atom (`attachment_atom_offset`). S's own attributes
 *     (`element` placeholder, `drawn_H`, `charge`, `radical`, `isotope`) are
 *     dropped — the table owns the expanded atoms' identities and H counts.
 *   - Rings that referenced S re-point at the attachment atom (a glyph is a
 *     leaf substituent; it is not itself a ring vertex, so this only matters
 *     defensively).
 *   - Expanded atoms inherit S's (x, y) as a shared seed coordinate (jittered
 *     so coincident points don't degenerate Ketcher's layout). Stereo never
 *     rides a shorthand atom, so no wedge/coord-pin contract is affected.
 *   - `graph.counts` is RECOMPUTED for the expanded graph so the translator's
 *     post-build `validate_counts` check stays self-consistent. The agent's
 *     ORIGINAL declared counts (shorthand = one opaque visible node) are
 *     validated separately at validate_graph preflight, where shorthand atoms
 *     are excluded from heteroatom / valence derivation.
 *
 * Pure function over the GraphIntent value. No Ketcher, no Indigo, no I/O.
 */
import {
  HALOGEN_ELEMENTS,
  type GraphIntent,
  type IntentAtom,
  type IntentBond,
  type IntentRing,
  type ShorthandExpansion,
} from '../../types/graph-intent';
import {
  decomposeShorthand,
  type ShorthandAtom,
  type ShorthandSubgraph,
} from '../visual-graph/shorthand-table';

/** True iff the atom carries a non-empty `shorthand` glyph token. */
export function isShorthandAtom(atom: { shorthand?: string }): boolean {
  return typeof atom.shorthand === 'string' && atom.shorthand.trim().length > 0;
}

/**
 * ADR-0002 (W2a) — referential-integrity of a declared `expansion`. A declared
 * expansion is the SAME `ShorthandSubgraph` shape the table emits, so it
 * splices through the identical code path. The W1 schema already constrains
 * elements / orders / non-negativity; this validates only the cross-references
 * the schema cannot (bond endpoints index a real atom; the attachment offset
 * indexes a real atom). Returns the failing reason or `null` when sound.
 * Chemistry correctness (valence, etc.) is Ketcher's job at build — NOT here.
 */
function expansionIntegrityError(exp: ShorthandExpansion): string | null {
  const n = exp.atoms.length;
  for (const b of exp.bonds) {
    if (b.a < 0 || b.a >= n || b.b < 0 || b.b >= n) {
      return `bond (${b.a}–${b.b}) indexes outside atoms[0,${n})`;
    }
  }
  if (exp.attachment_atom_offset < 0 || exp.attachment_atom_offset >= n) {
    return `attachment_atom_offset ${exp.attachment_atom_offset} outside atoms[0,${n})`;
  }
  return null;
}

export type UnknownShorthand = { atomId: number; text: string };

/**
 * Enumerate shorthand atoms whose glyph text the deterministic table cannot
 * decompose (not a table entry, not an isotope token, not a bare element) AND
 * which carry NO declared `shorthand_resolution`. An off-table glyph that
 * carries a resolution is resolved-by-declaration (ADR-0002 W2a), not unknown,
 * so it is NOT flagged here — the translator splices its declared expansion.
 * An off-table glyph with no resolution is STILL flagged (fail-closed). Used by
 * validate_graph to emit `unknown_shorthand` diagnostics and by the translator
 * to fail the build closed (schema_invalid) before any canvas mutation. Pure —
 * no graph mutation.
 */
export function findUnknownShorthand(graph: GraphIntent): UnknownShorthand[] {
  const out: UnknownShorthand[] = [];
  for (const atom of graph.atoms) {
    if (!isShorthandAtom(atom)) continue;
    // A declared resolution makes an off-table glyph resolved-by-declaration.
    if (atom.shorthand_resolution !== undefined) continue;
    const text = atom.shorthand!.trim();
    if (decomposeShorthand(text).unknown) {
      out.push({ atomId: atom.id, text });
    }
  }
  return out;
}

export type InvalidShorthandExpansion = {
  atomId: number;
  text: string;
  reason: string;
};

/**
 * ADR-0002 (W2a) — enumerate shorthand atoms whose declared
 * `shorthand_resolution.expansion` is referentially malformed (a bond endpoint
 * or the attachment offset points outside the expansion's own atoms). Only
 * checked for an OFF-table glyph (a resolution on a table glyph is rejected
 * upstream as redundant, and the table — not the resolution — would be used
 * anyway). Surfaced by validate_graph as `shorthand_expansion_invalid` and
 * guarded defensively in `expandShorthand`. Pure — no graph mutation.
 */
export function findInvalidShorthandExpansion(
  graph: GraphIntent,
): InvalidShorthandExpansion[] {
  const out: InvalidShorthandExpansion[] = [];
  for (const atom of graph.atoms) {
    const res = atom.shorthand_resolution;
    if (res === undefined) continue;
    if (!isShorthandAtom(atom)) continue;
    const text = atom.shorthand!.trim();
    // Table glyph wins (resolution is redundant; table is used). Skip the
    // integrity check — the declared expansion is never spliced for it.
    if (!decomposeShorthand(text).unknown) continue;
    const reason = expansionIntegrityError(res.expansion);
    if (reason !== null) {
      out.push({ atomId: atom.id, text, reason });
    }
  }
  return out;
}

/** Does the graph carry at least one shorthand atom? */
export function hasShorthand(graph: GraphIntent): boolean {
  return graph.atoms.some(isShorthandAtom);
}

export type RedundantShorthandResolution = { atomId: number; text: string };

/**
 * ADR-0002 (W1) — table-collision check. A `shorthand_resolution` declares the
 * expansion for a glyph the deterministic table LACKS. If the glyph IS already
 * in the table (or is an isotope token / bare element the table resolves), the
 * table wins — there must be exactly one source per glyph, and a declared
 * resolution for a table-covered glyph is redundant (and risks disagreeing with
 * the curated entry). Surfaced by validate_graph as a
 * `shorthand_resolution_redundant` diagnostic.
 *
 * This rule is SEMANTIC (it needs the table), so it lives here in the
 * adapter/validator path rather than in the decoupled types module. Pure — no
 * graph mutation.
 */
export function findRedundantShorthandResolution(
  graph: GraphIntent,
): RedundantShorthandResolution[] {
  const out: RedundantShorthandResolution[] = [];
  for (const atom of graph.atoms) {
    if (atom.shorthand_resolution === undefined) continue;
    if (!isShorthandAtom(atom)) continue;
    const text = atom.shorthand!.trim();
    // Glyph IS resolvable by the deterministic table → the declared resolution
    // is redundant (table wins, one source per glyph).
    if (!decomposeShorthand(text).unknown) {
      out.push({ atomId: atom.id, text });
    }
  }
  return out;
}

function shorthandToIntentAtom(
  s: ShorthandAtom,
  id: number,
  x: number | undefined,
  y: number | undefined,
): IntentAtom {
  const atom: IntentAtom = {
    id,
    element: s.element,
    drawn_H: s.drawn_H ?? null,
    charge: 0,
    radical: 0,
    ring: null,
  };
  if (s.isotope !== undefined) atom.isotope = s.isotope;
  if (x !== undefined && y !== undefined) {
    atom.x = x;
    atom.y = y;
  }
  return atom;
}

/**
 * Recompute the GraphIntent counts (heavy / rings / heteroatoms) from the
 * expanded atoms + bonds. Mirrors the validator's heteroatom derivation
 * (halogens folded under `halogens`) and the Euler-characteristic ring count
 * used post-build. Preserves any optional count fields the agent supplied
 * (`components`, `drawn_H_atoms`, `degree_sequence` are dropped because they
 * described the pre-expansion graph and would no longer match).
 */
function recomputeCounts(
  atoms: IntentAtom[],
  bonds: IntentBond[],
): GraphIntent['counts'] {
  const heavy = atoms.filter((a) => a.element !== 'H').length;

  // Ring count = cyclomatic number per connected component (bonds - atoms +
  // components), matching counts.ts computeCounts on the canvas.
  const adjacency = new Map<number, number[]>();
  for (const a of atoms) adjacency.set(a.id, []);
  for (const b of bonds) {
    adjacency.get(b.a)?.push(b.b);
    adjacency.get(b.b)?.push(b.a);
  }
  const visited = new Set<number>();
  let components = 0;
  for (const a of atoms) {
    if (visited.has(a.id)) continue;
    components++;
    const stack = [a.id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const n of adjacency.get(cur) ?? []) {
        if (!visited.has(n)) stack.push(n);
      }
    }
  }
  const rings = Math.max(0, bonds.length - atoms.length + components);

  const heteroatoms: Record<string, number> = {};
  for (const a of atoms) {
    if (a.element === 'C' || a.element === 'H') continue;
    if (HALOGEN_ELEMENTS.has(a.element)) {
      heteroatoms.halogens = (heteroatoms.halogens ?? 0) + 1;
    } else {
      heteroatoms[a.element] = (heteroatoms[a.element] ?? 0) + 1;
    }
  }

  return { heavy, rings, heteroatoms };
}

/**
 * Expand every shorthand atom in `graph` into its decomposed heavy-atom
 * subgraph, re-wiring bonds + rings and recomputing counts. Returns a NEW
 * GraphIntent (the input is not mutated). When the graph carries no shorthand
 * atom, returns it unchanged.
 *
 * Throws if an unknown shorthand survived to here — callers (translator)
 * must run `findUnknownShorthand` first and reject with a schema_invalid /
 * unknown_shorthand diagnostic; reaching the expand step with an unknown
 * token is a backend bug.
 */
export function expandShorthand(graph: GraphIntent): GraphIntent {
  if (!hasShorthand(graph)) return graph;

  let nextId = graph.atoms.reduce((m, a) => Math.max(m, a.id), -1) + 1;

  const outAtoms: IntentAtom[] = [];
  const outBonds: IntentBond[] = [...graph.bonds.map((b) => ({ ...b }))];

  // For each shorthand atom: map its id → the attachment atom's NEW id, so
  // bonds/rings that referenced it re-point at the decomposition anchor.
  const shorthandAnchorId = new Map<number, number>();

  for (const atom of graph.atoms) {
    if (!isShorthandAtom(atom)) {
      outAtoms.push({ ...atom });
      continue;
    }
    const text = atom.shorthand!.trim();
    // Resolve the local subgraph to splice. The table wins when the glyph is on
    // it (ADR-0002: one source per glyph; a resolution on a table glyph is
    // rejected at validate as redundant). An OFF-table glyph that carries a
    // declared `shorthand_resolution.expansion` splices that expansion through
    // this same path (W2a). An off-table glyph with NO resolution still fails
    // closed (the unchanged backend-bug guard — callers run findUnknownShorthand
    // first and reject).
    const tableDecomp = decomposeShorthand(text);
    let decomp: ShorthandSubgraph;
    if (!tableDecomp.unknown) {
      decomp = tableDecomp;
    } else if (atom.shorthand_resolution !== undefined) {
      const exp = atom.shorthand_resolution.expansion;
      // Defensive integrity guard so a malformed declared expansion never
      // splices even if reached directly (callers should run
      // findInvalidShorthandExpansion first and reject).
      const reason = expansionIntegrityError(exp);
      if (reason !== null) {
        throw new Error(
          `expandShorthand: invalid declared expansion for '${text}' on atom ` +
            `${atom.id}: ${reason}`,
        );
      }
      decomp = exp;
    } else {
      throw new Error(
        `expandShorthand: unknown shorthand '${text}' on atom ${atom.id} ` +
          '(callers must run findUnknownShorthand and reject first)',
      );
    }

    // Allocate fresh ids for the decomposition's local atoms (0-indexed →
    // global). Place all expanded atoms at the shorthand node's coordinate
    // with a tiny per-atom jitter so coincident points don't collapse a
    // layout. Coords are advisory here — shorthand never carries stereo.
    const localToGlobal: number[] = [];
    decomp.atoms.forEach((sa, i) => {
      const gid = nextId++;
      localToGlobal.push(gid);
      const jitterX =
        atom.x !== undefined ? atom.x + i * 0.01 : undefined;
      const jitterY =
        atom.y !== undefined ? atom.y + i * 0.01 : undefined;
      outAtoms.push(shorthandToIntentAtom(sa, gid, jitterX, jitterY));
    });

    const anchorGlobal = localToGlobal[decomp.attachment_atom_offset];
    shorthandAnchorId.set(atom.id, anchorGlobal);

    // Splice the decomposition's internal bonds (local ids → global).
    for (const sb of decomp.bonds) {
      outBonds.push({
        a: localToGlobal[sb.a],
        b: localToGlobal[sb.b],
        order: sb.order,
        wedge: null,
        wedge_from: null,
      });
    }
  }

  // Re-wire every external bond endpoint that pointed at a shorthand atom to
  // that shorthand's attachment anchor.
  for (const bond of outBonds) {
    const aAnchor = shorthandAnchorId.get(bond.a);
    if (aAnchor !== undefined) bond.a = aAnchor;
    const bAnchor = shorthandAnchorId.get(bond.b);
    if (bAnchor !== undefined) bond.b = bAnchor;
  }

  // Re-point ring atom references (defensive — a glyph substituent is a leaf,
  // not a ring vertex, so this normally rewrites nothing).
  const outRings: IntentRing[] = graph.rings.map((r) => ({
    ...r,
    atoms: r.atoms.map((aid) => shorthandAnchorId.get(aid) ?? aid),
  }));

  return {
    ...graph,
    atoms: outAtoms,
    bonds: outBonds,
    rings: outRings,
    counts: recomputeCounts(outAtoms, outBonds),
  };
}
