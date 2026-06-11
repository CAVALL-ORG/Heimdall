import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KetcherRuntime } from '../../mcp/runtime';
import type { AgentState } from '../../ui/bridge';
import {
  edgeKey,
  HALOGEN_ELEMENTS,
  isStereoLabelEntry,
  isWedgePrimitiveEntry,
  type GraphIntent,
  type IntentAtom,
  type IntentBond,
  type StereoLabelEntry,
} from '../../types/graph-intent';
import { bfsComponents, bfsOrder, type ComponentSpec } from './components';
import { computeCounts, diffCounts } from './counts';
import { isDenseDraft, hasWedgeStereo } from './dense-signal';
import {
  detectDegenerateStereoGeometry,
  type DegenerateStereoFinding,
} from './detect-degenerate-stereo';
import { BuildFromGraphError } from './errors';
import { isCarbonStereoObligation } from './stereo-obligation';
import {
  expandShorthand,
  findUnknownShorthand,
  findInvalidShorthandExpansion,
} from './shorthand-expand';
import { planRadicalReconciliation, radicalCodeFromCount } from './radical';
import { validateGraphIntent, type ValidationIssue } from './validator';
import {
  compileWedge,
  StereoTransferError,
  validateStereoTransferEntry,
  type FrozenCoords,
} from './stereo-transfer';
import {
  indigoCheckStereocenters,
  indigoComputeCIPLabels,
} from './indigo-stereo';
import { deriveIntendedCIPFromWedgePrimitive } from './mode-c-cip';
import {
  indigoPerceiveDoubleBondEZ,
  verifyDeclaredGeom,
  type GeomMismatchDiagnostic,
  type GeomVerificationRecord,
} from './ez-verify';
import { planEZCoordinateLock } from './ez-coordinate-lock';
import {
  solveStereoLabels,
  StereoCIPUnreachableError,
  type StereoLabelTarget,
} from './rs-direct-solver';
import {
  computeVisionCheckCandidate,
  type FingerprintAtom,
  type FingerprintBond,
  type VisionCheckCandidate,
} from './vision-fingerprint';
import { findUnderValentAtoms, type ValenceAtom } from './valence-sanity';
// complexity-metric module deleted 2026-05-26 — it computed routingDecision
// consumed only by the now-removed dense path. The simplified protocol has
// no tier routing; all builds run the same pipeline.
type ComplexityResult = null;
// dense-policy module deleted 2026-05-26. DenseBuildPolicy type lingers only
// as a null placeholder in the translator's output shape; runtime no longer
// stores or reads it.
type DenseBuildPolicy = unknown;

/**
 * Forensics dump (opt-in via env). Fires on both the MCP-tool path and
 * the test-daemon path because both go through `translateGraphIntent`.
 *
 * When `KETCHER_BUILD_DUMP_DIR` is set, every translator invocation
 * writes its validated GraphIntent payload + outcome (ok/error) to a
 * timestamped JSON file in that directory. When
 * `KETCHER_BUILD_DUMP_ROW_ID` is also set, that id prefixes the
 * filename so test-suite forensics can locate per-row artifacts.
 *
 * Production runtime: env is unset → no-op. Test orchestrator opts in
 * for full-suite runs where stereo / build failures need GraphIntent
 * recovery independent of the (often-compacted) transcript.
 */
function dumpGraphIntent(
  graph: unknown,
  outcome: { ok: boolean; error?: unknown },
  forensics?: TranslatorForensicsOptions,
): void {
  const dir = forensics?.buildDumpDir ?? process.env.KETCHER_BUILD_DUMP_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rowId =
      forensics?.rowId ?? process.env.KETCHER_BUILD_DUMP_ROW_ID;
    const filename = rowId ? `${rowId}-${stamp}.json` : `${stamp}.json`;
    writeFileSync(
      join(dir, filename),
      JSON.stringify({ ts: new Date().toISOString(), graph, outcome }, null, 2),
      'utf8',
    );
    // Phase 0 (image-harness-grading-correctness): ALSO write a
    // deterministic per-row file the grader's un-blinded stereo resolver can
    // find without parsing timestamps. The payload is the BARE GraphIntent
    // (FLAT — atoms/bonds at top level, NOT wrapped in { ts, graph, outcome })
    // so the resolver reads `bonds[].wedge`/`wedge_from` directly. Overwrites
    // on each build, so last-build-wins = the build that exported.
    if (rowId) {
      writeFileSync(
        join(dir, `${rowId}.graph.json`),
        JSON.stringify(graph, null, 2),
        'utf8',
      );
    }
  } catch {
    // Dump failure must never break the build path.
  }
}

/**
 * Forensics dump for the post-build vision-fingerprint (Stage A.2 of
 * PLAN-a004-class-robustness-2026-05-22). When
 * `KETCHER_FINGERPRINT_DUMP_DIR` is set, every successfully-computed
 * VisionCheckCandidate is also written to that directory as
 * `<row_id?>-<ts>.fingerprint.json`. Test-suite forensics use this to
 * recover the canonical candidate side independent of the (often
 * compacted) agent transcript. Production-runtime: env unset → no-op.
 * Mirrors `dumpGraphIntent` above.
 */
function dumpVisionFingerprint(
  fingerprint: VisionCheckCandidate,
  forensics?: TranslatorForensicsOptions,
): void {
  const dir =
    forensics?.fingerprintDumpDir ?? process.env.KETCHER_FINGERPRINT_DUMP_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rowId =
      forensics?.rowId ?? process.env.KETCHER_BUILD_DUMP_ROW_ID;
    const filename = rowId
      ? `${rowId}-${stamp}.fingerprint.json`
      : `${stamp}.fingerprint.json`;
    writeFileSync(
      join(dir, filename),
      JSON.stringify({ ts: new Date().toISOString(), fingerprint }, null, 2),
      'utf8',
    );
  } catch {
    // Dump failure must never break the build path.
  }
}

const ORGANIC_NATURAL_VALENCE = new Set([
  'B',
  'C',
  'N',
  'O',
  'P',
  'S',
  'F',
  'Cl',
  'Br',
  'I',
]);

function singleAtomSmiles(element: string): string {
  return ORGANIC_NATURAL_VALENCE.has(element) ? element : `[${element}]`;
}

function newAtomId(before: AgentState, after: AgentState): number {
  const beforeIds = new Set(before.atoms.map((a) => a.id));
  const fresh = after.atoms.filter((a) => !beforeIds.has(a.id));
  if (fresh.length !== 1) {
    throw new BuildFromGraphError('translator_failed', {
      step: 'seed_atom_id_resolution',
      message: `expected exactly one new atom after seed, observed ${fresh.length}`,
      observed: fresh.map((a) => ({ id: a.id, label: a.label })),
    });
  }
  return fresh[0].id;
}

export type TranslatorLayout = 'auto' | 'preserve' | 'clean';

/**
 * Per-call forensics overrides for `KETCHER_BUILD_DUMP_DIR` /
 * `KETCHER_FINGERPRINT_DUMP_DIR` / `KETCHER_BUILD_DUMP_ROW_ID`. When
 * present, the values take precedence over the corresponding env vars
 * — required for the test-daemon path where multiple concurrent slot
 * builds would otherwise race on shared process env. Production callers
 * (MCP server, standalone tsx) can keep relying on env vars.
 */
export type TranslatorForensicsOptions = {
  rowId?: string;
  buildDumpDir?: string;
  fingerprintDumpDir?: string;
};

export type TranslatorOptions = {
  validate_counts: boolean;
  layout: TranslatorLayout;
  forensics?: TranslatorForensicsOptions;
};

/**
 * Mode C per-center forensic record. One entry per wedge-primitive
 * stereocenter that went through the Indigo CIP perception + selective
 * V2000 solver re-apply pass.
 *
 * `intentCenter` is the agent-supplied GraphIntent atom id; `canvasCenter`
 * the corresponding Ketcher canvas atom id. `intendedRS` is the R/S label
 * derived from the agent's pixel facts (null when CIP descent refuses on
 * first-shell tie / unsupported projection / etc). `perceivedRS` is
 * Indigo's CIP perception on the post-build canvas. `reapplied` flags
 * whether the V2000 solver was asked to flip the perceived label to the
 * intended one. `skipReason` is the human-readable reason this center was
 * not re-applied (set when intendedRS is null OR when the solver bulk
 * apply failed).
 *
 * Exposed publicly so the Phase 5 P5 stereo-loss diagnostic
 * (`summarizeStereoLossDiagnostics`) can distill these records into the
 * agent-visible diagnostic surface.
 */
export type ModeCRecord = {
  intentCenter: number;
  canvasCenter: number;
  intendedRS: 'R' | 'S' | null;
  perceivedRS: 'R' | 'S' | null;
  reapplied: boolean;
  skipReason: string | null;
};

/**
 * Phase 5 Task H — P5 stereo-loss diagnostic.
 *
 * Distills the translator's Mode C per-center forensic records into
 * per-center stereo-loss diagnostics for the build-result surface. A
 * record contributes one diagnostic when the center carried stereo intent
 * (intendedRS set OR a skipReason describing the loss) AND no re-apply
 * succeeded.
 *
 * The synthetic record with `intentCenter === -1` (catch-all solver
 * failure pushed by `applyStereoLabels`'s bulk-apply error path) is
 * skipped — there is no specific center to name. The per-center records
 * that triggered the bulk failure are still present and surface
 * individually.
 *
 * Pure function — no canvas / runtime / Indigo interaction.
 */
export function summarizeStereoLossDiagnostics(
  records: ReadonlyArray<ModeCRecord>,
): Array<{ centerAtomId: number; reason: string }> {
  const out: Array<{ centerAtomId: number; reason: string }> = [];
  for (const r of records) {
    if (r.intentCenter < 0) continue; // synthetic bulk-failure marker
    if (r.reapplied) continue; // V2000 successfully re-applied; not lost
    // Loss condition: intended label is null (CIP descent refused) OR
    // intended label was set but solver could not re-apply. The skipReason
    // captures the human-readable cause when present; otherwise a label
    // disagreement that wasn't re-applied is not a loss (perceived matches
    // intended).
    const intendedDiffers =
      r.intendedRS !== null && r.perceivedRS !== r.intendedRS;
    if (r.skipReason || intendedDiffers) {
      out.push({
        centerAtomId: r.intentCenter,
        reason: r.skipReason ?? 'stereo_reapply_skipped',
      });
    }
  }
  return out;
}

/**
 * Task 1A.1 — build-time E/Z verification of declared `bond.geom` double
 * bonds. Runs at end-of-build in BOTH translator return paths (layoutPolicy
 * AND non-layoutPolicy). Exports the post-build molfile, asks Indigo to
 * perceive each double bond's actual E/Z from the pinned coordinates, and
 * compares against the declared cis/trans via the pure `verifyDeclaredGeom`
 * comparator (cis≡Z, trans≡E).
 *
 * Returns `{ records: [], diagnostics: [] }` (no-op) when:
 *   - the graph declares no `geom` bond (nothing to verify), OR
 *   - the runtime cannot export a molfile (mock runtime in unit tests), OR
 *   - Indigo perception throws (standalone mode / unreachable service).
 * The last case is SKIP-CLOSED: an Indigo outage emits NO diagnostic rather
 * than risk a false green — mirroring Mode C's perception gating.
 *
 * ADVISORY only — never mutates the canvas. The caller attaches the records
 * + diagnostics to the build result for the agent to act on.
 */
async function verifyDeclaredGeomFromCanvas(
  runtime: KetcherRuntime,
  graph: GraphIntent,
  atomIdMap: Record<number, number>,
): Promise<{
  records: GeomVerificationRecord[];
  diagnostics: GeomMismatchDiagnostic[];
}> {
  const empty: { records: GeomVerificationRecord[]; diagnostics: GeomMismatchDiagnostic[] } = {
    records: [],
    diagnostics: [],
  };
  const hasDeclaredGeom = graph.bonds.some(
    (b) => b.geom === 'cis' || b.geom === 'trans',
  );
  if (!hasDeclaredGeom) return empty;
  if (typeof runtime.exportMolfile !== 'function') return empty;

  let molfile: string | null = null;
  try {
    molfile = await runtime.exportMolfile();
  } catch {
    return empty; // export failure → skip-closed, no false flag
  }
  if (!molfile) return empty;

  let perceivedEZByMolfileEdge: Map<string, 'E' | 'Z'>;
  try {
    perceivedEZByMolfileEdge = await indigoPerceiveDoubleBondEZ(molfile);
  } catch {
    return empty; // Indigo unreachable → skip-closed
  }

  // Map canvas atom ids → molfile 1-based indices (same pattern Mode C uses:
  // the V2000 atom block order matches state.atoms order).
  const state = await runtime.getState(false);
  const canvasIdToMolfile1Based = new Map<number, number>();
  state.atoms.forEach((a, i) => canvasIdToMolfile1Based.set(a.id, i + 1));

  return verifyDeclaredGeom({
    graph,
    atomIdMap,
    canvasIdToMolfile1Based,
    perceivedEZByMolfileEdge,
  });
}

export type TranslatorResult = {
  atomIdMap: Record<number, number>;
  bondIdMap: Record<string, number>;
  state: AgentState & { ket: string | null; molfile: string | null };
  /**
   * Phase 5 Task H — per-center stereo-loss diagnostics. Populated when
   * the build path runs the Mode C selective V2000 solver re-apply
   * (layoutPolicy: 'ketcher_clean_locked' with wedge-primitive entries).
   * Each entry names a specific center whose stereo was discarded or not
   * re-applied; the agent can re-zoom that center.
   */
  stereoLossDiagnostics?: Array<{ centerAtomId: number; reason: string }>;
  /**
   * Dense-stereo advisory (2026-06-01) — intent-id-space atoms Indigo still
   * perceives as UNDEFINED stereocenters after build that the agent explicitly
   * skipped (`stereo_unknown`). Sourced from `assertNoUndefinedStereoPostBuild`
   * (the SAME molfile the build exported — no extra Indigo round). `[]` when
   * none, when Indigo is unavailable, or on a mock runtime. `build.ts` feeds
   * this to `buildStereoAdvisory` (dense-gated) to emit the per-center crop
   * worklist on the build response. WARNING-channel only; never flips `ok`.
   */
  perceivedUndefinedStereoCenters?: number[];
  /**
   * Lever A advisory (coordinate-fidelity plan 2026-06-03) — dense wedge
   * stereocenters whose two IN-PLANE neighbors are drawn near-collinear, an
   * ill-conditioned 2D frame that mis-decodes CIP from a correct wedge stroke.
   * Dense-gated; `[]` on sparse rows / no findings. `build.ts` surfaces it as
   * `data.stereoGeometryAdvisory` so the agent re-reads those in-plane bond
   * directions. WARNING-channel only; never flips `ok`, never moves a coord.
   */
  degenerateStereoFindings?: DegenerateStereoFinding[];
  /**
   * Build-time E/Z verification forensic records (Task 1A.1). One per
   * declared-`geom` double bond: the declared cis/trans, its cis→Z / trans→E
   * mapping, and Indigo's CIP E/Z perception on the post-build canvas. Empty
   * when the graph declares no `geom` bonds OR when Indigo perception could
   * not run (standalone mode / unreachable service — skip-closed, never a
   * false green). Mirrors `modeC`: exposes the raw comparison so the build
   * path's E/Z perception is unit-testable. Replaces the only real function
   * the deleted render-diff layer performed (double-bond E/Z inspection).
   */
  geomVerification?: GeomVerificationRecord[];
  /**
   * Advisory E/Z mismatch diagnostics (Task 1A.1). One entry per declared-
   * `geom` double bond whose Indigo-perceived E/Z contradicts the declared
   * cis/trans. ADVISORY only — the build commits the agent's drawn geometry
   * unchanged; the agent can re-zoom the named bond. Empty when every geom
   * bond agrees or when Indigo could not perceive (skip-closed).
   */
  geomMismatchDiagnostics?: GeomMismatchDiagnostic[];
  /**
   * Mode C per-center forensic records (additive observability surface).
   * Populated on the layoutPolicy 'ketcher_clean_locked' path with
   * wedge-primitive entries — one record per chiral center carrying the
   * intended R/S (derived from pixel facts), Indigo's perceived R/S on the
   * post-build canvas, and whether the V2000 solver re-applied. Empty when
   * no wedge-primitive entries ran the Mode C pass. The translator already
   * distils these into `stereoLossDiagnostics`; this field exposes the raw
   * records so the locked path's stereo perception is unit-testable
   * (mode-c-cip-selective-reapply.test.ts).
   */
  modeC?: ModeCRecord[];
  /**
   * System-computed VISION_CHECK candidate fingerprint (handoff-prevent-
   * rubber-stamp Step A). Pure derivation from the post-build canvas; the
   * agent reads this back and uses it verbatim as the `candidate=` side of
   * every VISION_CHECK sub-row. Optional — may be null when annotated state
   * cannot be retrieved (mock runtimes, transient bridge failure); the
   * grader (Stage 2 of PLAN-a004-class-robustness-2026-05-22) reads this
   * field from the `KETCHER_FINGERPRINT_DUMP_DIR` sidecar as its
   * authoritative candidate side.
   */
  visionFingerprint: VisionCheckCandidate | null;
  /**
   * Triage metric (Stage D of PLAN-a004-class-robustness-2026-05-22).
   * Carries K (Indigo CIP-perceived stereocenter count), C (max sphere-2
   * stereo cluster size), F (max SSSR ring-membership at any
   * stereocenter), the tier (0|1|2 from the accepted Stage A.3
   * thresholds, with cage-topology promotion), and per-stereocenter
   * classification + beyond-protocol detectors. Null when Indigo CIP
   * perception cannot run (standalone mode without remote Indigo,
   * mock runtime). Stage 5a's tier-routed SKILL.md branches on
   * `complexity.tier` from this field.
   */
  complexity: ComplexityResult | null;
  denseBuildPolicy?: DenseBuildPolicy | null;
};

type PrimaryStereoEncoding =
  | 'none'
  | 'legacy_one_shot_wedge'
  | 'wedge_primitive'
  | 'rs_label'
  | 'mixed';

function detectPrimaryStereoEncoding(graph: GraphIntent): PrimaryStereoEncoding {
  const hasLegacyWedge =
    graph.bonds.some((b) => b.wedge !== null && b.wedge_from !== null) ||
    graph.atoms.some((a) => a.wedge_to_implicit_h != null);
  const entries = graph.stereoTransfer ?? [];
  const hasWedgeEntries = entries.some((e) => isWedgePrimitiveEntry(e));
  const hasLabelEntries = entries.some((e) => isStereoLabelEntry(e));
  if (hasWedgeEntries && hasLabelEntries) return 'mixed';
  if (hasWedgeEntries) return 'wedge_primitive';
  if (hasLabelEntries) return 'rs_label';
  if (hasLegacyWedge) return 'legacy_one_shot_wedge';
  return 'none';
}

// REMOVED 2026-05-26: `assertDenseRoutingConsistency` was the literal A004
// trap — it threw `tier_routing_gate_violation` on declaredCenters.size >= 9
// with wedge-primary encoding, which forced paclitaxel (K=11) into the
// dense-session worksheet path that was structurally unable to complete.
// Mode C (selective V2000 solver re-apply on Indigo CIP disagreement, applied
// post-build inside the layout-locked path) handles K>=9 directly without
// requiring worksheet-backed observations. The agent emits wedge primitives
// on a single GraphIntent; the backend perceives CIP and re-applies via
// solver where parity-transfer disagrees. No routing gate needed.

async function applyAromaticRingIntent(
  runtime: KetcherRuntime,
  graph: GraphIntent,
  bondIdMap: Record<string, number>,
): Promise<void> {
  for (const ring of graph.rings) {
    if (ring.kind !== 'aromatic') continue;
    for (let i = 0; i < ring.atoms.length; i++) {
      const a = ring.atoms[i];
      const b = ring.atoms[(i + 1) % ring.atoms.length];
      const bondId = bondIdMap[edgeKey(a, b)];
      if (bondId === undefined) {
        throw new BuildFromGraphError('translator_failed', {
          step: 'aromatic_ring_intent',
          message: `aromatic ring ${ring.id} references non-bonded adjacent atoms ${a}-${b}`,
        });
      }
      await runtime.callBridge('setBondOrder', bondId, 4);
    }
  }
}

function hasAnyCoords(atoms: IntentAtom[]): boolean {
  return atoms.some((a) => a.x !== undefined && a.y !== undefined);
}

type StateAtomXY = { id: number; x: number; y: number };
type StateBondXY = { beginAtomId: number; endAtomId: number };

// Vector from neighbor centroid → parent, normalized to a single model
// bond length (matching the translator's coord-normalize scale of 1.5).
// Used to place the materialized H opposite the heavy-neighbor crowd so
// the wedge has a clean direction.
function computeOppositeCentroidOffset(
  parent: StateAtomXY,
  state: { atoms: StateAtomXY[]; bonds: StateBondXY[] },
): { x: number; y: number } {
  const neighborIds: number[] = [];
  for (const bond of state.bonds) {
    if (bond.beginAtomId === parent.id) neighborIds.push(bond.endAtomId);
    else if (bond.endAtomId === parent.id) neighborIds.push(bond.beginAtomId);
  }
  const neighbors = neighborIds
    .map((id) => state.atoms.find((a) => a.id === id))
    .filter((a): a is StateAtomXY => !!a);
  if (neighbors.length === 0) return { x: 1.5, y: 0 };
  const cx = neighbors.reduce((s, n) => s + n.x, 0) / neighbors.length;
  const cy = neighbors.reduce((s, n) => s + n.y, 0) / neighbors.length;
  const dx = parent.x - cx;
  const dy = parent.y - cy;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: 1.5, y: 0 };
  const scale = 1.5 / len;
  return { x: dx * scale, y: dy * scale };
}

// Mutates `atoms` in place: rescales coord-bearing atoms so the mean bond
// length is 1.5 model units, centers their centroid at (0, 0), and flips y
// (image y-down → model y-up). Atoms without coords are left untouched.
function normalizeCoords(atoms: IntentAtom[], bonds: IntentBond[]): void {
  const coordAtoms = atoms.filter((a) => a.x !== undefined && a.y !== undefined);
  if (coordAtoms.length === 0) return;
  const byId = new Map<number, IntentAtom>();
  for (const a of atoms) byId.set(a.id, a);
  const coordBonds = bonds.filter((b) => {
    const aa = byId.get(b.a);
    const bb = byId.get(b.b);
    return aa && bb && aa.x !== undefined && bb.x !== undefined;
  });
  let scale = 1;
  if (coordBonds.length > 0) {
    const dists = coordBonds.map((b) => {
      const aa = byId.get(b.a)!;
      const bb = byId.get(b.b)!;
      return Math.hypot(aa.x! - bb.x!, aa.y! - bb.y!);
    });
    const meanBond = dists.reduce((s, d) => s + d, 0) / dists.length;
    if (meanBond > 0) scale = 1.5 / meanBond;
  }
  const cx = coordAtoms.reduce((s, a) => s + a.x!, 0) / coordAtoms.length;
  const cy = coordAtoms.reduce((s, a) => s + a.y!, 0) / coordAtoms.length;
  for (const atom of coordAtoms) {
    atom.x = (atom.x! - cx) * scale;
    // Empirically Ketcher's perceiver behaves consistently when image y is
    // preserved (no flip) — wedge-coord-test Variant C used y=-1.3 for NH2
    // (above Cα in y-up convention) and Ketcher returned the L-Phe S
    // enantiomer, implying its 2D space treats smaller y as toward the top.
    // Removing the flip aligns translator output with this convention.
    atom.y = (atom.y! - cy) * scale;
  }
}

export async function translateGraphIntent(
  runtime: KetcherRuntime,
  rawGraph: unknown,
  opts: TranslatorOptions,
): Promise<TranslatorResult> {
  try {
    return await translateGraphIntentInner(runtime, rawGraph, opts);
  } catch (err) {
    if (err instanceof BuildFromGraphError) {
      dumpGraphIntent(
        rawGraph,
        {
          ok: false,
          error: { code: err.code, message: err.message, details: err.details },
        },
        opts.forensics,
      );
    } else {
      dumpGraphIntent(
        rawGraph,
        {
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        },
        opts.forensics,
      );
    }
    throw err;
  }
}

async function translateGraphIntentInner(
  runtime: KetcherRuntime,
  rawGraph: unknown,
  opts: TranslatorOptions,
): Promise<TranslatorResult> {
  // Direct GraphIntent is the one input shape. Validate the raw graph and
  // continue; there is no worksheet prestage.
  const validation = validateGraphIntent(rawGraph);
  if (!validation.valid) {
    throw new BuildFromGraphError('schema_invalid', validation.errors);
  }
  // Task 5F — shorthand-glyph pre-expansion. Runs BEFORE the skeleton build
  // (and before assertLayoutLockedValid / coord-normalize) so every
  // downstream pass — skeleton, element overrides, bond orders, aromatize,
  // drawn_H, count check — operates on the expanded heavy-atom graph. Fail
  // closed on an unknown glyph before any canvas mutation; the agent zooms
  // and re-emits explicit atoms or refuses (LOCK 11 / LOCK 21).
  const unknownShorthand = findUnknownShorthand(validation.graph);
  if (unknownShorthand.length > 0) {
    throw new BuildFromGraphError(
      'schema_invalid',
      unknownShorthand.map((u) => ({
        path: `atoms[id=${u.atomId}].shorthand`,
        message: `unknown shorthand '${u.text}' — not in the decomposition table, not an isotope, not a bare element`,
      })),
    );
  }
  // ADR-0002 (W2a) — a declared `shorthand_resolution.expansion` for an
  // off-table glyph is agent-supplied; reject a referentially-malformed one
  // (bond/attachment index out of range) before any canvas mutation, mirroring
  // the unknown-shorthand gate above. expandShorthand also guards defensively.
  const invalidExpansion = findInvalidShorthandExpansion(validation.graph);
  if (invalidExpansion.length > 0) {
    throw new BuildFromGraphError(
      'schema_invalid',
      invalidExpansion.map((e) => ({
        path: `atoms[id=${e.atomId}].shorthand_resolution.expansion`,
        message: `invalid declared expansion for shorthand '${e.text}': ${e.reason}`,
      })),
    );
  }
  const graph = expandShorthand(validation.graph);
  if (graph.layoutPolicy === 'ketcher_clean_locked') {
    assertLayoutLockedValid(graph);
  }
  const coordsPresent = hasAnyCoords(graph.atoms);

  // Normalize coords on a defensive clone so the caller's input isn't mutated.
  const workingAtoms: IntentAtom[] = graph.atoms.map((a) => ({ ...a }));
  if (coordsPresent) {
    normalizeCoords(workingAtoms, graph.bonds);
  }
  const workingAtomById = new Map<number, IntentAtom>(workingAtoms.map((a) => [a.id, a]));

  const atomIdMap: Record<number, number> = {};
  const bondIdMap: Record<string, number> = {};

  for (const comp of bfsComponents(graph)) {
    await buildSkeletonPerAtom(runtime, graph, comp, atomIdMap, bondIdMap);
  }

  for (const atom of graph.atoms) {
    if (atom.element !== 'C') {
      await runtime.callBridge('setAtomElement', atomIdMap[atom.id], atom.element);
    }
  }

  // LOCK 23 — isotope (nuclear mass number) pass. Runs after the element
  // override so the atom already carries its final label before the mass
  // prefix is applied. `isotope` is a first-class Ketcher Atom attribute
  // (Atom.attrlist includes 'isotope') emitted by the SMILES writer as the
  // bracket-atom mass prefix ([13C], [15N], [2H], …). Optional + absent ⇒
  // natural abundance, so only fire when the agent declared a value.
  for (const atom of graph.atoms) {
    if (atom.isotope !== undefined) {
      await runtime.callBridge('setAtomIsotope', atomIdMap[atom.id], atom.isotope);
    }
  }

  for (const bond of graph.bonds) {
    if (bond.order > 1) {
      const bondId = bondIdMap[edgeKey(bond.a, bond.b)];
      await runtime.callBridge('setBondOrder', bondId, bond.order);
    }
  }

  await applyAromaticRingIntent(runtime, graph, bondIdMap);
  await runtime.callBridge('aromatize');

  for (const atom of graph.atoms) {
    if (atom.drawn_H !== null) {
      await runtime.callBridge('setAtomImplicitHCount', atomIdMap[atom.id], atom.drawn_H);
    }
  }

  for (const atom of graph.atoms) {
    if (atom.charge !== 0) {
      await runtime.callBridge('setAtomCharge', atomIdMap[atom.id], atom.charge);
    }
  }

  for (const atom of graph.atoms) {
    if (atom.radical !== 0) {
      await runtime.callBridge(
        'setAtomRadical',
        atomIdMap[atom.id],
        radicalCodeFromCount(atom.radical),
      );
    }
  }

  // layoutPolicy "ketcher_clean_locked" (v3 doc §8): the flat skeleton is now
  // built; hand off to the parity-transfer pipeline — clean + global layout,
  // freeze coords, compile + apply wedges, integrity-assert. No coord pin, no
  // bond.wedge / wedge_to_implicit_h passes run in this mode.
  if (graph.layoutPolicy === 'ketcher_clean_locked') {
    let state = await applyLayoutLockedStereo(runtime, graph, atomIdMap, opts);
    // LOCK 23 enhanced/relative stereo group — applied AFTER the parity pass.
    // The layout-locked solver writes each committed center's stereoLabel to
    // "abs"; the enhanced-stereo group (`&<n>` / `or<n>`) must overwrite that
    // afterward or it is clobbered. Re-export so the returned `state` (and the
    // vision fingerprint below) reflect the |&n:…| / |or…| extended-SMILES.
    if (await applyStereoGroups(runtime, graph, atomIdMap)) {
      state = await reExportLayoutLockedState(runtime);
    }
    const visionFingerprint = await computeFingerprintFromCanvas(
      runtime,
      graph,
      atomIdMap,
      state.smiles ?? null,
      opts.forensics,
    );
    // assertFingerprintTopologyMatchesLedger removed 2026-05-26 — the
    // topologyLedger/coverageCheck overlay it consumed was deleted along
    // with the dense state machine. Mode C handles K>=9 via Indigo CIP
    // perception + selective V2000 solver re-apply.
    const complexity: ComplexityResult | null = null;
    // assertDenseRoutingConsistency removed 2026-05-26 (the A004 trap).
    // Phase 5 Task H — read the Mode C per-center records that
    // applyLayoutLockedStereo smuggles onto `graph.modeC` and distill
    // them into per-center stereo-loss diagnostics. Empty when no
    // wedge-primitive entries ran the Mode C pass.
    const modeCRecords =
      ((graph as { modeC?: ModeCRecord[] }).modeC ?? []) as ModeCRecord[];
    const stereoLossDiagnostics = summarizeStereoLossDiagnostics(modeCRecords);
    // Dense-stereo advisory (2026-06-01): read back the perceived-undefined-
    // skipped set that applyLayoutLockedStereo smuggled onto `graph` (mirrors
    // the modeC read above). `[]` when applyLayoutLockedStereo did not run the
    // assert (it always does) or Indigo was unavailable.
    const perceivedUndefinedStereoCenters =
      (graph as { perceivedUndefinedStereoCenters?: number[] })
        .perceivedUndefinedStereoCenters ?? [];
    const geom = await verifyDeclaredGeomFromCanvas(runtime, graph, atomIdMap);
    await assertNoUnderValentAtoms(runtime);
    dumpGraphIntent(rawGraph, { ok: true }, opts.forensics);
    return {
      atomIdMap,
      bondIdMap,
      state,
      visionFingerprint,
      complexity,
      stereoLossDiagnostics,
      perceivedUndefinedStereoCenters,
      geomVerification: geom.records,
      geomMismatchDiagnostics: geom.diagnostics,
      modeC: modeCRecords,
      denseBuildPolicy: null,
    };
  }

  // Pin coord-bearing atoms AFTER aromatize / element / drawn_H / charge /
  // radical, but BEFORE bond.geom + wedges. The earlier passes can perturb
  // pp coordinates (aromatize re-lays out rings; element changes can shift
  // valence-driven placement). Pinning last + skipping clean() preserves
  // the pinned geometry to export_smiles time, which is what Ketcher's CIP
  // perceiver reads. Diagnostic precondition:
  // outputs/diagnostics/wedge-coord-test/results.md.
  if (coordsPresent) {
    for (const atom of workingAtoms) {
      if (atom.x !== undefined && atom.y !== undefined) {
        await runtime.callBridge('setAtomXY', atomIdMap[atom.id], atom.x, atom.y);
      }
    }
  }

  // bond.geom — coord pin above feeds Indigo's perceiver the geometry it
  // reads at export time. Per diagnostic, setBondStereo(CIS_TRANS=3) on the
  // double bond corrupts Indigo's SMILES writer (emits spurious `[C@@H]` on
  // the sp2 carbon and no `/`/`\` slashes); coords alone suffice for E/Z
  // perception. The geom field stays as agent-intent metadata for the
  // validator (V3 / V4 / V5) but is not pushed onto the bond stereo flag.

  // wedge_to_implicit_h pass: for any atom that declares a wedge to a
  // drawn-H vertex, promote one implicit H to an explicit H atom, position
  // it opposite the heavy-neighbor centroid, and apply the wedge from the
  // parent to the new H. Runs after coord pin so parent canvas positions
  // are stable; runs before the heavy-to-heavy wedge pass to keep all
  // wedge mutations contiguous.
  for (const atom of graph.atoms) {
    if (atom.wedge_to_implicit_h == null) continue;
    const parentId = atomIdMap[atom.id];
    const annotated = (await runtime.getAnnotatedState()) as {
      atoms: Array<{ id: number; x: number; y: number; implicitH: number }>;
      bonds: Array<{ beginAtomId: number; endAtomId: number }>;
    };
    const parent = annotated.atoms.find((a) => a.id === parentId);
    if (!parent) {
      throw new BuildFromGraphError('translator_failed', {
        step: 'wedge_to_implicit_h',
        message: `atom ${atom.id} (canvas id ${parentId}) not found in annotated state`,
      });
    }
    if (parent.implicitH < 1) {
      throw new BuildFromGraphError('translator_failed', {
        step: 'wedge_to_implicit_h',
        message: `atom ${atom.id} has no implicit H to promote (implicitH=${parent.implicitH})`,
      });
    }
    await runtime.callBridge('setAtomImplicitHCount', parentId, parent.implicitH - 1);
    const res = await runtime.callBridge<{ endAtomId: number }>(
      'addAtomWithSingleBond',
      parentId,
      'H',
    );
    const hid = res.endAtomId;
    const offset = computeOppositeCentroidOffset(parent, annotated);
    await runtime.callBridge('setAtomXY', hid, parent.x + offset.x, parent.y + offset.y);
    await runtime.callBridge('setWedgeBond', parentId, hid, atom.wedge_to_implicit_h);
  }

  for (const bond of graph.bonds) {
    if (bond.wedge !== null && bond.wedge_from !== null) {
      const chiral = atomIdMap[bond.wedge_from];
      const other = atomIdMap[bond.wedge_from === bond.a ? bond.b : bond.a];
      await runtime.callBridge('setWedgeBond', chiral, other, bond.wedge);
    }
  }

  // LOCK 23 enhanced/relative stereo group — applied AFTER the wedge passes
  // (which set the committed center's stereoLabel to "abs"). The
  // enhanced-stereo group (`&<n>` / `or<n>`) must overwrite that afterward; a
  // plain atom attribute, it survives the optional clean() below and lands in
  // the |&n:…| / |or…| extended-SMILES block on export.
  await applyStereoGroups(runtime, graph, atomIdMap);

  if (opts.validate_counts) {
    const observedState = await runtime.getState(false);
    const observed = computeCounts(observedState);
    const diff = diffCounts(graph.counts, observed);
    if (diff.length > 0) {
      throw new BuildFromGraphError('count_mismatch', {
        expected: graph.counts,
        observed,
        diff,
      });
    }
  }

  // Dense relayout (2026-06-02): a dense fused core that declares wedge stereo
  // has the backend OWN the final coordinate frame — run clean() AFTER the
  // wedge flag was assigned against the agent's by-eye coords (steps 4/11
  // above), so by-eye coord-CW errors are re-idealized and Indigo perceives
  // CIP off the cleaned frame. Validated offline (production translateGraphIntent
  // path): outputs/dense-stereo-replay/RELAYOUT-{PROBE,CIP,JITTER}.json — clean
  // on correct coords flips 0/48 correct centers and heals the coord-CW class;
  // robust to realistic agent drift; cross-process deterministic. The
  // never-clean-with-coords rule (commit d198feb622) overfit to a coordless
  // diagnostic (outputs/diagnostics/wedge-coord-test). Dense-gated keeps sparse
  // byte-identical.
  const runClean =
    opts.layout === 'clean' ||
    (opts.layout === 'auto' && !coordsPresent) ||
    (opts.layout === 'auto' &&
      coordsPresent &&
      isDenseDraft(graph) &&
      hasWedgeStereo(graph));
  if (runClean) {
    await runtime.callBridge('clean');
  }
  void workingAtomById;

  // Parser-radical reconcile — MUST run after clean(), the final whole-canvas
  // roundtrip on this path: clean re-derives implicit-H counts and erases the
  // pin if it runs earlier (observed: pin before clean → [NaH]). Clears the
  // parser-introduced radical on lone non-organic seeds (lone [Na] → spurious
  // `|^1:0|` on export; 2026-06-06 sodium-acetate finding). The remaining
  // passes below only touch coordinates / read state, so the reconcile holds
  // to export time.
  await reconcileParserRadicals(runtime, graph, atomIdMap);

  // Fix 1 — post-build enumerate-and-require (non-layoutPolicy path).
  // Indigo perceives every atom that REMAINS topologically stereogenic
  // after the one-shot wedge passes. Any such atom must be an explicit
  // agent skip via `atom.stereo_unknown: true`, otherwise the build fails.
  // Removes the "silent achiral commit on a saddle" failure mode.
  // stereoMode removed 2026-05-26 — all builds commit stereo on the first
  // call. The two-phase commit (deferred → committed) was part of the dense
  // session machinery that's being deleted.
  const perceivedUndefinedStereoCenters =
    await assertNoUndefinedStereoPostBuild(runtime, graph, atomIdMap);

  // P-A: E/Z label-authoritative lock (non-locked path). Honor every declared
  // bond.geom against the POST-BUILD coordinate frame — whether the agent
  // supplied coords or not. Mirrors the layout-locked path's planEZCoordinateLock
  // call; sources frozen coords from the canvas instead of the post-layout()
  // snapshot. Reflects only a stereocenter-free half (the pure planner
  // guarantees this), so committed wedge stereo never moves.
  if (graph.bonds.some((b) => b.geom === 'cis' || b.geom === 'trans')) {
    const preLockState = await runtime.getState(false);
    const canvasById = new Map(preLockState.atoms.map((a) => [a.id, a]));
    const frozen: FrozenCoords = {};
    for (const [intentId, canvasId] of Object.entries(atomIdMap)) {
      const a = canvasById.get(canvasId);
      if (a) frozen[Number(intentId)] = { x: a.x, y: a.y };
    }
    const stereocenterIds = new Set<number>();
    for (const b of graph.bonds) {
      if (b.wedge !== null && b.wedge_from !== null) stereocenterIds.add(b.wedge_from);
    }
    for (const a of graph.atoms) {
      if (a.wedge_to_implicit_h != null) stereocenterIds.add(a.id);
    }
    for (const entry of graph.stereoTransfer ?? []) {
      stereocenterIds.add(entry.center);
    }
    for (const a of graph.atoms) {
      if (a.stereo_unknown) stereocenterIds.add(a.id);
    }
    const ezPlan = planEZCoordinateLock({ graph, frozenCoords: frozen, stereocenterIds });
    for (const u of ezPlan.updates) {
      const canvasId = atomIdMap[u.id];
      if (canvasId !== undefined) {
        await runtime.callBridge('setAtomXY', canvasId, u.x, u.y);
      }
    }
    (graph as { ezCoordinateLock?: unknown }).ezCoordinateLock = ezPlan.records;
  }

  const state = await runtime.getState(false);
  const visionFingerprint = await computeFingerprintFromCanvas(
    runtime,
    graph,
    atomIdMap,
    state.smiles ?? null,
    opts.forensics,
  );
  // assertFingerprintTopologyMatchesLedger removed 2026-05-26.
  const complexity: ComplexityResult | null = null;
  // assertDenseRoutingConsistency removed 2026-05-26 (the A004 trap).
  const geom = await verifyDeclaredGeomFromCanvas(runtime, graph, atomIdMap);

  // Lever A advisory — degenerate stereocenter geometry (coordinate-fidelity
  // plan 2026-06-03). A dense wedge center whose two IN-PLANE neighbors (drawn
  // neighbors other than the wedge target) are drawn near-collinear decodes the
  // wrong CIP from a correct wedge stroke (A009 atom 19 = 177.5°). Flag it so
  // the agent re-reads the in-plane bond DIRECTIONS from a crop. Advisory only:
  // no coord mutation, no SMILES change. Dense-gated (same gate as the relayout)
  // ⇒ sparse rows compute nothing and stay byte-identical.
  let degenerateStereoFindings: DegenerateStereoFinding[] = [];
  if (isDenseDraft(graph) && hasWedgeStereo(graph)) {
    const dsById = new Map(state.atoms.map((a) => [a.id, a]));
    const coordOf = (intentId: number) => {
      const cid = atomIdMap[intentId];
      const a = cid !== undefined ? dsById.get(cid) : undefined;
      return a ? { x: a.x, y: a.y } : undefined;
    };
    const wedgeTargets = new Map<number, Set<number>>();
    const adj = new Map<number, number[]>();
    const pushAdj = (x: number, y: number) => {
      const arr = adj.get(x);
      if (arr) arr.push(y);
      else adj.set(x, [y]);
    };
    for (const b of graph.bonds) {
      pushAdj(b.a, b.b);
      pushAdj(b.b, b.a);
      if (b.wedge !== null && b.wedge_from != null) {
        const target = b.a === b.wedge_from ? b.b : b.a;
        const set = wedgeTargets.get(b.wedge_from) ?? new Set<number>();
        set.add(target);
        wedgeTargets.set(b.wedge_from, set);
      }
    }
    const inPlaneNeighborsOf = (c: number) => {
      const t = wedgeTargets.get(c) ?? new Set<number>();
      return (adj.get(c) ?? []).filter((n) => !t.has(n));
    };
    degenerateStereoFindings = detectDegenerateStereoGeometry(
      [...wedgeTargets.keys()],
      inPlaneNeighborsOf,
      coordOf,
    );
  }

  await assertNoUnderValentAtoms(runtime);
  dumpGraphIntent(rawGraph, { ok: true }, opts.forensics);
  return {
    atomIdMap,
    bondIdMap,
    state,
    visionFingerprint,
    complexity,
    perceivedUndefinedStereoCenters,
    degenerateStereoFindings,
    geomVerification: geom.records,
    geomMismatchDiagnostics: geom.diagnostics,
    denseBuildPolicy: null,
  };
}

// Compute the K/C/F triage metric (Stage D of PLAN-a004-class-robustness-
// 2026-05-22) from the post-build canvas. Calls indigoComputeCIPLabels on
// the exported molfile to get the CIP-perceived stereocenter ids, fetches
// the annotated state for graph topology, and dispatches to the pure
// `computeComplexity` function. Best-effort: returns null on Indigo
// unavailability (standalone mode), bridge call failure, or any other
// non-build-blocking error. The build response carries `complexity: null`
// in that case; the agent / SKILL.md routing must tolerate null (treat as
// tier-0 placeholder until measurement-driven data arrives).

// Pull annotated atoms/bonds from the bridge, project into the pure
// fingerprint input shape, and compute the candidate. Best-effort: if the
// bridge call fails (mock runtime in unit tests, transient page error), the
// translator still completes the build; the response carries
// `visionFingerprint: null` and the grader's RDKit recompute path remains
// authoritative.
async function computeFingerprintFromCanvas(
  runtime: KetcherRuntime,
  graph: GraphIntent,
  atomIdMap: Record<number, number>,
  canonicalSmiles: string | null,
  forensics?: TranslatorForensicsOptions,
): Promise<VisionCheckCandidate | null> {
  let annotated: unknown;
  try {
    annotated = await runtime.getAnnotatedState();
  } catch {
    return null;
  }
  if (!annotated || typeof annotated !== 'object') return null;
  const annotatedObj = annotated as {
    atoms?: Array<{
      id: number;
      label: string;
      charge?: number | null;
    }>;
    bonds?: Array<{
      id: number;
      beginAtomId: number;
      endAtomId: number;
      order?: number;
      stereo?: number;
      aromatic?: boolean;
      inRing?: boolean;
    }>;
  };
  if (!Array.isArray(annotatedObj.atoms) || !Array.isArray(annotatedObj.bonds)) {
    return null;
  }

  const fpAtoms: FingerprintAtom[] = annotatedObj.atoms.map((a) => ({
    id: a.id,
    label: a.label,
    charge: a.charge ?? 0,
  }));
  const fpBonds: FingerprintBond[] = annotatedObj.bonds.map((b) => ({
    id: b.id,
    beginAtomId: b.beginAtomId,
    endAtomId: b.endAtomId,
    order: b.order ?? 1,
    stereo: b.stereo ?? 0,
    aromatic: b.aromatic === true,
    inRing: b.inRing === true,
  }));

  // Map GraphIntent drawn_H atom ids (intent space) → canvas ids.
  const drawnHCanvasIds: number[] = [];
  for (const atom of graph.atoms) {
    if (atom.drawn_H !== null && atom.drawn_H !== undefined) {
      const canvasId = atomIdMap[atom.id];
      if (canvasId !== undefined) drawnHCanvasIds.push(canvasId);
    }
  }

  const candidate = computeVisionCheckCandidate({
    atoms: fpAtoms,
    bonds: fpBonds,
    drawnHAtomIds: drawnHCanvasIds,
    canonicalSmiles,
  });
  dumpVisionFingerprint(candidate, forensics);
  return candidate;
}


// v3 doc §8 step 1 — pre-build validation for layoutPolicy
// "ketcher_clean_locked". Rejects an empty stereoTransfer, stereo-critical
// pixel coordinates, unknown atom-id references, and any structural defect
// (v3 doc §9.1 checks 1-4). Throws schema_invalid with the issue list.
//
// Handles both transcription modes (handoff-rs-direct §A):
//   - Wedge-primitive entries: full v3 §9.1 structural validation via
//     `validateStereoTransferEntry`.
//   - R/S-label entries (`stereo_label: 'R' | 'S' | 'unknown'`): only the
//     `center` atom-id existence check applies. No drawnNeighborsCW or
//     pixel-coord checks.
function assertLayoutLockedValid(graph: GraphIntent): void {
  const issues: ValidationIssue[] = [];
  const entries = graph.stereoTransfer ?? [];
  if (entries.length === 0) {
    issues.push({
      path: 'stereoTransfer',
      message:
        'layoutPolicy "ketcher_clean_locked" requires a non-empty stereoTransfer array',
    });
  }
  const atomById = new Map(graph.atoms.map((a) => [a.id, a]));

  // Stereocenter atoms and their drawn neighbors must carry no x/y — the
  // translator owns the coordinate frame in this mode (v3 doc §6, §8).
  // For R/S-label entries the agent provides no drawnNeighborsCW, so only
  // the `center` atom is stereo-critical.
  const stereoCritical = new Set<number>();
  for (const e of entries) {
    stereoCritical.add(e.center);
    if (isWedgePrimitiveEntry(e)) {
      for (const n of e.drawnNeighborsCW) stereoCritical.add(n);
    }
  }
  for (const id of stereoCritical) {
    const a = atomById.get(id);
    if (a && (a.x !== undefined || a.y !== undefined)) {
      issues.push({
        path: `atoms[id=${id}]`,
        message:
          'stereo-critical atom must not carry x/y under layoutPolicy "ketcher_clean_locked"',
      });
    }
  }

  // Duplicate-center check applies to both modes — one entry per center.
  const seenCenters = new Set<number>();
  entries.forEach((e, i) => {
    if (seenCenters.has(e.center)) {
      issues.push({
        path: `stereoTransfer[${i}]`,
        message: `duplicate stereoTransfer entry for center ${e.center}`,
      });
    }
    seenCenters.add(e.center);

    if (!atomById.has(e.center)) {
      issues.push({
        path: `stereoTransfer[${i}]`,
        message: `unknown atom id ${e.center}`,
      });
    }
    if (isWedgePrimitiveEntry(e)) {
      for (const id of e.drawnNeighborsCW) {
        if (!atomById.has(id)) {
          issues.push({
            path: `stereoTransfer[${i}]`,
            message: `unknown atom id ${id}`,
          });
        }
      }
      for (const msg of validateStereoTransferEntry(e)) {
        issues.push({ path: `stereoTransfer[${i}]`, message: msg });
      }
    }
    // R/S-label entries need no further structural checks beyond the schema-
    // enforced `stereo_label ∈ {R, S, unknown}` literal.
  });

  if (issues.length > 0) {
    throw new BuildFromGraphError('schema_invalid', issues);
  }
}

// v3 doc §11.2 — build-integrity assertion. Every compiled stereocenter must,
// after wedge application, carry exactly one wedge bond; no other bond may
// have silently acquired one.
function assertBuildIntegrity(
  state: AgentState,
  compiled: { center: number }[],
  atomIdMap: Record<number, number>,
): void {
  const WEDGE_STEREO = new Set([1, 6]); // Ketcher STEREO.UP / STEREO.DOWN
  const wedgeBondBegins: number[] = [];
  for (const b of state.bonds) {
    if (WEDGE_STEREO.has(b.stereo as number)) wedgeBondBegins.push(b.beginAtomId);
  }
  const expected = compiled.map((c) => atomIdMap[c.center]);
  const expectedSet = new Set(expected);
  const observedSet = new Set(wedgeBondBegins);
  const missing = expected.filter((c) => !observedSet.has(c));
  const extra = wedgeBondBegins.filter((b) => !expectedSet.has(b));
  if (
    missing.length > 0 ||
    extra.length > 0 ||
    wedgeBondBegins.length !== compiled.length
  ) {
    throw new BuildFromGraphError('stereo_transfer_failed', {
      step: 'build_integrity',
      message:
        'wedge-bond set after application does not match the compiled stereocenters',
      expectedStereocenterCount: compiled.length,
      observedWedgeBonds: wedgeBondBegins.length,
      missing,
      extra,
    });
  }
}

// v3 doc §8 steps 3-7 — parity-transfer stereo on a frozen Ketcher layout.
// Dispatches per entry on the two transcription modes:
//   - Wedge-primitive entries: compile via cyclic-parity, apply via
//     setWedgeBond / addAtomWithSingleBond (the existing v3 path).
//   - R/S-label entries: per-center CIP solver against Indigo (handoff-rs-
//     direct §B), applied via direct V2000 molfile modification + loadMolfile.
//
// Fix 1 (handoff-step0-and-completeness §B) — enumerate-and-require: after
// the layout pass, call Indigo to enumerate every UNDEFINED stereocenter
// in the flat skeleton. Every perceived center must be addressed by a
// stereoTransfer entry; otherwise fail closed. Centers explicitly skipped
// via `stereo_unknown: true` or `stereo_label: 'unknown'` count as
// addressed (translator no-op; grader treats as match-any).
async function applyLayoutLockedStereo(
  runtime: KetcherRuntime,
  graph: GraphIntent,
  atomIdMap: Record<number, number>,
  opts: TranslatorOptions,
): Promise<AgentState & { ket: string | null; molfile: string | null }> {
  // Step 3: a global Indigo `layout` pass (replaces v3 doc §8 step 3's
  // `clean()`). `clean()` is a LOCAL optimiser — it polishes existing
  // coordinates in place and leaves the translator's incremental skeleton
  // tangled for strained fused systems, feeding the compiler degenerate
  // coordinates. `ketcher.layout()` recomputes the 2D layout globally from
  // scratch and untangles it.
  await runtime.callBridge('layout');

  // Step 4: freeze coords, keyed by intent id via atomIdMap.
  const layoutState = await runtime.getState(false);
  const frozen: FrozenCoords = {};
  for (const [intentId, canvasId] of Object.entries(atomIdMap)) {
    const a = layoutState.atoms.find((x) => x.id === canvasId);
    if (a) frozen[Number(intentId)] = { x: a.x, y: a.y };
  }

  // Graph neighbors per atom (intent ids) for the §9.1 check-6 identity test.
  const neighborsByAtom = new Map<number, Set<number>>();
  for (const atom of graph.atoms) neighborsByAtom.set(atom.id, new Set());
  for (const b of graph.bonds) {
    neighborsByAtom.get(b.a)?.add(b.b);
    neighborsByAtom.get(b.b)?.add(b.a);
  }

  // Partition entries by transcription mode.
  const entries = graph.stereoTransfer ?? [];
  const wedgeEntries = entries.filter(isWedgePrimitiveEntry);
  const labelEntries = entries.filter(isStereoLabelEntry);

  // LOCK 22 — `facing: 'wavy' | 'unknown'` (epimer mixtures, wedges still
  // unreadable after zoom) is an explicit no-stereo declaration that maps to
  // stereo_unknown (HISTORY row 8). compileWedge only understands toward/away
  // and would otherwise coerce wavy/unknown into a bogus solid/hashed wedge
  // (Mode C's deriveIntendedCIPFromWedgePrimitive correctly returns null, but
  // only AFTER the parity-transfer pass already fired the wedge). Normalize
  // once here: setting stereo_unknown on the shared entry makes the apply
  // filter below, the Mode C loop, and assertNoUndefinedStereoPostBuild's
  // skip-set all treat it as an explicit skip — no wedge, center addressed.
  for (const e of wedgeEntries) {
    if (e.facing === 'wavy' || e.facing === 'unknown') {
      (e as { stereo_unknown?: boolean }).stereo_unknown = true;
    }
  }

  // Step 5+6 (wedge-primitive entries): compile + apply.
  const compiledPairs = wedgeEntries
    .filter((e) => !e.stereo_unknown)
    .map((entry) => {
      const issues = validateStereoTransferEntry(entry, {
        frozenCoords: frozen,
        graphNeighbors: neighborsByAtom.get(entry.center) ?? new Set<number>(),
      });
      if (issues.length > 0) {
        throw new BuildFromGraphError('stereo_transfer_failed', {
          center: entry.center,
          issues,
        });
      }
      try {
        return { entry, compiled: compileWedge(entry, frozen) };
      } catch (err) {
        if (err instanceof StereoTransferError) {
          throw new BuildFromGraphError('stereo_transfer_failed', {
            center: entry.center,
            diagnostic: err.diagnostic,
          });
        }
        throw err;
      }
    });
  const compiled = compiledPairs.map((p) => p.compiled);

  for (const { entry, compiled: cw } of compiledPairs) {
    if (entry.wedgeToImplicitH) {
      const parentId = atomIdMap[cw.center];
      const annotated = (await runtime.getAnnotatedState()) as {
        atoms: Array<{ id: number; x: number; y: number; implicitH: number }>;
        bonds: Array<{ beginAtomId: number; endAtomId: number }>;
      };
      const parent = annotated.atoms.find((a) => a.id === parentId);
      if (!parent) {
        throw new BuildFromGraphError('stereo_transfer_failed', {
          step: 'wedge_to_implicit_h_parity',
          center: entry.center,
          message: `center ${entry.center} (canvas id ${parentId}) not found in annotated state`,
        });
      }
      if (parent.implicitH < 1) {
        throw new BuildFromGraphError('stereo_transfer_failed', {
          step: 'wedge_to_implicit_h_parity',
          center: entry.center,
          message: `center ${entry.center} has no implicit H to promote (implicitH=${parent.implicitH})`,
        });
      }
      await runtime.callBridge('setAtomImplicitHCount', parentId, parent.implicitH - 1);
      const res = await runtime.callBridge<{ endAtomId: number }>(
        'addAtomWithSingleBond',
        parentId,
        'H',
      );
      const hid = res.endAtomId;
      const offset = computeOppositeCentroidOffset(parent, annotated);
      await runtime.callBridge('setAtomXY', hid, parent.x + offset.x, parent.y + offset.y);
      await runtime.callBridge('setWedgeBond', parentId, hid, cw.wedge);
    } else {
      await runtime.callBridge(
        'setWedgeBond',
        atomIdMap[cw.center],
        atomIdMap[cw.outOfPlaneNeighbor],
        cw.wedge,
      );
    }
  }

  // R/S-label path (handoff-rs-direct §B): apply per-center CIP targets via
  // direct V2000 molfile modification. Runs AFTER wedge-primitive entries
  // (which mutate via setWedgeBond), so the solver baseline already carries
  // those wedges; the solver targets only its own centers without touching
  // the wedge-primitive bonds.
  await applyStereoLabels(runtime, labelEntries, atomIdMap);

  // Mode C — selective V2000 solver re-apply for layout-invariant stereo.
  //
  // After the parity-transfer wedge-primitive pass, two R/S labels exist
  // per chiral center:
  //   1. Indigo's CIP perception on the post-build canvas (depends on 2D
  //      coords + wedge bond — layout-sensitive).
  //   2. "Intended R/S" derived from the agent's pixel facts
  //      (drawnNeighborsCW + outOfPlaneNeighbor + facing + first-shell
  //      atomic numbers + drawn coords). Pure pixel facts, layout-
  //      independent.
  //
  // On disagreement, the intended R/S wins and is re-applied via
  // applyStereoLabels — which writes parity bits directly to the molfile
  // (V2000 solver path), bypassing wedge geometry. Closes HISTORY row 11
  // (K=11 paclitaxel oscillation 3/11 → 6/11 across reruns from Ketcher
  // auto-layout drift at saddle junctions).
  //
  // Poor-man CIP refuses on first-shell atomic-number ties (CIP digraph
  // descent out of scope here). On 'tie' / 'unsupported_projection' /
  // 'incomplete' / 'no_coords' / 'degenerate_geometry', the parity-transfer
  // + Indigo result stands unchanged. Forensic records carry the decision
  // per center so reviewers can audit.
  if (wedgeEntries.length > 0) {
    // Mode C reads per-atom coordinates to derive intended R/S. Under
    // layoutPolicy 'ketcher_clean_locked' the stereo-critical atoms carry NO
    // pixel coords — assertLayoutLockedValid forbids them, because the
    // translator owns the coordinate frame in this mode. The geometry that
    // actually exists is the FROZEN post-layout() coords captured above
    // (keyed by intent id). Build the lookup map from those frozen coords so
    // Mode C perceives intended R/S; reading the coord-banned graph.atoms here
    // returned `no_coords` for every center and left the layout-invariant
    // V2000 re-apply structurally dead on the vision path.
    const intentByAtomId = new Map(
      graph.atoms.map((a) => {
        const fz = frozen[a.id];
        return [a.id, fz ? { ...a, x: fz.x, y: fz.y } : a] as const;
      }),
    );
    const reapplyEntries: StereoLabelEntry[] = [];
    const modeCRecords: ModeCRecord[] = [];

    let perceived: Map<number, 'R' | 'S'> = new Map();
    const canvasToMolfile1Based = new Map<number, number>();
    try {
      const postBuildMolfile = await runtime.exportMolfile();
      if (postBuildMolfile) {
        perceived = await indigoComputeCIPLabels(postBuildMolfile);
        const annotatedAfter = await runtime.getState(false);
        annotatedAfter.atoms.forEach((a, i) => {
          canvasToMolfile1Based.set(a.id, i + 1);
        });
      }
    } catch {
      // Indigo unreachable (standalone mode without remote service): Mode C
      // perception step is best-effort. modeCRecords reflect perceived=null
      // and we skip re-apply; parity-transfer result stands.
    }

    for (const entry of wedgeEntries) {
      if (entry.stereo_unknown) continue;
      const canvasId = atomIdMap[entry.center];
      const molfileId = canvasToMolfile1Based.get(canvasId);
      const perceivedRS =
        molfileId !== undefined ? perceived.get(molfileId) ?? null : null;
      const intended = deriveIntendedCIPFromWedgePrimitive(
        entry,
        intentByAtomId,
      );

      let reapplied = false;
      let skipReason: string | null = null;
      if (
        intended.label &&
        perceivedRS &&
        intended.label !== perceivedRS
      ) {
        reapplyEntries.push({
          center: entry.center,
          stereo_label: intended.label,
        });
        reapplied = true;
      } else if (!intended.label) {
        skipReason = intended.reason;
      }

      modeCRecords.push({
        intentCenter: entry.center,
        canvasCenter: canvasId,
        intendedRS: intended.label ?? null,
        perceivedRS,
        reapplied,
        skipReason,
      });
    }

    if (reapplyEntries.length > 0) {
      try {
        await applyStereoLabels(runtime, reapplyEntries, atomIdMap);
      } catch (err) {
        // V2000 solver couldn't reach the target (e.g. center genuinely
        // non-stereogenic per Indigo, or Indigo unreachable mid-solve).
        // Mode C re-apply is best-effort; parity-transfer wedge result
        // stands. Forensic record captures the attempt.
        modeCRecords.push({
          intentCenter: -1,
          canvasCenter: -1,
          intendedRS: null,
          perceivedRS: null,
          reapplied: false,
          skipReason: `solver_failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Forensic dump (opt-in via KETCHER_BUILD_DUMP_DIR). Visible to
    // reviewers + Phase 5 e2e via translatorOutput.modeC.
    (graph as { modeC?: unknown }).modeC = modeCRecords;
  }

  // P1.1 — lock declared E/Z geometry against the post-layout frame. The global
  // layout() (step 3) redraws double bonds blind to the agent's drawn cis/trans,
  // and verifyDeclaredGeomFromCanvas downstream only *advises*. For each acyclic
  // 1,2-disubstituted declared-geom bond whose built geometry contradicts the
  // label, reflect a stereocenter-free half across the bond axis so Indigo
  // perceives the drawn E/Z. Runs AFTER the tetrahedral stereo passes (wedge +
  // Mode C V2000 re-apply), reflecting only a stereocenter-free half, so no
  // committed chirality moves. setBondStereo(CIS_TRANS) corrupts the Indigo
  // writer (see ez-verify.ts header) — coordinate re-pin is the supported lever.
  const ezStereocenterIds = new Set(
    (graph.stereoTransfer ?? []).map((e) => e.center),
  );
  const ezPlan = planEZCoordinateLock({
    graph,
    frozenCoords: frozen,
    stereocenterIds: ezStereocenterIds,
  });
  for (const u of ezPlan.updates) {
    const canvasId = atomIdMap[u.id];
    if (canvasId !== undefined) {
      await runtime.callBridge('setAtomXY', canvasId, u.x, u.y);
    }
  }
  (graph as { ezCoordinateLock?: unknown }).ezCoordinateLock = ezPlan.records;

  // Step 7: build-integrity assertion (v3 doc §11.2). Only wedge-primitive
  // entries are checked here — the R/S-label path applies wedges via
  // molfile rewrite, and the integrity check's wedge-count semantics depend
  // on the begin-atom invariants that the V2000 setWedge helper preserves.
  // For pure R/S-direct intents the wedge-primitive count is zero and the
  // check is a no-op.
  const finalState = await runtime.getState(false);
  if (compiled.length > 0) {
    assertBuildIntegrity(finalState, compiled, atomIdMap);
  }

  if (opts.validate_counts) {
    const observed = computeCounts(finalState);
    const diff = diffCounts(graph.counts, observed);
    if (diff.length > 0) {
      throw new BuildFromGraphError('count_mismatch', {
        expected: graph.counts,
        observed,
        diff,
      });
    }
  }

  // Fix 1 — post-build enumerate-and-require. Every Indigo-perceived
  // still-undefined stereocenter must be explicitly skipped (stereo_unknown
  // / stereo_label 'unknown'). Removes the "silent achiral commit on a
  // saddle" failure mode.
  //
  // Dense-stereo advisory (2026-06-01): smuggle the perceived-undefined-skipped
  // set onto `graph` the same way `modeC` is smuggled (this fn returns
  // AgentState, not TranslatorResult); the layoutPolicy construction site reads
  // it back and threads it onto perceivedUndefinedStereoCenters.
  const perceivedUndefinedStereoCenters =
    await assertNoUndefinedStereoPostBuild(runtime, graph, atomIdMap);
  (graph as { perceivedUndefinedStereoCenters?: number[] }).perceivedUndefinedStereoCenters =
    perceivedUndefinedStereoCenters;

  return finalState;
}

// Fix 1 (post-build) — Indigo perceives every atom that REMAINS undefined
// after all wedge passes have run. Any such atom must be either an explicit
// agent skip (`atom.stereo_unknown: true`, or a stereoTransfer entry with
// `stereo_unknown: true` / `stereo_label: 'unknown'`) or the build fails.
//
// Runs in BOTH paths (layoutPolicy AND non-layoutPolicy) at end-of-build.
// Removes the agent-self-assessment escape route ("submit flat skeleton on a
// saddle and silently commit achiral"). Topology-derived perception decides.
//
// RETURN VALUE (dense-stereo advisory, 2026-06-01): the assert ALSO RETURNS the
// perceived-undefined intent ids that the agent explicitly SKIPPED (the
// `stereo_unknown` set Indigo still sees as undefined). The `unaccounted` THROW
// is unchanged; this return only surfaces the ALREADY-computed skipped set so
// `buildStereoAdvisory` can turn it into a per-center crop worklist on the build
// response. Returns `[]` on every graceful degrade path (Indigo down, no
// molfile, mock runtime) — so the advisory silently produces nothing, never a
// C6/B2 — post-build valence-sanity gate. Fetches annotated state and checks
// for under-valent neutral non-aromatic C/N/O atoms. Best-effort: if the runtime
// cannot return annotated state (mock runtime / no bridge), returns silently.
async function assertNoUnderValentAtoms(runtime: KetcherRuntime): Promise<void> {
  let ann: { atoms: ValenceAtom[] };
  try {
    ann = (await runtime.getAnnotatedState()) as { atoms: ValenceAtom[] };
  } catch {
    return; // mock runtime / no annotated state — skip; other gates cover structure
  }
  const under = findUnderValentAtoms(ann.atoms);
  if (under.length > 0) {
    throw new BuildFromGraphError('under_valent_atom', {
      step: 'valence_sanity_post_build',
      message:
        `Built heavy atom(s) ${under.join(', ')} are under-valent with no declared charge or radical — ` +
        'this exports as a bare [C]-style atom and reloads as a spurious radical. ' +
        'Add the missing bond or implicit H, or declare the charge/radical if intended.',
      underValent: under,
    }, 'under_valent_atom');
  }
}

// throw, never an ok-flip. Exported for unit tests (stereo-advisory.test.ts).
export async function assertNoUndefinedStereoPostBuild(
  runtime: KetcherRuntime,
  graph: GraphIntent,
  atomIdMap: Record<number, number>,
): Promise<number[]> {
  // Best-effort: if the runtime can't export a molfile (mock runtime in unit
  // tests, transient bridge failure, etc.) skip silently unless strict-mode
  // env demands the check. The downstream pipeline catches structurally
  // broken builds via other gates.
  let molfile: string | null = null;
  try {
    if (typeof runtime.exportMolfile !== 'function') return [];
    molfile = await runtime.exportMolfile();
  } catch (err) {
    if (process.env.KETCHER_REQUIRE_FIX1 === '1') {
      throw new BuildFromGraphError('stereo_transfer_failed', {
        step: 'enumerate_stereocenters_post_build',
        message: `exportMolfile failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return [];
  }
  if (!molfile) return [];

  let stillUndefined0Based: number[];
  try {
    stillUndefined0Based = await indigoCheckStereocenters(molfile);
  } catch (err) {
    // Indigo unreachable — degrade gracefully unless the strict-mode env var
    // demands the check. Standalone runs (no Indigo container) fall through.
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env.KETCHER_REQUIRE_FIX1 === '1') {
      throw new BuildFromGraphError('stereo_transfer_failed', {
        step: 'enumerate_stereocenters_post_build',
        message: `Indigo unreachable; Fix 1 enumerate-and-require disabled: ${msg}`,
      });
    }
    return [];
  }

  if (stillUndefined0Based.length === 0) return [];

  // Indigo returns 0-based atom indices that correspond to position in the
  // V2000 atom block (matches state.atoms order). Map back to canvas id, then
  // to intent id via atomIdMap.
  const state = await runtime.getState(false);
  const canvasByIndigoIdx = new Map<number, number>();
  state.atoms.forEach((a, i) => {
    canvasByIndigoIdx.set(i, a.id);
  });
  const intentByCanvas = new Map<number, number>();
  for (const [intentId, canvasId] of Object.entries(atomIdMap)) {
    intentByCanvas.set(canvasId, Number(intentId));
  }

  // Compute the set of explicitly-skipped intent atoms.
  const skipped = new Set<number>();
  for (const atom of graph.atoms) {
    if (atom.stereo_unknown) skipped.add(atom.id);
  }
  for (const entry of graph.stereoTransfer ?? []) {
    if (isStereoLabelEntry(entry)) {
      // 'unknown' and 'beyond_protocol' both skip stereo encoding for
      // post-build enumerate-and-require. 'beyond_protocol' surfaces
      // separately in `confidence_per_center` so the row-level
      // reporter distinguishes the refusal class from a generic skip.
      if (
        entry.stereo_label === 'unknown' ||
        entry.stereo_label === 'beyond_protocol'
      ) {
        skipped.add(entry.center);
      }
    } else if (entry.stereo_unknown) {
      skipped.add(entry.center);
    }
  }
  for (const obs of graph.stereoObservations ?? []) {
    if (obs.explicit_skip === true) {
      skipped.add(obs.center);
    }
  }

  // Stereo-obligation gate: a genuine drawn-stereo obligation is an Indigo-flagged
  // undefined center that is a CARBON. Indigo over-perceives non-carbon centers
  // (sp2 planar amide/aromatic N; resonance-symmetric phosphate P; sulfone S; …)
  // because its check does graph-distinctness, not resonance-aware chemical
  // distinctness. See stereo-obligation.ts (stereo-obligation gate design).
  const elementByCanvasId = new Map<number, string>();
  let haveAnnotatedState = false;
  try {
    const ann = (await runtime.getAnnotatedState()) as { atoms: Array<{ id: number; label: string }> };
    for (const a of ann.atoms) elementByCanvasId.set(a.id, a.label);
    haveAnnotatedState = true;
  } catch {
    // annotated state unavailable (mock runtime) — no filtering; preserve prior behaviour
  }

  const unaccounted: Array<{ intentId: number | null; canvasId: number | null; indigoIdx: number }> = [];
  const unknownIntentIds: number[] = [];
  for (const idx of stillUndefined0Based) {
    const canvasId = canvasByIndigoIdx.get(idx);
    const intentId = canvasId !== undefined ? intentByCanvas.get(canvasId) : undefined;
    const el = canvasId !== undefined ? elementByCanvasId.get(canvasId) : undefined;
    if (haveAnnotatedState && el !== undefined && !isCarbonStereoObligation(el)) {
      // non-carbon: Indigo over-perception, not a drawn-stereo obligation.
      // Excludes from BOTH the unaccounted throw and the C3 mass-skip K. Only
      // exclude when positively known non-carbon (missing/absent annotated state
      // falls through to the demand/skip logic — never silently drop a center).
      continue;
    }
    if (intentId === undefined || !skipped.has(intentId)) {
      unaccounted.push({
        intentId: intentId ?? null,
        canvasId: canvasId ?? null,
        indigoIdx: idx,
      });
    } else {
      unknownIntentIds.push(intentId);
    }
  }

  if (unaccounted.length > 0) {
    throw new BuildFromGraphError('stereo_transfer_failed', {
      step: 'enumerate_stereocenters_post_build',
      message:
        'Indigo perceives stereocenters that remain undefined after build. ' +
        'Address each one with a wedge (bond.wedge / wedge_to_implicit_h / stereoTransfer wedge entry), ' +
        "an R/S-label entry, or an explicit skip (`atom.stereo_unknown: true`, " +
        "stereoTransfer `stereo_unknown: true`, `stereo_label: 'unknown'`, or " +
        'worksheet-backed `stereoObservations[].explicit_skip`). ' +
        'Silent achiral commits on topologically-stereogenic atoms are no longer accepted.',
      unaccounted,
    });
  }

  // Dense-stereo advisory (2026-06-01): past the unaccounted-THROW guard, every
  // still-undefined center Indigo perceives is an EXPLICIT agent skip. Surface
  // exactly that skipped set (already collected in `unknownIntentIds`) to the
  // build response so `buildStereoAdvisory` can build a per-center crop
  // worklist. Deduped + sorted is done in the advisory builder; return the raw
  // collected set here. The THROW above is untouched.
  const perceivedSkipped = [...new Set(unknownIntentIds)];

  // W5 — tier-routing gate (consolidated handoff 2026-05-23 §5 W5).
  // After every Indigo-perceived stereocenter is accounted for, reject builds
  // where the agent declared an outsize fraction of them as 'unknown'. The
  // motivating cheat (HISTORY §5 row 34): mark all 11 paclitaxel
  // stereocenters 'unknown' on a flat skeleton; Fix 1 accepts (every center
  // has a skip), grader records "tier-2 skipped" rather than "tier-2 wrong",
  // free pass.
  //
  // Threshold: unknown_count / K > 0.3 AND K >= K_min. Below K_min, single-
  // center molecules with one legitimately-ambiguous wedge would always trip
  // the ratio. Calibration: K_min=5 and threshold=0.3 from handoff §5 W5;
  // open-question Q5 candidate (calibrate from tier-2 panel data).
  let assignedCount: number;
  try {
    const cipLabels = await indigoComputeCIPLabels(molfile);
    assignedCount = cipLabels.size;
  } catch {
    // Indigo just answered indigoCheckStereocenters; a subsequent
    // indigoComputeCIPLabels failure is anomalous (mid-restart, transient).
    // Degrade silently — same posture as Fix 1's unreachable-Indigo path.
    // The all-unknown cheat will be caught on the next attempt once Indigo
    // recovers.
    return perceivedSkipped;
  }
  // C3 — restored mass-skip gate. perceivedSkipped already excludes non-carbon
  // centers (the carbon-obligation gate above), so K counts only real (carbon)
  // stereocenters.
  if (isMassSkip({ assignedCount, unknownCount: perceivedSkipped.length })) {
    throw new BuildFromGraphError(
      'stereo_transfer_failed',
      {
        step: 'mass_skip_gate',
        message:
          `Stereo mass-skip rejected: ${perceivedSkipped.length} of ${assignedCount + perceivedSkipped.length} ` +
          'perceived stereocenters were declared stereo_unknown. Read the wedges (crop each center) and declare them, ' +
          'or honestly refuse if the drawing is genuinely unreadable. A flat all-unknown export is not accepted.',
        massSkip: { assignedCount, unknownCount: perceivedSkipped.length },
      },
      'mass_skip_gate',
    );
  }
  return perceivedSkipped;
}

/**
 * C3 — restored W5 mass-skip ratio gate. Reject a build that declares an outsize
 * fraction of its REAL perceived stereocenters as stereo_unknown (the A009 dodge).
 * K = assigned + unknown (AFTER the carbon-obligation gate drops non-carbon
 * over-perceptions). Fire when
 * unknown/K > 0.3 AND K >= 5. Calibration K_min=5, threshold=0.3 (handoff §5 W5).
 */
export function isMassSkip(input: { assignedCount: number; unknownCount: number }): boolean {
  const K = input.assignedCount + input.unknownCount;
  if (K < 5) return false;
  return input.unknownCount / K > 0.3;
}

/** Tier-routing gate threshold inputs. Exported for unit-test coverage. */

async function applyStereoLabels(
  runtime: KetcherRuntime,
  labelEntries: StereoLabelEntry[],
  atomIdMap: Record<number, number>,
): Promise<void> {
  if (labelEntries.length === 0) return;

  // For R/S-direct, every actionable target (R or S) requires the solver to
  // touch the canvas. 'unknown' and 'beyond_protocol' targets are no-ops
  // — neither produces a CIP assignment.
  const actionable = labelEntries.filter(
    (e) => e.stereo_label !== 'unknown' && e.stereo_label !== 'beyond_protocol',
  );
  if (actionable.length === 0) return;

  const baselineMolfile = await runtime.exportMolfile();
  if (!baselineMolfile) {
    throw new BuildFromGraphError('stereo_transfer_failed', {
      step: 'stereo_label_solver',
      message: 'exportMolfile returned null before the R/S solver',
    });
  }

  // Build canvas (intent id) → molfile (1-based) id map. The state's atom
  // order matches the V2000 molfile order (atom i in state → atom i+1 in
  // molfile) since Ketcher exports them in identical sequence.
  const state = await runtime.getState(false);
  const canvasToMolfile1Based = new Map<number, number>();
  state.atoms.forEach((a, i) => {
    canvasToMolfile1Based.set(a.id, i + 1);
  });

  // Map intent (graph) ids → canvas ids via atomIdMap; the solver expects
  // canvas (atom-state) ids in its target list. `beyond_protocol` entries
  // are filtered out before this map since they carry no CIP assignment
  // — they are recorded in `confidence_per_center` by the complexity
  // helper and otherwise behave like an explicit skip for the build.
  const targets: StereoLabelTarget[] = labelEntries
    .filter((e) => e.stereo_label !== 'beyond_protocol')
    .map((e) => {
      const canvasId = atomIdMap[e.center];
      if (canvasId === undefined) {
        throw new BuildFromGraphError('stereo_transfer_failed', {
          step: 'stereo_label_solver',
          message: `intent atom id ${e.center} has no canvas mapping`,
        });
      }
      // Type-narrow: after the filter above, stereo_label is one of
      // 'R' | 'S' | 'unknown' — matching StereoLabelTarget exactly.
      return {
        center: canvasId,
        target: e.stereo_label as 'R' | 'S' | 'unknown',
      };
    });

  let finalMolfile: string;
  try {
    const result = await solveStereoLabels(
      baselineMolfile,
      targets,
      canvasToMolfile1Based,
    );
    finalMolfile = result.finalMolfile;
  } catch (err) {
    if (err instanceof StereoCIPUnreachableError) {
      throw new BuildFromGraphError('stereo_cip_unreachable', {
        center: err.center,
        target: err.target,
      });
    }
    throw err;
  }

  await runtime.loadMolfile(finalMolfile);
}

/**
 * Map a GraphIntent `stereo_group` ({ kind, id }) onto Ketcher's per-atom
 * `stereoLabel` string (the MDL enhanced-stereo collection field):
 *   - `abs` → "abs"        (absolute config — the default STEABS collection)
 *   - `and` → "&<id>"      (AND group — racemic-within-group; STERAC<id>)
 *   - `or`  → "or<id>"     (OR group — unknown-which-enantiomer; STEREL<id>)
 *   - `rel` → "&<id>"      (MDL relative config maps onto an AND group; the
 *                           drawn config is relative, not absolute)
 * StereoLabel string forms verified against ketcher-core (StereoLabel enum:
 * Abs="abs", And="&", Or="or"; group number suffixed for And/Or).
 */
function stereoGroupToLabel(group: {
  kind: 'abs' | 'rel' | 'or' | 'and';
  id: number;
}): string {
  switch (group.kind) {
    case 'abs':
      return 'abs';
    case 'or':
      return `or${group.id}`;
    case 'and':
    case 'rel':
      return `&${group.id}`;
  }
}

/**
 * Apply every declared `stereo_group` as a per-atom `stereoLabel`. Returns
 * true iff at least one label was applied (so the caller knows whether a
 * re-export is needed). MUST run AFTER the stereo-parity pass — the
 * layout-locked solver writes committed centers' stereoLabel to "abs", which
 * would clobber an enhanced-stereo group applied earlier.
 */
async function applyStereoGroups(
  runtime: KetcherRuntime,
  graph: GraphIntent,
  atomIdMap: Record<number, number>,
): Promise<boolean> {
  let applied = false;
  for (const atom of graph.atoms) {
    if (atom.stereo_group === undefined) continue;
    await runtime.callBridge(
      'setAtomStereoLabel',
      atomIdMap[atom.id],
      stereoGroupToLabel(atom.stereo_group),
    );
    applied = true;
  }
  return applied;
}

/**
 * Re-export the layout-locked state after a post-parity mutation (the
 * stereo_group pass). `runtime.getState(false)` already returns the
 * `AgentState & { ket, molfile }` shape `applyLayoutLockedStereo` returns.
 */
async function reExportLayoutLockedState(
  runtime: KetcherRuntime,
): Promise<AgentState & { ket: string | null; molfile: string | null }> {
  return runtime.getState(false) as Promise<
    AgentState & { ket: string | null; molfile: string | null }
  >;
}

/**
 * Parser-radical reconcile. `singleAtomSmiles` seeds lone non-organic atoms
 * via bracket SMILES (`[Na]`, `[K]`, …) and Indigo's parser encodes their
 * unmet natural valence as an unpaired electron — the canvas atom arrives
 * with radical DOUBLET although the agent declared `radical: 0`, and the
 * export grows a spurious `|^1:0|` CXSMILES extension (the
 * sodium-acetate finding). Clearing the
 * radical alone reroutes the unmet valence into implicit H ([Na] → [NaH]),
 * so each action pairs the clear with an implicit-H pin to 0 unless a
 * drawn_H was declared (that pass set the count already).
 *
 * Call AFTER the path's last whole-canvas roundtrip (clean/layout) — those
 * re-derive implicit-H counts and erase the pin. Non-locked path only for
 * now; the `ketcher_clean_locked` path keeps its pre-existing artifact (its
 * roundtrips live inside applyLayoutLockedStereo and its exported state is
 * captured there).
 */
async function reconcileParserRadicals(
  runtime: KetcherRuntime,
  graph: GraphIntent,
  atomIdMap: Record<number, number>,
): Promise<void> {
  // Pre-filter: the artifact can only arise on bracket-SMILES seeds, i.e.
  // non-organic elements. Skip the canvas read (~0.3 s in remote mode) for
  // the all-organic majority of builds.
  if (
    !graph.atoms.some(
      (a) => a.radical === 0 && !ORGANIC_NATURAL_VALENCE.has(a.element),
    )
  ) {
    return;
  }
  const canvasState = await runtime.getState(false);
  const canvasAtomById = new Map(canvasState.atoms.map((a) => [a.id, a]));
  const canvasRadicalByIntentId = new Map<number, number | null>();
  for (const atom of graph.atoms) {
    const mappedId = atomIdMap[atom.id];
    if (mappedId === undefined) continue;
    canvasRadicalByIntentId.set(atom.id, canvasAtomById.get(mappedId)?.radical ?? null);
  }
  for (const action of planRadicalReconciliation(graph.atoms, canvasRadicalByIntentId)) {
    await runtime.callBridge('setAtomRadical', atomIdMap[action.intentId], 0);
    if (action.pinImplicitHZero) {
      await runtime.callBridge('setAtomImplicitHCount', atomIdMap[action.intentId], 0);
    }
  }
}

async function buildSkeletonPerAtom(
  runtime: KetcherRuntime,
  graph: GraphIntent,
  comp: ComponentSpec,
  atomIdMap: Record<number, number>,
  bondIdMap: Record<string, number>,
): Promise<void> {
  const order = bfsOrder(comp);
  if (order.length === 0) return;

  const atomById = new Map<number, IntentAtom>(graph.atoms.map((a) => [a.id, a]));

  const seedIntentId = order[0];
  const seedAtom = atomById.get(seedIntentId)!;
  const before = await runtime.getState(false);
  await runtime.callBridge('addFragment', singleAtomSmiles(seedAtom.element));
  const after = await runtime.getState(false);
  atomIdMap[seedIntentId] = newAtomId(before, after);

  for (let i = 1; i < order.length; i++) {
    const curId = order[i];
    const curAtom = atomById.get(curId)!;
    const anchorEdge = comp.bonds.find((bond) => {
      const involvesCur = bond.a === curId || bond.b === curId;
      if (!involvesCur) return false;
      const otherEnd = bond.a === curId ? bond.b : bond.a;
      return atomIdMap[otherEnd] !== undefined;
    });
    if (!anchorEdge) {
      throw new BuildFromGraphError('translator_failed', {
        step: 'walk_outward',
        message: `no anchor edge found for atom id ${curId}`,
      });
    }
    const anchorIntentId = anchorEdge.a === curId ? anchorEdge.b : anchorEdge.a;
    const anchorMappedId = atomIdMap[anchorIntentId];
    const res = await runtime.callBridge<{
      beginAtomId: number;
      endAtomId: number;
      bondId: number;
    }>('addAtomWithSingleBond', anchorMappedId, curAtom.element);
    atomIdMap[curId] = res.endAtomId;
    bondIdMap[edgeKey(anchorEdge.a, anchorEdge.b)] = res.bondId;
  }

  for (const bond of comp.bonds) {
    if (edgeKey(bond.a, bond.b) in bondIdMap) continue;
    const res = await runtime.callBridge<{
      beginAtomId: number;
      endAtomId: number;
      bondId: number;
    }>('addBond', atomIdMap[bond.a], atomIdMap[bond.b], 1);
    bondIdMap[edgeKey(bond.a, bond.b)] = res.bondId;
  }
}

export { HALOGEN_ELEMENTS };
