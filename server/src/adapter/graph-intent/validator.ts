import { ZodError } from 'zod';
import {
  edgeKey,
  graphIntentSchema,
  HALOGEN_ELEMENTS,
  readCountValue,
  type GraphIntent,
  type IntentAtom,
  type BlackBoxRegion,
} from '../../types/graph-intent';

export type ValidationIssue = { path: string; message: string };

export type ValidationResult =
  | { valid: true; graph: GraphIntent }
  | { valid: false; errors: ValidationIssue[] };

function hasCoords(atom: IntentAtom): boolean {
  return atom.x !== undefined && atom.y !== undefined;
}

export function validateGraphIntent(raw: unknown): ValidationResult {
  let parsed: GraphIntent;
  try {
    parsed = graphIntentSchema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        valid: false,
        errors: error.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      };
    }
    throw error;
  }

  const issues: ValidationIssue[] = [];
  const atomIds = new Set<number>();
  const atomById = new Map<number, IntentAtom>();
  for (const atom of parsed.atoms) {
    if (atomIds.has(atom.id)) {
      issues.push({ path: `atoms[id=${atom.id}]`, message: 'duplicate atom id' });
    }
    atomIds.add(atom.id);
    atomById.set(atom.id, atom);
  }

  // V1 partial-coord: an atom that has only x or only y is malformed.
  for (const atom of parsed.atoms) {
    const xDef = atom.x !== undefined;
    const yDef = atom.y !== undefined;
    if (xDef !== yDef) {
      issues.push({
        path: `atoms[id=${atom.id}]`,
        message: 'x and y must be supplied together (V1)',
      });
    }
  }

  // Adjacency map for V2/V4 coord-cluster checks.
  const adjacency = new Map<number, Set<number>>();
  for (const atom of parsed.atoms) adjacency.set(atom.id, new Set());

  const seenBondKeys = new Set<string>();
  parsed.bonds.forEach((bond, index) => {
    if (bond.a === bond.b) {
      issues.push({ path: `bonds[${index}]`, message: 'self-loop bond (a === b)' });
    }
    if (!atomIds.has(bond.a)) {
      issues.push({ path: `bonds[${index}].a`, message: `unknown atom id ${bond.a}` });
    }
    if (!atomIds.has(bond.b)) {
      issues.push({ path: `bonds[${index}].b`, message: `unknown atom id ${bond.b}` });
    }
    const key = edgeKey(bond.a, bond.b);
    if (seenBondKeys.has(key)) {
      issues.push({ path: `bonds[${index}]`, message: `duplicate bond ${key}` });
    }
    seenBondKeys.add(key);
    if (atomIds.has(bond.a) && atomIds.has(bond.b)) {
      adjacency.get(bond.a)!.add(bond.b);
      adjacency.get(bond.b)!.add(bond.a);
    }

    if (bond.wedge !== null) {
      if (bond.order !== 1) {
        issues.push({
          path: `bonds[${index}].wedge`,
          message: 'wedge only valid on single bonds (order=1)',
        });
      }
      if (bond.wedge_from === null) {
        issues.push({
          path: `bonds[${index}].wedge_from`,
          message: 'wedge_from required when wedge is set',
        });
      } else if (bond.wedge_from !== bond.a && bond.wedge_from !== bond.b) {
        issues.push({
          path: `bonds[${index}].wedge_from`,
          message: 'wedge_from must equal bond.a or bond.b',
        });
      }
    } else if (bond.wedge_from !== null) {
      issues.push({
        path: `bonds[${index}].wedge_from`,
        message: 'wedge_from must be null when wedge is null',
      });
    }

    // V5: bond.geom mutually exclusive with bond.wedge.
    if (bond.geom != null && bond.wedge !== null) {
      issues.push({
        path: `bonds[${index}].geom`,
        message: 'bond.geom mutually exclusive with bond.wedge (V5)',
      });
    }

    // V3: bond.geom only valid on double bonds.
    if (bond.geom != null && bond.order !== 2) {
      issues.push({
        path: `bonds[${index}].geom`,
        message: 'bond.geom requires order=2 (V3)',
      });
    }
  });

  // V2 / V8 / V9: any wedge — whether bond-level (bond.wedge) or atom-level
  // (atom.wedge_to_implicit_h) — requires the chiral cluster (the wedge_from /
  // parent atom + every bonded heavy neighbor) to be coord-pinned. Previously
  // V2 / V8 were gated on `anyCoords`, leaving a fallback path where wedges
  // without coords fell through to clean()-based CIP perception — empirically
  // non-deterministic across substrates (see I008 / D037 / D039 / D041 / D042
  // inversions in agent-orch-<run-id>). V9 closes that fallback:
  // wedges are now mandatory-coord. Graphs with no stereo intent are unaffected
  // (no wedges → no coord requirement).
  parsed.bonds.forEach((bond, index) => {
    if (bond.wedge === null || bond.wedge_from === null) return;
    if (!atomIds.has(bond.a) || !atomIds.has(bond.b)) return;
    const chiral = bond.wedge_from;
    const required = new Set<number>([chiral, ...adjacency.get(chiral) ?? []]);
    const missing: number[] = [];
    for (const id of required) {
      const atom = atomById.get(id);
      if (!atom || !hasCoords(atom)) missing.push(id);
    }
    if (missing.length > 0) {
      issues.push({
        path: `bonds[${index}].wedge`,
        message: `chiral cluster missing coords on atoms [${missing.join(',')}] (V2)`,
      });
    }
  });

  for (const atom of parsed.atoms) {
    if (atom.wedge_to_implicit_h == null) continue;
    const cluster = new Set<number>([atom.id, ...adjacency.get(atom.id) ?? []]);
    const missing: number[] = [];
    for (const id of cluster) {
      const a = atomById.get(id);
      if (!a || !hasCoords(a)) missing.push(id);
    }
    if (missing.length > 0) {
      issues.push({
        path: `atoms[id=${atom.id}].wedge_to_implicit_h`,
        message: `chiral cluster missing coords on atoms [${missing.join(',')}] (V8)`,
      });
    }
  }

  // V4 removed (label-authoritative E/Z): geom needs only the cis/trans label.
  // The backend honors it via planEZCoordinateLock against the post-build
  // coordinate frame (translator), whether or not the agent supplied coords.

  // Task 5F — shorthand atoms are OPAQUE glyph nodes pre-expansion: their
  // `element` is an ignored placeholder and their true composition lives in
  // the backend decomposition table. They are excluded from heteroatom
  // derivation and carbon-valence checks here (those run on the un-expanded
  // graph). The translator's pre-expansion pass replaces them with explicit
  // atoms and recomputes counts before the post-build integrity check.
  const isShorthand = (a: IntentAtom): boolean =>
    typeof a.shorthand === 'string' && a.shorthand.trim().length > 0;

  // V11: fail early on impossible local carbon valence before any canvas
  // mutation. This is intentionally conservative: carbon may not exceed
  // valence 4 in the supported image-rebuild / graph-intent domain. Catching
  // this here prevents dense rows from building an impossible center and only
  // failing much later at SMILES export or RDKit grading time.
  const explicitValence = new Map<number, number>();
  for (const atom of parsed.atoms) {
    explicitValence.set(atom.id, atom.drawn_H ?? 0);
  }
  for (const bond of parsed.bonds) {
    explicitValence.set(bond.a, (explicitValence.get(bond.a) ?? 0) + bond.order);
    explicitValence.set(bond.b, (explicitValence.get(bond.b) ?? 0) + bond.order);
  }
  for (const atom of parsed.atoms) {
    if (atom.element !== 'C') continue;
    if (isShorthand(atom)) continue; // placeholder element — composition is backend-owned
    const valence = explicitValence.get(atom.id) ?? 0;
    if (valence > 4) {
      issues.push({
        path: `atoms[id=${atom.id}]`,
        message: `explicit valence ${valence} exceeds supported carbon valence 4 (V11)`,
      });
    }
  }

  const ringIds = new Set<string>();
  // Edge set for the ring-walk plausibility check below (V12). Built once
  // from the declared bonds, keyed by the canonical (min-max) edge form.
  const bondEdgeSet = new Set<string>();
  for (const bond of parsed.bonds) {
    bondEdgeSet.add(edgeKey(bond.a, bond.b));
  }
  parsed.rings.forEach((ring, index) => {
    if (ringIds.has(ring.id)) {
      issues.push({ path: `rings[${index}].id`, message: `duplicate ring id ${ring.id}` });
    }
    ringIds.add(ring.id);
    let allAtomsKnown = true;
    ring.atoms.forEach((aid, i) => {
      if (!atomIds.has(aid)) {
        allAtomsKnown = false;
        issues.push({
          path: `rings[${index}].atoms[${i}]`,
          message: `unknown atom id ${aid}`,
        });
      }
    });

    // V12 — ring-walk plausibility (single source; previously lived only in
    // validate.ts as `ring_size_walk_mismatch`). Walk the listed atoms and
    // verify every consecutive pair (including wrap-around) is joined by a
    // declared bond. A ring declared larger than the drawn bonds can close
    // (the A011 4-vertex-ring artifact class) surfaces here as a missing
    // closing bond → no closed cycle. Skipped when a ring atom id is
    // unknown (the unknown-id error above already rejects the graph) so the
    // walk doesn't double-report on a malformed ring.
    if (allAtomsKnown && ring.atoms.length >= 3) {
      let walkOk = true;
      for (let i = 0; i < ring.atoms.length && walkOk; i++) {
        const a = ring.atoms[i];
        const b = ring.atoms[(i + 1) % ring.atoms.length];
        if (!bondEdgeSet.has(edgeKey(a, b))) walkOk = false;
      }
      if (!walkOk) {
        issues.push({
          path: `rings[${index}].atoms`,
          message: `ring ${ring.id} declares ${ring.atoms.length} atoms but the vertex walk has a missing bond between consecutive atoms (no closed cycle) (V12)`,
        });
      }
    }
  });

  // Task E — build-time refusal on residual counts.heavy / counts.rings
  // needs_zoom. The validate-graph round can carry these as soft advisories,
  // but build is the fail-closed seam: the agent must upgrade confidence
  // to 'high' (or use a bare number) before a build_from_graph call can
  // proceed.
  const heavyDeclared = readCountValue(parsed.counts.heavy);
  if (heavyDeclared.isNeedsZoom) {
    issues.push({
      path: 'counts.heavy',
      message: `counts.heavy is needs_zoom; resolve to confidence=high (or bare number) before build`,
    });
  } else if (heavyDeclared.value !== parsed.atoms.length) {
    issues.push({
      path: 'counts.heavy',
      message: `counts.heavy=${heavyDeclared.value} but atoms.length=${parsed.atoms.length}`,
    });
  }
  const ringsDeclared = readCountValue(parsed.counts.rings);
  if (ringsDeclared.isNeedsZoom) {
    issues.push({
      path: 'counts.rings',
      message: `counts.rings is needs_zoom; resolve to confidence=high (or bare number) before build`,
    });
  } else if (ringsDeclared.value !== parsed.rings.length) {
    issues.push({
      path: 'counts.rings',
      message: `counts.rings=${ringsDeclared.value} but rings.length=${parsed.rings.length}`,
    });
  }

  const heteroExpected: Record<string, number> = {};
  for (const atom of parsed.atoms) {
    if (atom.element === 'C') continue;
    if (isShorthand(atom)) continue; // opaque glyph — composition is backend-owned
    if (HALOGEN_ELEMENTS.has(atom.element)) {
      heteroExpected.halogens = (heteroExpected.halogens ?? 0) + 1;
    } else {
      heteroExpected[atom.element] = (heteroExpected[atom.element] ?? 0) + 1;
    }
  }
  const declared = parsed.counts.heteroatoms;
  const heteroKeys = new Set([...Object.keys(heteroExpected), ...Object.keys(declared)]);
  for (const key of heteroKeys) {
    const want = heteroExpected[key] ?? 0;
    const got = declared[key] ?? 0;
    if (want !== got) {
      issues.push({
        path: `counts.heteroatoms.${key}`,
        message: `declared ${got}, atoms imply ${want}`,
      });
    }
  }
  // V6: drawn_H_atoms (summary) must equal { atom.id : atom.drawn_H != null }.
  if (parsed.counts.drawn_H_atoms !== undefined) {
    const declared = new Set(parsed.counts.drawn_H_atoms);
    const observed = new Set(
      parsed.atoms.filter((a) => a.drawn_H !== null).map((a) => a.id),
    );
    const missing = [...observed].filter((id) => !declared.has(id));
    const extra = [...declared].filter((id) => !observed.has(id));
    if (missing.length > 0 || extra.length > 0) {
      issues.push({
        path: 'counts.drawn_H_atoms',
        message: `drawn_H_atoms summary mismatch: missing=[${missing.join(',')}] extra=[${extra.join(',')}] (V6)`,
      });
    }
  }

  // V7: degree_sequence (summary) must equal computed-from-atoms+bonds.
  if (parsed.counts.degree_sequence !== undefined) {
    const computed = new Map<number, number>();
    for (const atom of parsed.atoms) computed.set(atom.id, 0);
    for (const bond of parsed.bonds) {
      if (!atomIds.has(bond.a) || !atomIds.has(bond.b)) continue;
      computed.set(bond.a, (computed.get(bond.a) ?? 0) + bond.order);
      computed.set(bond.b, (computed.get(bond.b) ?? 0) + bond.order);
    }
    const observedSeq: Array<[string, number]> = parsed.atoms.map((a) => [
      a.element,
      computed.get(a.id) ?? 0,
    ]);
    const sortTuple = (arr: Array<[string, number]>) =>
      arr.slice().sort((x, y) => {
        if (x[0] !== y[0]) return x[0] < y[0] ? -1 : 1;
        return x[1] - y[1];
      });
    const obsSorted = sortTuple(observedSeq);
    const declSorted = sortTuple(parsed.counts.degree_sequence);
    let mismatch = obsSorted.length !== declSorted.length;
    if (!mismatch) {
      for (let i = 0; i < obsSorted.length; i++) {
        if (obsSorted[i][0] !== declSorted[i][0] || obsSorted[i][1] !== declSorted[i][1]) {
          mismatch = true;
          break;
        }
      }
    }
    if (mismatch) {
      issues.push({
        path: 'counts.degree_sequence',
        message: `degree_sequence summary differs from computed (declared=${JSON.stringify(declSorted)} computed=${JSON.stringify(obsSorted)}) (V7)`,
      });
    }
  }

  // Tranche-B′ committed-ports black box — coherence (FP=0). Runs here so it
  // fires at BOTH validate_graph preflight AND the translator build path (this
  // function is the single-source enforcer). The cross-round FREEZE is separate
  // (checkBlackBoxFreeze, called only from the stateful validate_graph tool).
  issues.push(...validateBlackBoxRegions(parsed));

  if (issues.length > 0) return { valid: false, errors: issues };
  return { valid: true, graph: parsed };
}

/**
 * Coherence check for the optional `black_box_regions` carrier (FP=0 by
 * construction — it can only reject a self-contradictory submission). A port is
 * "a committed boundary atom through which a bond LEAVES the region." For each
 * declared region this verifies:
 *   - every boundary atom exists in atoms[];
 *   - every port's boundary_atom is a member of the region's boundary_atoms;
 *   - each port has a matching crossing bond — an order-`port.order` bond from
 *     its boundary atom to an atom OUTSIDE the region (the interior/neighbor it
 *     pins to). A declared port with no realized crossing is self-contradiction.
 * Absent carrier → no issues (back-compat / fast-on-easy). Infers no chemistry.
 */
export function validateBlackBoxRegions(parsed: GraphIntent): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const regions = parsed.black_box_regions;
  if (!regions || regions.length === 0) return issues;

  const atomIds = new Set(parsed.atoms.map((a) => a.id));
  const adj = new Map<number, Array<{ to: number; order: number }>>();
  for (const a of parsed.atoms) adj.set(a.id, []);
  for (const b of parsed.bonds) {
    adj.get(b.a)?.push({ to: b.b, order: b.order });
    adj.get(b.b)?.push({ to: b.a, order: b.order });
  }

  const seenRegionIds = new Set<string>();
  regions.forEach((region, ri) => {
    if (seenRegionIds.has(region.id)) {
      issues.push({
        path: `black_box_regions[${ri}].id`,
        message: `duplicate black_box region id ${region.id}`,
      });
    }
    seenRegionIds.add(region.id);

    const boundary = new Set(region.boundary_atoms);
    region.boundary_atoms.forEach((ba, bi) => {
      if (!atomIds.has(ba)) {
        issues.push({
          path: `black_box_regions[${ri}].boundary_atoms[${bi}]`,
          message: `black_box region ${region.id} boundary atom ${ba} not in atoms[]`,
        });
      }
    });

    const seenPortIds = new Set<string>();
    region.ports.forEach((port, pi) => {
      if (seenPortIds.has(port.id)) {
        issues.push({
          path: `black_box_regions[${ri}].ports[${pi}].id`,
          message: `duplicate port id ${port.id} in region ${region.id}`,
        });
      }
      seenPortIds.add(port.id);

      if (!boundary.has(port.boundary_atom)) {
        issues.push({
          path: `black_box_regions[${ri}].ports[${pi}].boundary_atom`,
          message: `port ${port.id} boundary_atom ${port.boundary_atom} is not a member of region ${region.id} boundary_atoms`,
        });
        return;
      }
      if (!atomIds.has(port.boundary_atom)) return; // boundary check already flagged it
      const crossings = (adj.get(port.boundary_atom) ?? []).filter(
        (e) => !boundary.has(e.to) && e.order === port.order,
      );
      if (crossings.length === 0) {
        issues.push({
          path: `black_box_regions[${ri}].ports[${pi}]`,
          message: `port ${port.id}: no order-${port.order} bond crosses out of region ${region.id} at boundary atom ${port.boundary_atom} (declared port has no realized crossing bond)`,
        });
      }
    });
  });
  return issues;
}

/**
 * Cross-round STRUCTURAL freeze for the black box (the dense-stitch lever; G3:
 * the freeze, not orientation, recovers the wiring — and III.9#3 disconfirmed a
 * prose-only freeze, so it is enforced structurally here). Given the regions
 * committed in an earlier validate round (`prior`) and the `current` draft,
 * later rounds may only ADD interior: a committed boundary atom may not be
 * deleted or dropped from its region, and a committed port (boundary_atom +
 * order) may not be re-pointed or removed. FP=0 in the sense that it can only
 * reject a submission that contradicts the agent's OWN prior commitment. Pure;
 * the stateful read/persist of `prior` lives in the validate_graph tool.
 */
export function checkBlackBoxFreeze(
  prior: BlackBoxRegion[] | undefined,
  current: GraphIntent,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!prior || prior.length === 0) return issues;
  const curAtomIds = new Set(current.atoms.map((a) => a.id));
  const curRegions = new Map(
    (current.black_box_regions ?? []).map((r) => [r.id, r]),
  );
  for (const pr of prior) {
    for (const ba of pr.boundary_atoms) {
      if (!curAtomIds.has(ba)) {
        issues.push({
          path: `black_box_regions(frozen ${pr.id}).boundary_atoms`,
          message: `freeze violation: committed boundary atom ${ba} was deleted (later rounds may only ADD interior, never drop a committed boundary atom)`,
        });
      }
    }
    const cur = curRegions.get(pr.id);
    if (!cur) {
      issues.push({
        path: `black_box_regions(frozen ${pr.id})`,
        message: `freeze violation: committed region ${pr.id} was removed (a committed region persists)`,
      });
      continue;
    }
    const curBoundary = new Set(cur.boundary_atoms);
    for (const ba of pr.boundary_atoms) {
      if (!curBoundary.has(ba)) {
        issues.push({
          path: `black_box_regions(frozen ${pr.id}).boundary_atoms`,
          message: `freeze violation: committed boundary atom ${ba} was dropped from region ${pr.id} (boundary is monotonic)`,
        });
      }
    }
    const curPortKeys = new Set(cur.ports.map((p) => `${p.boundary_atom}:${p.order}`));
    for (const pp of pr.ports) {
      if (!curPortKeys.has(`${pp.boundary_atom}:${pp.order}`)) {
        issues.push({
          path: `black_box_regions(frozen ${pr.id}).ports`,
          message: `freeze violation: committed port ${pp.id} (boundary_atom ${pp.boundary_atom}, order ${pp.order}) was re-pointed or removed (ports are frozen once committed)`,
        });
      }
    }
  }
  return issues;
}

/**
 * Decide which `black_box_regions` to LATCH as the frozen reference for the
 * next `validate_graph` round. Only a SELF-COHERENT submission latches: a
 * region whose port has no realized crossing bond (validateBlackBoxRegions)
 * or that violates the freeze (`freezeIssues`) must NOT become the frozen
 * reference — otherwise a bad first commit traps the row, because the freeze
 * then demands the bad port be kept while realization rejects it for having no
 * crossing bond (the freeze↔realization deadlock). A coherent perimeter still
 * latches while the interior is unresolved (the round may be `ok:false` on
 * placeholders), preserving early-freeze. A rejected/omitted round keeps the
 * prior committed reference (sticky), so it changes nothing.
 */
export function latchCommittedRegions(
  prior: BlackBoxRegion[] | undefined,
  current: GraphIntent,
  freezeIssues: ValidationIssue[],
): BlackBoxRegion[] | undefined {
  const regions = current.black_box_regions;
  if (
    regions &&
    regions.length > 0 &&
    freezeIssues.length === 0 &&
    validateBlackBoxRegions(current).length === 0
  ) {
    return regions;
  }
  return prior;
}
