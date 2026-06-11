/**
 * LOCK 7 — `validate_graph` MCP tool.
 *
 * Pure stateless preflight on a draft GraphIntent.
 * NO canvas state, NO Indigo, NO Ketcher runtime mutation.
 *
 * Runs in order:
 *   1. Zod schema validation (input shape).
 *   2. Graph closure (every bond endpoint exists) — delegated to
 *      validateGraphIntent.
 *   3. Placeholder consistency invariant (LOCK 5: every
 *      confidence: 'needs_zoom' record has matching unresolved[] entry).
 *   4. Topology summary (heavy / rings / components computed from the
 *      declared atoms/bonds).
 *   5. Counts cross-check (LOCK 16: declared vs computed).
 *
 * (LOCK 24 removed: the stereo:'declared' requirement on wedge_from atoms
 * was a validate-only flag the build path never read. Removed 2026-05-31.)
 *
 * Pagination (LOCK 25): if total payload > 40KB, returns
 * { ok: false, diagnostic_overflow: true, first_n_diagnostics, total_count }.
 * Overflow does NOT count toward the agent's 3-round budget (LOCK 2).
 *
 * Error partition (LOCK 25):
 *   - agent_input_error: schema fail, closure violation, unknown
 *     shorthand, placeholder consistency violation, coord variance fail,
 *     aromatic mixed encoding, count mismatch — count
 *     toward the 3-round budget.
 *   - backend_internal_error: shorthand table lookup failure (not
 *     user-fault). Tool retries up to 2x silently; on 3rd error returns
 *     fatal_backend → agent refuses with `backend_unavailable`.
 */

import { z } from 'zod';
import {
  graphIntentSchema,
  readCountValue,
  type GraphIntent,
} from '../../types/graph-intent';
import {
  validateGraphIntent,
  checkBlackBoxFreeze,
  latchCommittedRegions,
  type ValidationIssue,
} from '../../adapter/graph-intent/validator';
import {
  findUnknownShorthand,
  findRedundantShorthandResolution,
  findInvalidShorthandExpansion,
} from '../../adapter/graph-intent/shorthand-expand';
import { decomposeShorthand } from '../../adapter/visual-graph/shorthand-table';
import { isDenseCandidate } from '../../adapter/graph-intent/dense-signal';
import { buildStereoAdvisory } from '../../adapter/graph-intent/stereo-advisory';
import { checkRingCoherence } from '../../adapter/graph-intent/ring-coherence';
import { checkBondLengthOutliers } from '../../adapter/graph-intent/bond-length-outlier';
import type { ToolDefinition } from './types';
import {
  samplePatch,
  minPatchInNeighborhood,
  sampleBondLine,
  imageMetadata,
  detectUnexplainedInkRegions,
  type ImageMetadata,
  type DeclaredAtomCoord,
} from './image-grounding';
import {
  appendSessionEvent,
  readSourceImagePath,
  readUnresolvedTargets,
  resolveRowState,
  scrubAgentText,
  SCRUB_TELEMETRY_ENABLED,
  stableHash,
  writeSourceImagePath,
  writeUnresolvedTargets,
  type UnresolvedTarget,
} from './row-state';

// ── Public types ──────────────────────────────────────────────────────

export type ValidateDiagnostic = {
  severity: 'error' | 'warning';
  record_id: string; // LOCK 6 prefixed namespace
  field: string;
  code: string;
  note?: string;
};

export type ValidateUnresolved = {
  record_id: string;
  field: string;
  state: 'needs_zoom' | 'source_limited';
};

// Advisory pixels→declarations coverage region (Wave-2 Task 4C / Direction
// B). A region of ink in the source image that no declared atom explains.
// Carries a crop target so the agent can zoom the missed region. ADVISORY
// ONLY — never blocks build, never flips `ok`.
export type CoverageRegion = {
  x_center: number;
  y_center: number;
  bbox_radius: number;
  ink_density: number;
};

export type ValidateResult = {
  ok: boolean;
  shape: 'graph_intent';
  diagnostics: ValidateDiagnostic[];
  unresolved_remaining: ValidateUnresolved[];
  topology_summary: {
    heavy_atoms: number;
    rings: number;
    components: number;
  };
  // Advisory bidirectional-pixel-pass output (Direction B). Empty when the
  // declared graph fully covers the source ink, or when no source image is
  // available. Present (possibly empty) only after the pixel pass runs.
  coverage_regions?: CoverageRegion[];
  diagnostic_overflow?: boolean;
  total_count?: number;
};

// ── Input shape ───────────────────────────────────────────────────────

// `rowId` and `outputDir` are accepted as optional top-level fields so the
// sidecars (T1 unresolved targets + T1b/T2 session trace) can be written to
// the correct row directory. When absent, `resolveRowState` defaults to a
// session-scoped path so production agents (which have no orchestrator to
// inject these) still get the enforcement layer.
const validateInputSchema = z.object({
  graph: graphIntentSchema,
  rowId: z.string().min(1).optional(),
  outputDir: z.string().min(1).optional(),
  sourceImagePath: z.string().optional(),
});

// shape_advisory diagnostic removed — non-actionable warning that tripped
// on every paclitaxel-class row. Auto-routing still lives in build.ts; the
// validate-side warning emission was pure noise.

// ── Diagnostic budget ─────────────────────────────────────────────────

const DIAGNOSTIC_PAYLOAD_CEILING_BYTES = 40 * 1024;

function paginate(diagnostics: ValidateDiagnostic[]): {
  truncated: ValidateDiagnostic[];
  overflow: boolean;
} {
  let bytes = 0;
  const truncated: ValidateDiagnostic[] = [];
  for (const diag of diagnostics) {
    const size = JSON.stringify(diag).length;
    if (bytes + size > DIAGNOSTIC_PAYLOAD_CEILING_BYTES) {
      return { truncated, overflow: true };
    }
    bytes += size;
    truncated.push(diag);
  }
  return { truncated, overflow: false };
}

// ── GraphIntent path ──────────────────────────────────────────────────

// Wave-2 Task 3 — `validateGraphIntent` (the build-path enforcer) is the
// SINGLE SOURCE OF TRUTH for structural invariants. `validate_graph`
// delegates its structural verdict to it and maps the
// `{ path, message }` issues onto this tool's `{ severity, record_id,
// field, code, note }` diagnostic shape so the agent-facing contract is
// unchanged.
//
// The two layers split responsibility deliberately:
//   - validateGraphIntent owns: duplicate atom/bond ids, self-loops,
//     unknown bond/ring atom ids, wedge_from-must-be-endpoint, wedge-on-
//     non-single, ring-walk closed-cycle (V12), carbon valence (V11),
//     heteroatom totals, drawn_H_atoms (V6), degree_sequence (V7), and the
//     coord-pin cluster checks (V1/V2/V4/V5/V8).
//   - validate_graph keeps the PREFLIGHT-only affordances that exist so the
//     validate→zoom loop can iterate: LOCK-5 (needs_zoom↔unresolved), the
//     soft counts.heavy/counts.rings handling (needs_zoom advisory + ±1
//     warning — the build path is exact/fail-closed instead), the
//     components cross-check, and the Layer-5 pixel-grounding pass.
//     (LOCK-24 stereo:'declared' check removed 2026-05-31 — build-ignored.)
//
// counts.heavy / counts.rings issues from validateGraphIntent are filtered
// out during mapping precisely because validate_graph retains its own,
// looser count semantics below; importing the enforcer's exact-match
// verdict here would collapse the deliberate preflight/enforcer split.

/** Map one validateGraphIntent issue onto a validate_graph diagnostic. */
function mapValidatorIssue(issue: ValidationIssue): ValidateDiagnostic {
  const { path, message } = issue;

  // Extract a numeric atom id from an `atoms[id=N]` path for record_id.
  const atomIdMatch = path.match(/^atoms\[id=(\d+)\]/);
  // Extract a bond index from a `bonds[N]...` path.
  const bondIdxMatch = path.match(/^bonds\[(\d+)\]/);
  // Extract a ring index from a `rings[N]...` path.
  const ringIdxMatch = path.match(/^rings\[(\d+)\]/);

  // Code is derived from the invariant the message describes. These codes
  // are the stable agent-facing surface; the validator's free-form message
  // is forwarded verbatim as `note`.
  let code = 'schema_invalid';
  let record_id = path || '(root)';
  let field = path || '(root)';

  if (/duplicate atom id/.test(message)) {
    code = 'duplicate_atom_id';
    record_id = atomIdMatch ? `atom:${atomIdMatch[1]}` : path;
    field = 'id';
  } else if (/self-loop/.test(message)) {
    code = 'self_loop_bond';
    record_id = bondIdxMatch ? `bond:${bondIdxMatch[1]}` : path;
    field = 'a';
  } else if (/duplicate bond/.test(message)) {
    code = 'duplicate_bond';
    record_id = bondIdxMatch ? `bond:${bondIdxMatch[1]}` : path;
    field = '(bond)';
  } else if (/unknown atom id/.test(message) && bondIdxMatch) {
    code = 'bond_endpoint_missing';
    record_id = `bond:${bondIdxMatch[1]}`;
    field = path.endsWith('.b') ? 'b' : 'a';
  } else if (/unknown atom id/.test(message) && ringIdxMatch) {
    code = 'ring_atom_missing';
    record_id = `ring:${ringIdxMatch[1]}`;
    field = 'atoms';
  } else if (/duplicate ring id/.test(message)) {
    code = 'duplicate_ring_id';
    record_id = ringIdxMatch ? `ring:${ringIdxMatch[1]}` : path;
    field = 'id';
  } else if (/no closed cycle/.test(message) || /\(V12\)/.test(message)) {
    code = 'ring_size_walk_mismatch';
    // Use the ring's string id from the message (`ring <id> declares …`)
    // so the agent-facing record_id stays `ring:<ring.id>` exactly as the
    // pre-delegation implementation emitted it.
    const ringIdMatch = message.match(/ring (\S+) declares/);
    record_id = ringIdMatch ? `ring:${ringIdMatch[1]}` : path;
    field = 'atoms';
  } else if (/wedge only valid on single/.test(message)) {
    code = 'wedge_on_non_single_bond';
    record_id = bondIdxMatch ? `bond:${bondIdxMatch[1]}` : path;
    field = 'wedge';
  } else if (/wedge_from required/.test(message)) {
    code = 'wedge_from_required';
    record_id = bondIdxMatch ? `bond:${bondIdxMatch[1]}` : path;
    field = 'wedge_from';
  } else if (/wedge_from must equal/.test(message) || /wedge_from must be null/.test(message)) {
    code = 'wedge_from_not_endpoint';
    record_id = bondIdxMatch ? `bond:${bondIdxMatch[1]}` : path;
    field = 'wedge_from';
  } else if (/supported carbon valence 4 \(V11\)/.test(message)) {
    code = 'impossible_carbon_valence';
    record_id = atomIdMatch ? `atom:${atomIdMatch[1]}` : path;
    field = 'element';
  } else if (/\(V1\)/.test(message)) {
    code = 'partial_coords';
    record_id = atomIdMatch ? `atom:${atomIdMatch[1]}` : path;
    field = 'x';
  } else if (/\(V2\)/.test(message) || /\(V8\)/.test(message) || /\(V4\)/.test(message)) {
    code = 'chiral_cluster_missing_coords';
    record_id = bondIdxMatch
      ? `bond:${bondIdxMatch[1]}`
      : atomIdMatch
      ? `atom:${atomIdMatch[1]}`
      : path;
    field = 'wedge';
  } else if (/\(V5\)/.test(message) || /\(V3\)/.test(message)) {
    code = 'bond_geom_invalid';
    record_id = bondIdxMatch ? `bond:${bondIdxMatch[1]}` : path;
    field = 'geom';
  } else if (/^counts\.heteroatoms/.test(path)) {
    code = 'count_mismatch';
    record_id = '(root)';
    field = path;
  } else if (/\(V6\)/.test(message)) {
    code = 'drawn_H_atoms_mismatch';
    record_id = '(root)';
    field = 'counts.drawn_H_atoms';
  } else if (/\(V7\)/.test(message)) {
    code = 'degree_sequence_mismatch';
    record_id = '(root)';
    field = 'counts.degree_sequence';
  }

  return { severity: 'error', record_id, field, code, note: message };
}

function validateDirectGraphIntent(graph: GraphIntent): ValidateResult {
  const diagnostics: ValidateDiagnostic[] = [];
  const unresolved_remaining: ValidateUnresolved[] = [];

  // Delegate the structural verdict to the single-source enforcer. Skip its
  // counts.heavy / counts.rings issues — validate_graph keeps its own
  // looser, preflight-loop count semantics (see the block comment above and
  // the soft counts handling further down).
  const structural = validateGraphIntent(graph);
  if (!structural.valid) {
    for (const issue of structural.errors) {
      if (issue.path === 'counts.heavy' || issue.path === 'counts.rings') {
        continue;
      }
      diagnostics.push(mapValidatorIssue(issue));
    }
  }

  // Task 5F — shorthand-glyph preflight. Each atom carrying a `shorthand`
  // glyph token is decomposed by the backend (deterministic table) at build
  // time; a token the table cannot resolve (not an entry, not an isotope, not
  // a bare element) is surfaced here as an `unknown_shorthand` error so the
  // validate→zoom loop can route the agent back to the glyph. Known
  // shorthands validate clean (no diagnostic). The build path fails closed on
  // the same condition (translator schema_invalid) before any canvas
  // mutation. Restores the worksheet-era 2A.1 INTENT for the one direct shape.
  for (const u of findUnknownShorthand(graph)) {
    diagnostics.push({
      severity: 'error',
      record_id: `atom:${u.atomId}`,
      field: 'shorthand',
      code: 'unknown_shorthand',
      note: `shorthand '${u.text}' is not in the decomposition table, not an isotope, and not a bare element symbol; zoom the glyph and re-emit explicit atoms or refuse`,
    });
  }

  // ADR-0002 (W1) — table-collision rule. A `shorthand_resolution` declares the
  // expansion for a glyph the table LACKS; declaring one for a glyph the table
  // ALREADY covers is redundant (the table wins — one source per glyph). This is
  // the semantic half of the provenance schema (the pure-structural rules —
  // legend_ref presence, must-co-occur-with-`shorthand` — are in
  // intentAtomSchema's superRefine). Surfaced as an error so the agent drops the
  // redundant resolution and lets the table own the glyph.
  for (const r of findRedundantShorthandResolution(graph)) {
    diagnostics.push({
      severity: 'error',
      record_id: `atom:${r.atomId}`,
      field: 'shorthand_resolution',
      code: 'shorthand_resolution_redundant',
      note: `shorthand '${r.text}' is already in the deterministic decomposition table; drop shorthand_resolution and let the table expand it (one source per glyph)`,
    });
  }

  // ADR-0002 (W2a) — referential-integrity of a declared expansion. A declared
  // `shorthand_resolution.expansion` for an OFF-table glyph splices through the
  // same path the table entries take, so its internal cross-references must be
  // sound: every bond endpoint and the attachment offset must index a real atom
  // in the expansion. The W1 schema constrains element/order/non-negativity; it
  // cannot check these cross-references. Surfaced as an error so the agent fixes
  // the declared expansion before it ever reaches the splice (which also guards
  // defensively). Chemistry correctness is Ketcher's job at build, not here.
  for (const e of findInvalidShorthandExpansion(graph)) {
    diagnostics.push({
      severity: 'error',
      record_id: `atom:${e.atomId}`,
      field: 'shorthand_resolution',
      code: 'shorthand_expansion_invalid',
      note: `declared expansion for shorthand '${e.text}' is referentially invalid: ${e.reason}`,
    });
  }

  // C6/B1 — element-glyph guard. An atom whose `element` field carries a known
  // shorthand glyph token (e.g. 'Me', 'Ph', 'OMe') instead of a real element
  // symbol passes the schema regex (^[A-Z][a-z]?$) but causes Ketcher to create
  // a '*' superatom rather than a carbon. Guard: if the element value is
  // recognised by decomposeShorthand AND the atom has no `shorthand` field set,
  // flag it as an error so the agent corrects to shorthand:'Me' or element:'C'.
  for (const atom of graph.atoms) {
    if (atom.shorthand) continue; // correctly uses shorthand field — not a bug
    const elem = atom.element;
    if (!decomposeShorthand(elem).unknown) {
      // decomposeShorthand returns {unknown:false} for table entries, isotopes,
      // and bare elements. We only flag table-shorthand entries — bare element
      // symbols and isotopes are legitimate element values.
      // Bare elements (single-atom subgraph with no isotope) via the
      // KNOWN_ELEMENT_SYMBOLS pass-through are NOT glyphs; they are valid
      // element symbols. We distinguish: a real element symbol decomposes to
      // {atoms:[{element:elem}], bonds:[], attachment_atom_offset:0}. A
      // shorthand-table glyph like 'Me' decomposes to a methyl group. The
      // tell: if the decomposed atom[0].element !== elem, it's a glyph.
      const result = decomposeShorthand(elem);
      if (!result.unknown && (result.atoms.length !== 1 || result.atoms[0].element !== elem)) {
        diagnostics.push({
          severity: 'error',
          record_id: `atom:${atom.id}`,
          field: 'element',
          code: 'element_is_shorthand_glyph',
          note: `element '${elem}' is a shorthand glyph, not an element — use shorthand:'${elem}', or element:'C' for a lone methyl`,
        });
      }
    }
  }

  // LOCK 5: placeholder consistency. Every confidence:needs_zoom record
  // must match an unresolved[] entry.
  const unresolvedIndex = new Map<string, NonNullable<GraphIntent['unresolved']>[number]>();
  for (const u of graph.unresolved ?? []) {
    unresolvedIndex.set(`${u.field}::${u.record_id}`, u);
  }

  for (const atom of graph.atoms) {
    const checks: Array<['drawn_H' | 'charge' | 'radical', 'high' | 'needs_zoom' | undefined]> = [
      ['drawn_H', atom.drawn_H_confidence],
      ['charge', atom.charge_confidence],
      ['radical', atom.radical_confidence],
    ];
    for (const [field, conf] of checks) {
      if (conf === 'needs_zoom') {
        const key = `${field}::atom:${atom.id}`;
        if (!unresolvedIndex.has(key)) {
          diagnostics.push({
            severity: 'error',
            record_id: `atom:${atom.id}`,
            field,
            code: 'unresolved_consistency_violation',
            note: `${field}_confidence is needs_zoom but no matching unresolved[] entry`,
          });
        }
      }
    }
  }

  for (const u of graph.unresolved ?? []) {
    unresolved_remaining.push({
      record_id: u.record_id.startsWith('atom:') || u.record_id.startsWith('bond:')
        ? u.record_id
        : `atom:${u.record_id}`,
      field: u.field,
      state: u.state,
    });
  }

  // LOCK 24 removed: `stereo:'declared'` was a validate-only flag the build path
  // never read (the translator derives the stereocenter from wedge_from directly).
  // Requiring it was pure agent burden with no effect on the exported answer.

  // LOCK 16: counts cross-check. Compare declared vs computed counts. A
  // shorthand atom (Task 5F) counts as ONE visible node here — the agent
  // declares counts of what it sees, and the backend recomputes the expanded
  // counts during pre-expansion. So `computedHeavy` (atoms.length) and the
  // agent's declared `counts.heavy` both treat each shorthand glyph as 1.
  const computedHeavy = graph.atoms.length;
  const computedRings = graph.rings.length;
  const adjacency = new Map<number, Set<number>>();
  for (const atom of graph.atoms) adjacency.set(atom.id, new Set());
  for (const bond of graph.bonds) {
    adjacency.get(bond.a)?.add(bond.b);
    adjacency.get(bond.b)?.add(bond.a);
  }
  const visited = new Set<number>();
  let computedComponents = 0;
  for (const atom of graph.atoms) {
    if (visited.has(atom.id)) continue;
    computedComponents++;
    const stack = [atom.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const n of adjacency.get(id) ?? []) {
        if (!visited.has(n)) stack.push(n);
      }
    }
  }

  // Task E — counts.heavy / counts.rings now accept { value, confidence }
  // OR a bare number (back-compat). When confidence === 'needs_zoom' the
  // mismatch check is replaced by a soft count_uncertain advisory and
  // the count is added to unresolved_remaining so the validate loop
  // knows to keep iterating. Build-time enforcement happens separately
  // in validateGraphIntent (translator path).
  const heavyDeclared = readCountValue(graph.counts.heavy);
  if (heavyDeclared.isNeedsZoom) {
    diagnostics.push({
      severity: 'warning',
      record_id: 'counts.heavy',
      field: 'value',
      code: 'count_uncertain',
      note: `declared heavy=${heavyDeclared.value} marked needs_zoom; resolve before build`,
    });
    unresolved_remaining.push({
      record_id: 'counts.heavy',
      field: 'value',
      state: 'needs_zoom',
    });
  } else if (Math.abs(heavyDeclared.value - computedHeavy) >= 2) {
    diagnostics.push({
      severity: 'error',
      record_id: '(root)',
      field: 'counts.heavy',
      code: 'count_mismatch',
      note: `declared heavy=${heavyDeclared.value} vs computed=${computedHeavy}`,
    });
  } else if (heavyDeclared.value !== computedHeavy) {
    diagnostics.push({
      severity: 'warning',
      record_id: '(root)',
      field: 'counts.heavy',
      code: 'count_mismatch_minor',
      note: `declared heavy=${heavyDeclared.value} vs computed=${computedHeavy} (±1 tolerated)`,
    });
  }

  const ringsDeclared = readCountValue(graph.counts.rings);
  if (ringsDeclared.isNeedsZoom) {
    diagnostics.push({
      severity: 'warning',
      record_id: 'counts.rings',
      field: 'value',
      code: 'count_uncertain',
      note: `declared rings=${ringsDeclared.value} marked needs_zoom; resolve before build`,
    });
    unresolved_remaining.push({
      record_id: 'counts.rings',
      field: 'value',
      state: 'needs_zoom',
    });
  } else if (ringsDeclared.value !== computedRings) {
    diagnostics.push({
      severity: 'error',
      record_id: '(root)',
      field: 'counts.rings',
      code: 'count_mismatch',
      note: `declared rings=${ringsDeclared.value} vs computed=${computedRings}`,
    });
  }
  // LOCK 14 + LOCK 16: components count cross-check. Multi-component scenes
  // (salts, counterions) must be transcribed in full and declared
  // explicitly. intentCountsSchema doesn't yet carry `components` as a
  // required field, so we only flag mismatch if the agent provided it.
  const declaredComponents = (
    graph.counts as { components?: number }
  ).components;
  if (
    declaredComponents !== undefined &&
    declaredComponents !== computedComponents
  ) {
    diagnostics.push({
      severity: 'error',
      record_id: '(root)',
      field: 'counts.components',
      code: 'count_mismatch',
      note: `declared components=${declaredComponents} vs computed=${computedComponents}`,
    });
  }

  // Ring-walk plausibility (`ring_size_walk_mismatch`) is delegated to
  // validateGraphIntent (V12) above — it is the single source for the
  // closed-cycle invariant. The mapper rewrites the V12 issue back to this
  // tool's `ring_size_walk_mismatch` code with a `ring:<ring.id>`
  // record_id, preserving the pre-delegation diagnostic shape.

  const hasErrors = diagnostics.some((d) => d.severity === 'error');

  // Task 5A — surface coarse `unsure_regions` escape boxes as advisory crop
  // targets. Each agent-drawn box becomes one coverage_regions entry so the
  // validate→crop→zoom loop can target it (the same crop-target surface the
  // bidirectional pixel pass uses). ADVISORY: this does NOT contribute to the
  // error set and does NOT flip `ok` — an otherwise-clean draft with unsure
  // boxes still validates, exactly like the pixel pass's coverage_regions.
  // The pixel-grounding pass (when a source image is present) APPENDS its own
  // detected regions to this list rather than clobbering it.
  const coverage_regions: CoverageRegion[] | undefined = graph.unsure_regions
    ? graph.unsure_regions.map((r) => ({
        x_center: r.x,
        y_center: r.y,
        bbox_radius: r.radius,
        ink_density: 0, // agent-declared box — no measured ink density.
      }))
    : undefined;

  return {
    ok: !hasErrors && unresolved_remaining.length === 0,
    shape: 'graph_intent',
    diagnostics,
    unresolved_remaining,
    topology_summary: {
      heavy_atoms: computedHeavy,
      rings: computedRings,
      components: computedComponents,
    },
    ...(coverage_regions ? { coverage_regions } : {}),
  };
}

// ── Top-level dispatch ────────────────────────────────────────────────

export function validateGraphPure(input: unknown): ValidateResult {
  const parsed = validateInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      shape: 'graph_intent',
      diagnostics: parsed.error.issues.map((issue) => ({
        severity: 'error' as const,
        record_id: issue.path.join('.') || '(root)',
        field: issue.path.join('.') || '(root)',
        code: 'schema_invalid',
        note: issue.message,
      })),
      unresolved_remaining: [],
      topology_summary: { heavy_atoms: 0, rings: 0, components: 0 },
    };
  }
  return validateDirectGraphIntent(parsed.data.graph);
}

// ── Row-state sidecar wiring (T1 + T1b + T2) ─────────────────────────

const BBOX_RADIUS_FLOOR = 50;
const BBOX_RADIUS_FACTOR = 1.5;

// Median bond stroke length, used to scale bbox_radius so the named crop
// region matches the draft's drawing scale. Tight polycyclic clusters get
// tighter windows; sparse structures get wider.
function medianBondLength(lengths: number[]): number {
  if (lengths.length === 0) return 0;
  const sorted = [...lengths].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function bondLengthsDirect(gi: GraphIntent): number[] {
  const atomById = new Map(gi.atoms.map((a) => [a.id, a]));
  const out: number[] = [];
  for (const b of gi.bonds) {
    const a1 = atomById.get(b.a);
    const a2 = atomById.get(b.b);
    if (
      a1 &&
      a2 &&
      a1.x !== undefined &&
      a1.y !== undefined &&
      a2.x !== undefined &&
      a2.y !== undefined
    ) {
      out.push(Math.hypot(a2.x - a1.x, a2.y - a1.y));
    }
  }
  return out;
}

function computeBboxRadius(bondLengths: number[]): number {
  const median = medianBondLength(bondLengths);
  if (median <= 0) return BBOX_RADIUS_FLOOR;
  return Math.max(BBOX_RADIUS_FLOOR, BBOX_RADIUS_FACTOR * median);
}

function extractTargets(
  args: z.infer<typeof validateInputSchema>,
  result: ValidateResult,
): UnresolvedTarget[] {
  const round = 0; // populated by caller
  const gi = args.graph;

  const atomById = new Map(gi.atoms.map((a) => [a.id, a]));
  const bboxRadius = computeBboxRadius(bondLengthsDirect(gi));
  const out: UnresolvedTarget[] = [];
  for (const u of result.unresolved_remaining) {
    let x = Number.NaN;
    let y = Number.NaN;
    if (u.record_id.startsWith('atom:')) {
      const id = Number.parseInt(u.record_id.slice('atom:'.length), 10);
      const a = atomById.get(id);
      if (a && a.x !== undefined && a.y !== undefined) {
        x = a.x;
        y = a.y;
      }
    } else if (u.record_id.startsWith('bond:')) {
      const idx = Number.parseInt(u.record_id.slice('bond:'.length), 10);
      const b = gi.bonds[idx];
      if (b) {
        const a1 = atomById.get(b.a);
        const a2 = atomById.get(b.b);
        if (
          a1 &&
          a2 &&
          a1.x !== undefined &&
          a1.y !== undefined &&
          a2.x !== undefined &&
          a2.y !== undefined
        ) {
          x = (a1.x + a2.x) / 2;
          y = (a1.y + a2.y) / 2;
        }
      }
    }
    out.push({
      record_id: u.record_id,
      field: u.field,
      x_center: x,
      y_center: y,
      bbox_radius: bboxRadius,
      round,
    });
  }
  return out;
}

// ── Layer 5 pixel-grounding pass ──────────────────────────────────────

async function runPixelGroundingPass(
  sourcePath: string,
  parsed: z.infer<typeof validateInputSchema>,
  result: ValidateResult,
): Promise<void> {
  if (!sourcePath) return;
  let meta: ImageMetadata;
  try {
    meta = await imageMetadata(sourcePath);
  } catch {
    return; // sharp/file failure — pass is best-effort.
  }

  // Project the direct GraphIntent to (atoms, bonds) for the pixel pass.
  const gi = parsed.graph;
  type PgAtom = {
    id: number | string;
    x?: number;
    y?: number;
    confidence?: string;
    isGlyph: boolean;
  };
  type PgBond = { a: number | string; b: number | string };
  const atoms: PgAtom[] = (gi.atoms ?? []).map((a) => ({
    id: a.id,
    x: a.x,
    y: a.y,
    confidence: (a as { confidence?: string }).confidence,
    isGlyph: false,
  }));
  const bonds: PgBond[] = (gi.bonds ?? []).map((b) => ({ a: b.a, b: b.b }));

  // Coord-bounds gate.
  let coordsOk = true;
  for (const a of atoms) {
    if (typeof a.x !== 'number' || typeof a.y !== 'number') continue;
    if (
      a.x < -5 ||
      a.x > meta.width + 5 ||
      a.y < -5 ||
      a.y > meta.height + 5
    ) {
      result.diagnostics.push({
        severity: 'error',
        record_id: `atom:${a.id}`,
        field: 'x',
        code: 'declared_coords_out_of_image_bounds',
        note: `atom ${a.id} at (${a.x}, ${a.y}); source image is ${meta.width}x${meta.height}`,
      });
      coordsOk = false;
    }
  }

  // P1 — vertex_not_visible_at_coord.
  if (coordsOk) {
    for (const a of atoms) {
      if (a.isGlyph) continue;
      if (typeof a.x !== 'number' || typeof a.y !== 'number') continue;
      // Read the agent's declared coord with the 5px center patch, then —
      // only when that center reads white — widen to a ~12px neighborhood
      // before declaring the vertex not-visible. A by-eye coord routinely
      // lands a few px off the drawn ink; if a stroke sits nearby the vertex
      // IS visible, so suppress the diagnostic. This NEVER rewrites the
      // agent's declared coord; it only softens the not-visible VERDICT.
      const mean = await samplePatch(sourcePath, a.x, a.y, 5);
      if (mean > 0.95) {
        const neighborhoodMin = await minPatchInNeighborhood(
          sourcePath,
          a.x,
          a.y,
          12,
        );
        if (neighborhoodMin > 0.95) {
          result.diagnostics.push({
            // WARNING, not error: this pass runs after result.ok is computed
            // (validate.ts ~:494) and never recomputes ok, so it does not
            // block build. An 'error' label here lied about its authority and
            // scared agents off buildable graphs (A009, §5.5). It is a nudge.
            severity: 'warning',
            record_id: `atom:${a.id}`,
            field: 'x',
            code: 'vertex_not_visible_at_coord',
            note: `declared atom ${a.id} at (${a.x}, ${a.y}) — no ink found at or near this coord. Your declared coord may be off the drawn ink — nudge it onto the nearest stroke, or ignore this if you can see the vertex in the image.`,
          });
        }
      }
    }
  }

  // P2 — bond_line_not_drawn.
  if (coordsOk) {
    const atomById = new Map<number | string, PgAtom>();
    for (const a of atoms) atomById.set(a.id, a);
    for (const b of bonds) {
      const aA = atomById.get(b.a);
      const aB = atomById.get(b.b);
      if (!aA || !aB) continue;
      if (aA.isGlyph || aB.isGlyph) continue;
      if (
        typeof aA.x !== 'number' ||
        typeof aA.y !== 'number' ||
        typeof aB.x !== 'number' ||
        typeof aB.y !== 'number'
      )
        continue;
      const whiteFrac = await sampleBondLine(
        sourcePath,
        aA.x,
        aA.y,
        aB.x,
        aB.y,
        10,
      );
      if (whiteFrac > 0.7) {
        result.diagnostics.push({
          // WARNING, not error: same authority as P1 — this pass cannot flip
          // ok (computed at ~:494 before the pass runs). A nudge, not a gate.
          severity: 'warning',
          record_id: `bond:${b.a}-${b.b}`,
          field: 'line',
          code: 'bond_line_not_drawn',
          note: `declared bond ${b.a}-${b.b} traverses mostly white pixels — one or both endpoint coords may be off the drawn ink. Nudge the endpoints onto the nearest strokes, or ignore this if you can see the bond in the image.`,
        });
      }
    }
  }

  // P3 — over_deferred_draft.
  const needsZoom = atoms.filter((a) => a.confidence === 'needs_zoom').length;
  if (atoms.length > 0 && needsZoom / atoms.length > 0.5) {
    result.diagnostics.push({
      severity: 'error',
      record_id: 'graph',
      field: 'atoms',
      code: 'over_deferred_draft',
      note: `${needsZoom}/${atoms.length} declared atoms are needs_zoom; transcribe what you can see before deferring`,
    });
  }

  // P4 removed — ink-blob counter false-positives on fused polycycles
  // (one connected dark blob vs declared heavy ~25). Helper
  // countConnectedComponents is kept for future re-use.

  // ── Direction B (Task 4C): pixels → declarations coverage ──────────
  // Folds the FP=0-gated detectUnexplainedInkRegions into the same pass.
  // Both directions compare against the IMAGE — never declaration ↔
  // declaration (the v1 dense-machine trap). The output is ADVISORY:
  // coverage_regions + crop targets so the agent can zoom unexplained
  // ink. It NEVER blocks build and NEVER flips result.ok.
  //
  // Only runs when declared coords are in-bounds (out-of-bounds coords are
  // already flagged by the coord-bounds gate above; running the grid
  // detector against a mis-registered coordinate frame would emit noise).
  if (coordsOk) {
    const declaredCoords: DeclaredAtomCoord[] = [];
    for (const a of atoms) {
      if (a.isGlyph) continue; // glyph labels are not structural vertices
      if (typeof a.x !== 'number' || typeof a.y !== 'number') continue;
      declaredCoords.push({ id: a.id, x: a.x, y: a.y });
    }
    try {
      const unexplained = await detectUnexplainedInkRegions(
        sourcePath,
        declaredCoords,
      );
      // APPEND, never clobber: validateDirectGraphIntent may have already
      // populated coverage_regions from the agent's coarse `unsure_regions`
      // boxes (Task 5A). The detected ink regions add to those.
      const detected = unexplained.map((r) => ({
        x_center: r.x_center,
        y_center: r.y_center,
        bbox_radius: r.bbox_radius,
        ink_density: r.ink_density,
      }));
      result.coverage_regions = [
        ...(result.coverage_regions ?? []),
        ...detected,
      ];
    } catch {
      // Advisory pass — a sharp/file failure must never fail validation.
      // Preserve any agent-declared unsure boxes already present.
      result.coverage_regions = result.coverage_regions ?? [];
    }
  } else {
    // Coord-bounds gate failed: keep any agent-declared unsure boxes; do not
    // run the grid detector against a mis-registered coordinate frame.
    result.coverage_regions = result.coverage_regions ?? [];
  }
}

// ── MCP tool definition ───────────────────────────────────────────────

export const validateTools: ToolDefinition[] = [
  {
    name: 'validate_graph',
    description:
      'Pure stateless preflight on a draft GraphIntent. ' +
      'NO canvas state, NO Indigo, NO Ketcher mutation. Returns {ok, diagnostics, unresolved_remaining, topology_summary}. ' +
      'Diagnostics paginated when payload exceeds the response limit. ' +
      'Example: { "graph": { "version": 1, "atoms": [{"id":1,"element":"C","drawn_H":null,"charge":0,"radical":0,"ring":null},{"id":2,"element":"O","drawn_H":null,"charge":0,"radical":0,"ring":null}], "bonds": [{"a":1,"b":2,"order":1,"wedge":null,"wedge_from":null}], "rings": [], "counts": {"heavy":2,"rings":0,"heteroatoms":{"O":1}} } }',
    inputSchema: {
      type: 'object',
      properties: {
        graph: { type: 'object' },
        // Optional row-state anchors. The zod inputValidator already accepts
        // these (see validateInputSchema); advertise them so an MCP client
        // that enforces additionalProperties:false lets the orchestrator pin
        // validate_graph and build_from_graph to the SAME row dir — required
        // for the build-after-validate gate and the per-row GraphIntent dump.
        rowId: { type: 'string' },
        outputDir: { type: 'string' },
        sourceImagePath: { type: 'string' },
      },
      required: ['graph'],
      additionalProperties: false,
    },
    inputValidator: validateInputSchema,
    run: async (_runtime, args) => {
      const parsed = args as z.infer<typeof validateInputSchema>;
      const result = validateGraphPure({ graph: parsed.graph });

      // Ring-coherence pre-build checks (C1 + C3). WARNING only — NEVER flips ok.
      // C1: Euler scalar one-sided (rings.length < bondCyclomatic → under-declared).
      // C3: fusion continuity >=2 (pair sharing <2 atoms but >=2 inter-ring bonds).
      // C2/V12 "ring-walk plausibility" already exists in validator.ts:233-245
      // as a hard ERROR — not reimplemented here.
      // Placed here (right after validateGraphPure, before the M0 block) so it
      // survives the scrub + paginate passes, matching the M0 sibling's placement.
      // Defensive: malformed graph (missing arrays) treated as empty → 0 findings.
      {
        const coherenceFindings = checkRingCoherence({
          atoms: parsed.graph.atoms ?? [],
          bonds: (parsed.graph.bonds ?? []).map((b) => ({ a: b.a, b: b.b })),
          rings: (parsed.graph.rings ?? []).map((r) => ({ id: r.id, atoms: r.atoms })),
        });
        for (const finding of coherenceFindings) {
          result.diagnostics.push({
            severity: 'warning',
            record_id: 'rings',
            field: 'coherence',
            code: 'ring_incoherent',
            note: finding.note,
          });
        }
        // ring_incoherent is a WARNING and MUST NOT flip result.ok.
      }

      // Bond-length-outlier pre-build advisory (connectivity analog of
      // ring_incoherent, for the "merged-path" mis-wire class). WARNING only —
      // NEVER flips ok. Flags a bond whose drawn length (from the agent's seed
      // coords) is a large outlier vs the in-frame median (> 2.5×, FP=0 over the
      // 4 committed fixtures; worst correct ratio 2.08×) → "did you skip atoms
      // on this line?". Pass atoms WITH coords (do NOT strip to {id}); coordless
      // / one-sided bonds are not measured. Defensive: malformed graph treated
      // as empty → 0 findings.
      {
        const lengthFindings = checkBondLengthOutliers({
          atoms: parsed.graph.atoms ?? [],
          bonds: (parsed.graph.bonds ?? []).map((b) => ({ a: b.a, b: b.b })),
        });
        for (const finding of lengthFindings) {
          result.diagnostics.push({
            severity: 'warning',
            record_id: 'bonds',
            field: 'geometry',
            code: 'bond_length_outlier',
            note: finding.note,
          });
        }
        // bond_length_outlier is a WARNING and MUST NOT flip result.ok.
      }

      // M0 — backend-proposed coupling trigger. (W5 ordering) Pushed FIRST so
      // the dense-core protocol leads the diagnostics list on the FIRST
      // validate round and precedes the direct-crop spend (pixel-pass
      // coverage_regions below) — dense rows then commit per-ring ports before
      // exhausting crop budget. On a dense draft (heavy >= 18 — the
      // declaration-independent prior, so a mis-transcribed disjoint-ring
      // fused core still triggers) with no black_box_region declared yet,
      // surface the protocol's first step as the expected next action
      // (WARNING, never flips ok — workflow emphasis, NOT a build gate or a
      // mandatory decomposition): commit the perimeter + fusion-bond ports,
      // then resolve each ring interior against the frozen ports.
      const m0Dense = isDenseCandidate({ atoms: parsed.graph.atoms ?? [] });
      if (
        m0Dense &&
        (!parsed.graph.black_box_regions ||
          parsed.graph.black_box_regions.length === 0)
      ) {
        result.diagnostics.push({
          severity: 'warning',
          record_id: 'graph',
          field: 'black_box_regions',
          code: 'dense_coupling_trigger',
          note: 'dense draft detected (heavy >= 18) — if this is a fused polycyclic core, the dense-core protocol applies: declare ONE black_box_region PER RING now (not one box for the whole core), each ring committed with its fusion-atom ports (the atoms it shares with adjacent rings — NOT its substituents), then resolve each ring interior against the frozen ports. This is the expected next step for a fused core; per-ring boxes pin the ring-to-ring wiring where the global-wiring drift hides. (Does not block build; refuse on a junction you genuinely cannot read.)',
        });
      }

      // T1 + T1b + T2 sidecar wiring. Production agents may omit rowId /
      // outputDir; resolveRowState falls back to a per-call dir keyed by
      // sourceImagePath (when present) or the per-process sessionUuid().
      // Resolved up-front so the pixel-grounding pass can recover a
      // persisted sourceImagePath on stateless follow-up calls (Task 4A).
      const { outputDir, rowId } = resolveRowState({
        rowId: parsed.rowId,
        outputDir: parsed.outputDir,
        sourceImagePath: parsed.sourceImagePath,
      });

      // ── Tranche-B′ black box: cross-round freeze + M0 advisory trigger ──
      // Read here (idempotent; the sidecar is re-read below for the round
      // counter) so the freeze/M0 diagnostics are pushed BEFORE the scrub +
      // paginate passes below operate on result.diagnostics.
      const blackBoxPrior = readUnresolvedTargets(outputDir);
      const freezeIssues = checkBlackBoxFreeze(
        blackBoxPrior?.committedRegions,
        parsed.graph,
      );
      for (const fi of freezeIssues) {
        result.diagnostics.push({
          severity: 'error',
          record_id: 'black_box_regions',
          field: 'freeze',
          code: 'black_box_freeze_violation',
          note: fi.message,
        });
      }
      // A freeze violation is a coherence rejection (self-contradiction with the
      // agent's OWN prior commit) → flip ok=false. This is NOT a correctness
      // detector overriding vision; it only fires when a later round mutates a
      // boundary/port the agent already committed.
      if (freezeIssues.length > 0) result.ok = false;

      // ── Dense-stereo advisory echo (option-C tail, 2026-06-01) ──
      // The PRIMARY channel is the build response (build.ts). When the prior
      // build of this row persisted a stereocenter crop worklist to the sidecar
      // (`stereoAdvisoryCenters`), re-surface it here as a WARNING so a
      // re-validate before the next build still shows the per-center to-do list.
      // Dense-gated (reusing the m0Dense gate computed above) + skip-closed when
      // the sidecar field is absent. WARNING severity only — NEVER flips ok.
      // Placed beside the freeze block (before scrub+paginate, like the
      // dense_coupling_trigger sibling) so it survives pagination.
      if (
        m0Dense &&
        blackBoxPrior?.stereoAdvisoryCenters &&
        blackBoxPrior.stereoAdvisoryCenters.length > 0
      ) {
        const advisory = buildStereoAdvisory(
          parsed.graph,
          blackBoxPrior.stereoAdvisoryCenters,
        );
        if (advisory) {
          result.diagnostics.push({
            severity: 'warning',
            record_id: advisory.record_id,
            field: advisory.field,
            code: advisory.code,
            note: advisory.note,
          });
        }
      }

      // (M0 advisory moved above, immediately after validateGraphPure, so it
      // leads the diagnostics list and surfaces on the first validate round.)

      // Task 4A — de-dormant the pixel pass. `validate_graph` is stateless,
      // so the source image path is only on the call where the agent
      // supplies it. Persist it on first sight; recover it on later calls
      // for the same row so the bidirectional pixel pass keeps running.
      let effectiveSourcePath: string | null = null;
      if (parsed.sourceImagePath) {
        writeSourceImagePath(outputDir, parsed.sourceImagePath);
        effectiveSourcePath = parsed.sourceImagePath;
      } else {
        effectiveSourcePath = readSourceImagePath(outputDir);
      }

      // Bidirectional pixel-grounding pass. Skips silently when no source
      // image path is available (validate stays usable for non-image
      // callers). Appends advisory coverage_regions + per-direction
      // diagnostics to result so the existing scrub loop routes the notes
      // through scrubAgentText too. NEVER blocks build / hard-fails.
      if (effectiveSourcePath) {
        await runPixelGroundingPass(effectiveSourcePath, parsed, result);
      }

      if (SCRUB_TELEMETRY_ENABLED()) {
        for (const d of result.diagnostics) {
          if (d.note) d.note = scrubAgentText(d.note);
        }
      }
      const { truncated, overflow } = paginate(result.diagnostics);

      const graphHash = stableHash(parsed.graph);
      const targets = extractTargets(parsed, result).map((t) => ({
        ...t,
        round: 0, // filled below after we know the round
      }));

      const prior = readUnresolvedTargets(outputDir);
      const round = (prior?.round ?? 0) + 1;
      for (const t of targets) t.round = round;

      // Dense-vision (plan 2026-05-31 §4.3): record whether this draft is a
      // dense candidate so crop_source_image can relax its gate for the
      // self-directed zoom-verify loop. Uses isDenseCandidate (size-only,
      // declaration-independent) so an under-declared draft cannot evade
      // the crop-unlock (fixes GAP-A). LATCH: once true, never re-closes
      // within a row (OR with the prior round's value — fixes GAP-B).
      // Defensive against a malformed graph.
      const denseGraph = parsed.graph as { atoms?: unknown[] } | undefined;
      const thisDenseCandidate = isDenseCandidate({
        atoms: denseGraph?.atoms ?? [],
      });
      const dense = (prior?.dense ?? false) || thisDenseCandidate;

      writeUnresolvedTargets(outputDir, {
        ok: result.ok,
        round,
        rowId,
        targets,
        dense,
        // Sticky + coherence-gated: latch the current submission's regions ONLY
        // when they are self-coherent this round (no realization error, no freeze
        // violation); otherwise KEEP the prior committed reference. This keeps the
        // freeze from trapping the row on a bad first commit (freeze demands the
        // bad port stay; realization rejects it for having no crossing → deadlock)
        // while preserving early-freeze (a coherent perimeter latches even while
        // the interior is still unresolved). See latchCommittedRegions.
        committedRegions: latchCommittedRegions(
          blackBoxPrior?.committedRegions,
          parsed.graph,
          freezeIssues,
        ),
      });
      appendSessionEvent(outputDir, {
        tool: 'validate_graph',
        rowId,
        ts: Date.now(),
        args: { graph_hash: graphHash },
        result: {
          ok: result.ok,
          graph_hash: graphHash,
          unresolved_count: result.unresolved_remaining.length,
          // Persist the full (record_id, field) list so the refusal
          // classifier can compute strict set-intersection between
          // rounds (replaces the old count-proxy escalation rule).
          unresolved_records: result.unresolved_remaining.map((t) => ({
            record_id: t.record_id,
            field: t.field,
          })),
        },
      });

      if (overflow) {
        return {
          ok: true,
          data: {
            ...result,
            diagnostics: truncated,
            diagnostic_overflow: true,
            total_count: result.diagnostics.length,
            ok: false,
          },
        };
      }
      return { ok: true, data: result };
    },
  },
];
