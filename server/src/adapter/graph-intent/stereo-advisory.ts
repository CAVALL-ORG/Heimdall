/**
 * Dense-gated stereocenter WARNING advisory (decision: hybrid B+C, primary
 * channel = build response; backed by the dense-stereo investigation and the
 * faithfulness experiment outputs/dense-stereo-replay/EXPERIMENT-F-FAITHFULNESS).
 *
 * The build ALREADY runs the exact perception that enumerates the dropped
 * centers (`assertNoUndefinedStereoPostBuild` in translator.ts: Indigo
 * `indigoCheckStereocenters` on the post-build molfile, mapped 0-based idx →
 * canvasId → intentId). That assert THROWS only on UNACCOUNTED centers; every
 * center the agent punted with an explicit `stereo_unknown` skip is silently
 * accepted, so the agent never learns which centers Indigo still sees as
 * undefined. This advisory surfaces exactly that perceived-undefined-AND-skipped
 * set as a per-center crop worklist — driving the EXISTING legacy
 * `bond.wedge` + `wedge_from` + coords path. It rides the build response `data`
 * (and, lagged-by-one, the next validate round via the sidecar). It is purely
 * additive: WARNING severity, NEVER flips `ok`, NEVER throws, and is suppressed
 * on sparse (non-dense) drafts so fast-on-easy stays byte-identical.
 *
 * This helper is a pure mapper: it receives the already-computed perceived
 * intent-id set (the assert hands it in) and the graph, so it calls neither
 * Indigo nor the runtime and adds zero build cost.
 */

import type { GraphIntent } from '../../types/graph-intent';
import { isDenseDraft } from './dense-signal';

export interface StereoAdvisory {
  severity: 'warning';
  record_id: 'graph';
  field: 'stereoTransfer';
  code: 'undefined_stereocenter_advisory';
  note: string;
  /** Machine-readable per-center worklist, in GraphIntent intent-id space. */
  centerIntentIds: number[];
}

/**
 * Build the dense-gated stereocenter advisory. Returns `null` (no advisory) on:
 *   - a sparse draft (`isDenseDraft` false — fast-on-easy guarantee; I001/I015
 *     never see this even if a stray perceived id were passed in),
 *   - an empty perceived set (A004pass — every center already wedged),
 *   - Indigo-unavailable (the caller passes `[]`, inheriting the assert's
 *     graceful try/catch).
 *
 * NEVER throws; NEVER flips `ok` (it carries `severity: 'warning'` only).
 *
 * @param graph the GraphIntent that was built (read for the dense gate only).
 * @param perceivedUndefinedIntentIds intent-id-space atoms Indigo still
 *   perceives as undefined stereocenters after build, as computed by
 *   `assertNoUndefinedStereoPostBuild` from the SAME molfile the build
 *   exported (no new Indigo round).
 */
export function buildStereoAdvisory(
  graph: GraphIntent,
  perceivedUndefinedIntentIds: number[],
): StereoAdvisory | null {
  const dense = isDenseDraft({
    atoms: graph.atoms ?? [],
    rings: (graph.rings ?? []) as { atoms: number[] }[],
  });
  if (!dense) return null;
  const ids = [...new Set(perceivedUndefinedIntentIds)].sort((a, b) => a - b);
  if (ids.length === 0) return null;
  return {
    severity: 'warning',
    record_id: 'graph',
    field: 'stereoTransfer',
    code: 'undefined_stereocenter_advisory',
    centerIntentIds: ids,
    note:
      `backend perceives ${ids.length} stereocenter(s) still undefined after build ` +
      `(atom id${ids.length > 1 ? 's' : ''} ${ids.join(', ')} in your GraphIntent). ` +
      'These are NOT yet covered by a wedge. For EACH: crop the source tight on that ' +
      'atom + its drawn neighbors + the wedge stroke, read the stroke polarity, and add ' +
      'a bond.wedge (solid/hashed) + bond.wedge_from on that center with its cluster coords. ' +
      'If a center is genuinely unreadable after zoom, leave its stereo_unknown skip in place. ' +
      '(Advisory — does not block build or export.)',
  };
}

/**
 * Fusion-methyl wedge re-check advisory (2026-06-04, A011 atom10 lever).
 *
 * A011's one recurring residual is the B/C-fusion CH3 methyl whose HASHED wedge
 * is misread as SOLID (~25% of runs; the compressed dashes of a hashed wedge to
 * a short methyl stub mimic a filled triangle). The center is structurally
 * indistinguishable from A004's correctly-read angular methyl (both: terminal-C
 * methyl on a ring-fusion quaternary), so NO graph-structural trigger is
 * floor-safe-by-construction — this advisory DOES fire on the A004 floor too
 * (documented; A004-hold is the ratchet gate, not a construction guarantee).
 * It is purely additive: WARNING, NEVER flips `ok`, NEVER throws, NEVER mutates
 * the build → SMILES is byte-identical. Dense-gated so simple drafts stay clean.
 *
 * The narrowing it CAN do safely: fire only when the methyl's parent lies on a
 * ring fusion (>= 2 declared rings). That skips A011's other methyl (atom3,
 * single-ring, read correctly every rep) — keeping the obligation to exactly the
 * at-risk center, the lightest possible attention load.
 */
export interface MethylWedgeRecheckAdvisory {
  severity: 'warning';
  record_id: 'graph';
  field: 'stereoTransfer';
  code: 'fusion_methyl_wedge_recheck';
  note: string;
  /** Parent (wedge_from) carbon ids carrying a fusion-methyl wedge. */
  centerIntentIds: number[];
}

interface MWAtom {
  id: number;
  element?: string;
  label?: string;
  shorthand?: string;
}
interface MWBond {
  a: number;
  b: number;
  wedge?: 'solid' | 'hashed' | null;
  wedge_from?: number | null;
}
interface MWGraph {
  atoms?: MWAtom[];
  bonds?: MWBond[];
  rings?: { atoms: number[] }[];
}

/**
 * Pure detector. Returns the parent carbon ids of every wedge drawn to a
 * TERMINAL methyl carbon whose parent lies on a ring fusion (>= 2 declared
 * rings). No coordinates, no pixels, no Indigo. Fires on both polarities
 * (the failure is a solid-misdeclaration, so a hashed-only filter would miss it).
 */
export function detectFusionMethylWedges(graph: MWGraph): number[] {
  const atoms = graph.atoms ?? [];
  const bonds = graph.bonds ?? [];
  const rings = graph.rings ?? [];
  const elOf = new Map<number, string>(
    atoms.map((a) => [a.id, a.shorthand ? '' : a.element ?? a.label ?? 'C']),
  );
  const degree = new Map<number, number>();
  for (const b of bonds) {
    degree.set(b.a, (degree.get(b.a) ?? 0) + 1);
    degree.set(b.b, (degree.get(b.b) ?? 0) + 1);
  }
  const ringCount = (id: number) =>
    rings.reduce((n, r) => (r.atoms?.includes(id) ? n + 1 : n), 0);

  const out = new Set<number>();
  for (const b of bonds) {
    if (!b.wedge) continue;
    const center = b.wedge_from ?? b.a;
    const target = center === b.a ? b.b : b.a;
    // target must be a terminal (degree-1) carbon methyl …
    if ((degree.get(target) ?? 0) !== 1) continue;
    if (elOf.get(target) !== 'C') continue;
    // … and the parent must sit on a ring fusion (>= 2 declared rings).
    if (ringCount(center) >= 2) out.add(center);
  }
  return [...out].sort((x, y) => x - y);
}

/**
 * Dense-gated, non-mutating WARNING advisory built from
 * {@link detectFusionMethylWedges}. null on sparse drafts (fast-on-easy
 * byte-identical) or when no fusion-methyl wedge is present.
 */
export function buildMethylWedgeAdvisory(
  graph: GraphIntent,
): MethylWedgeRecheckAdvisory | null {
  const dense = isDenseDraft({
    atoms: graph.atoms ?? [],
    rings: (graph.rings ?? []) as { atoms: number[] }[],
  });
  if (!dense) return null;
  const ids = detectFusionMethylWedges(graph as MWGraph);
  if (ids.length === 0) return null;
  return {
    severity: 'warning',
    record_id: 'graph',
    field: 'stereoTransfer',
    code: 'fusion_methyl_wedge_recheck',
    centerIntentIds: ids,
    note:
      `you drew a wedge to a methyl on a ring-fusion carbon (atom id${ids.length > 1 ? 's' : ''} ${ids.join(', ')}). ` +
      'A HASHED wedge to a short methyl stub is easily misread as a SOLID wedge ' +
      '(the compressed dashes look like a filled triangle). Re-look at ONLY that ' +
      'one methyl wedge stroke in isolation and commit what you see: parallel dash ' +
      'lines = hashed, a solid filled triangle = solid. Do not re-examine anything ' +
      'else. (Advisory — does not block build or export.)',
  };
}
