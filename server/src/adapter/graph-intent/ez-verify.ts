/**
 * Build-time E/Z verification of declared `bond.geom` double bonds.
 *
 * Role split (CLAUDE.md "agent transcribes, backend interprets"): the agent
 * declares a double bond's drawn geometry as `geom: 'cis' | 'trans'` — the
 * visual same-side / opposite-side reading of the two substituents across the
 * double bond (compiled from a worksheet `double_parallel` segment's `geom`
 * / `geom_refs`, or supplied directly on an `IntentBond`). That field is
 * AGENT INTENT METADATA only: the translator pins the agent's coordinates but
 * never pushes a V2000 cis/trans flag (setBondStereo(CIS_TRANS=3) corrupts
 * Indigo's SMILES writer — see translator.ts bond.geom comment). Nothing else
 * in the build path checked that the BUILT canvas geometry actually agrees
 * with the declared label.
 *
 * This module supplies that check. After the canvas is built, Indigo perceives
 * each double bond's actual E/Z directly from the post-build coordinates
 * (`indigo/convert` with `molfile-saving-add-stereo-desc`, which emits an
 * `INDIGO_CIP_DESC` SGROUP naming the bond's two atoms with FIELDDATA `(E)` /
 * `(Z)`). We compare that perception against the declared label under the
 * standard disubstituted-alkene correspondence `cis ≡ Z`, `trans ≡ E`, and on
 * disagreement emit an ADVISORY diagnostic. The build NEVER rewrites the
 * agent's geometry on a mismatch — like `summarizeStereoLossDiagnostics`, this
 * is an observability surface the agent can act on (re-zoom the double bond).
 *
 * Why advisory, not authoritative: E/Z is CIP-priority based; the agent's
 * cis/trans is reference-neighbor based. For the common alkene where the drawn
 * reference substituents ARE the CIP-priority groups the two coincide exactly;
 * where they diverge (a higher-priority substituent hidden behind an implicit
 * H, say) the mapping is a heuristic. Surfacing it as a diagnostic — never a
 * silent canvas rewrite, never a hard build failure — keeps the agent's
 * transcription authoritative while still catching the common "label
 * contradicts the geometry I drew" slip.
 *
 * This replaces the one real function the now-deleted render-diff layer ever
 * performed: render-diff was the ONLY surface that ever inspected double-bond
 * E/Z configuration (via a vision-judge over a rasterized canvas), and it was
 * shown to endorse wrong topology. Indigo coordinate perception is exact for
 * the E/Z question and needs no rasterization.
 *
 * Indigo runs as the same Docker service the rest of the stereo pipeline uses
 * (KETCHER_REMOTE_API_PATH, default http://127.0.0.1:8002/v2/). When Indigo is
 * unreachable the perception call throws; the translator catches it and emits
 * NO diagnostic (skip-closed — never a false green), mirroring the Mode C
 * gating in indigo-stereo.ts consumers.
 */

import { edgeKey, type GraphIntent } from '../../types/graph-intent';

const DEFAULT_REMOTE = 'http://127.0.0.1:8002/v2/';

function remoteBase(): string {
  return process.env.KETCHER_REMOTE_API_PATH ?? DEFAULT_REMOTE;
}

/**
 * Perceived double-bond stereo descriptor. Keyed by the molfile (1-based)
 * atom-index edge of the double bond, value is Indigo's CIP E/Z perception.
 */
export type PerceivedEZ = 'E' | 'Z';

/**
 * One per declared-`geom` double bond that went through verification.
 * `declared` is the agent's `cis` / `trans`; `expectedEZ` is its
 * cis→Z / trans→E mapping; `perceivedEZ` is Indigo's CIP perception on the
 * post-build canvas (null when Indigo did not emit a descriptor for this
 * bond — e.g. the bond is not actually stereogenic, or both substituents on
 * one end are identical). `match` is true iff perceivedEZ === expectedEZ.
 *
 * Exposed so the translator can attach the raw records to its build result
 * for unit-test inspection (mirrors the `modeC` forensic-record surface).
 */
export type GeomVerificationRecord = {
  /** GraphIntent endpoint a of the double bond. */
  intentA: number;
  /** GraphIntent endpoint b of the double bond. */
  intentB: number;
  declared: 'cis' | 'trans';
  expectedEZ: PerceivedEZ;
  perceivedEZ: PerceivedEZ | null;
  match: boolean;
};

/** One advisory diagnostic per declared-geom double bond whose perceived
 * E/Z contradicts the declared cis/trans. The agent can re-zoom the named
 * bond. `reason` is human-readable; no chemistry-naming language required. */
export type GeomMismatchDiagnostic = {
  bondAtomIds: [number, number];
  declared: 'cis' | 'trans';
  perceivedEZ: PerceivedEZ;
  reason: string;
};

async function postJSON(path: string, body: unknown): Promise<unknown> {
  const url = remoteBase() + path;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Indigo ${path} failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Indigo ${path} response was not JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Parse a V3000 molfile's double-bond E/Z descriptors. Indigo writes
 * `INDIGO_CIP_DESC` SGROUP DAT records for stereo features when
 * `molfile-saving-add-stereo-desc` is on. A record whose `ATOMS=(N ...)` lists
 * exactly TWO atoms is a BOND descriptor (the double bond's two atoms) with
 * FIELDDATA `(E)` / `(Z)`; a record listing ONE atom is a tetrahedral CIP
 * descriptor `(R)` / `(S)` (parsed elsewhere by `parseCIPSGroups`). We pick
 * out only the two-atom E/Z records here.
 *
 * Returns a map keyed by `edgeKey(molfileIdxA, molfileIdxB)` (molfile 1-based
 * atom indices, order-independent) so the caller can look up the perceived
 * E/Z for a bond by its endpoint indices.
 *
 * Public for unit testing.
 */
export function parseEZDescriptors(v3000: string): Map<string, PerceivedEZ> {
  const out = new Map<string, PerceivedEZ>();
  // SGROUP DAT records can wrap across lines via the `-\n` continuation
  // convention. Join continuations first (same handling as parseCIPSGroups).
  const joined = v3000.replace(/-\r?\nM  V30\s*/g, '');
  // ATOMS=(2 <a> <b>) ... FIELDNAME=INDIGO_CIP_DESC ... FIELDDATA="(E)"|"(Z)"
  // The leading count token (`2`) followed by exactly two atom ids marks a
  // bond descriptor. `[^\n]*?` after the two ids tolerates the FIELDDISP block
  // without greedily swallowing into the next record's line.
  const re =
    /ATOMS=\(\s*2\s+(\d+)\s+(\d+)\s*\)[^\n]*?FIELDNAME=INDIGO_CIP_DESC[^\n]*?FIELDDATA="\(([EZ])\)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(joined)) !== null) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const ez = m[3] as PerceivedEZ;
    if (Number.isFinite(a) && Number.isFinite(b)) {
      out.set(edgeKey(a, b), ez);
    }
  }
  return out;
}

/**
 * Ask Indigo to perceive every double bond's E/Z from the molfile's 2-D
 * coordinates. Returns a map keyed by `edgeKey(molfileIdxA, molfileIdxB)`
 * (1-based). Throws when Indigo is unreachable or returns a non-molfile
 * payload — callers (translator) MUST catch and skip-closed (emit no
 * diagnostic) so an Indigo outage never produces a false green.
 */
export async function indigoPerceiveDoubleBondEZ(
  molfile: string,
): Promise<Map<string, PerceivedEZ>> {
  const result = await postJSON('indigo/convert', {
    struct: molfile,
    input_format: 'chemical/x-mdl-molfile',
    output_format: 'chemical/x-mdl-molfile',
    options: {
      'molfile-saving-mode': '3000',
      'molfile-saving-add-stereo-desc': '1',
    },
  });
  const struct = (result as Record<string, unknown>).struct;
  if (typeof struct !== 'string') {
    throw new Error('Indigo convert returned no molfile struct for E/Z perception');
  }
  return parseEZDescriptors(struct);
}

/** cis is the same-side reading → Z; trans is opposite-side → E. */
export function expectedEZForDeclared(declared: 'cis' | 'trans'): PerceivedEZ {
  return declared === 'cis' ? 'Z' : 'E';
}

/**
 * Pure comparison of declared `bond.geom` against Indigo-perceived E/Z.
 *
 * For every bond in `graph` carrying a non-null `geom`, map its GraphIntent
 * endpoints → canvas ids (`atomIdMap`) → molfile 1-based indices
 * (`canvasIdToMolfile1Based`), look up the perceived E/Z by that edge, and
 * compare against `expectedEZForDeclared(geom)`.
 *
 * Returns BOTH the full per-bond forensic records (every verified geom bond,
 * including matches and bonds Indigo did not describe) AND the advisory
 * mismatch diagnostics (only bonds where a perceived E/Z contradicts the
 * declared label). A bond with no perceived descriptor contributes a record
 * with `perceivedEZ: null` and no diagnostic: absence of an Indigo descriptor
 * is NOT treated as a contradiction (the bond may be genuinely non-stereogenic
 * — both substituents identical on one end), so it is skip-closed rather than
 * flagged.
 *
 * No canvas / runtime / Indigo interaction — caller supplies the perceived
 * map. No mutation of inputs.
 */
export function verifyDeclaredGeom(args: {
  graph: GraphIntent;
  atomIdMap: Record<number, number>;
  canvasIdToMolfile1Based: Map<number, number>;
  perceivedEZByMolfileEdge: Map<string, PerceivedEZ>;
}): {
  records: GeomVerificationRecord[];
  diagnostics: GeomMismatchDiagnostic[];
} {
  const { graph, atomIdMap, canvasIdToMolfile1Based, perceivedEZByMolfileEdge } =
    args;
  const records: GeomVerificationRecord[] = [];
  const diagnostics: GeomMismatchDiagnostic[] = [];

  for (const bond of graph.bonds) {
    if (bond.geom !== 'cis' && bond.geom !== 'trans') continue;
    const declared = bond.geom;
    const expectedEZ = expectedEZForDeclared(declared);

    const canvasA = atomIdMap[bond.a];
    const canvasB = atomIdMap[bond.b];
    const molA =
      canvasA !== undefined ? canvasIdToMolfile1Based.get(canvasA) : undefined;
    const molB =
      canvasB !== undefined ? canvasIdToMolfile1Based.get(canvasB) : undefined;

    const perceivedEZ =
      molA !== undefined && molB !== undefined
        ? perceivedEZByMolfileEdge.get(edgeKey(molA, molB)) ?? null
        : null;

    const match = perceivedEZ !== null && perceivedEZ === expectedEZ;
    records.push({
      intentA: bond.a,
      intentB: bond.b,
      declared,
      expectedEZ,
      perceivedEZ,
      match,
    });

    // Diagnostic ONLY on a genuine contradiction: Indigo perceived a definite
    // E/Z and it disagrees with the declared label. A null perception is
    // skip-closed (non-stereogenic / undescribed bond), never a false flag.
    if (perceivedEZ !== null && perceivedEZ !== expectedEZ) {
      diagnostics.push({
        bondAtomIds: [bond.a, bond.b],
        declared,
        perceivedEZ,
        reason: `declared ${declared} (expects ${expectedEZ}) but built-canvas geometry perceives ${perceivedEZ}`,
      });
    }
  }

  return { records, diagnostics };
}
