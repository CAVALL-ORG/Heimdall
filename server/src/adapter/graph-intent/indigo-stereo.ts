/**
 * Indigo HTTP helpers for stereo perception + CIP labeling. Used by the
 * translator's R/S-direct solver (handoff-rs-direct §B) and by the Fix 1
 * enumerate-and-require validator (handoff-step0-and-completeness §B).
 *
 * Indigo runs as a Docker service (epmlsop/indigo-service) reachable at
 * KETCHER_REMOTE_API_PATH (default http://127.0.0.1:8002/v2/). When the env
 * var is unset and the default is unreachable, callers must catch the
 * thrown error and either fall back (Fix 1) or surface a build error
 * (R/S solver).
 *
 * Two operations:
 *
 *   indigoCheckStereocenters(molfile) → number[]  (1-based atom ids of
 *     atoms perceived as POTENTIAL stereocenters by Indigo. Empty when no
 *     undefined stereocenters exist or the molfile already has wedges on
 *     every potential center.)
 *
 *   indigoComputeCIPLabels(molfile) → Map<number, 'R' | 'S'>  (per-atom
 *     R/S labels for atoms with a fully-defined wedge configuration.
 *     Atom ids are 1-based — same indexing as the V2000 input.)
 *
 * Both go through Indigo `/indigo/convert` or `/indigo/check`. No browser
 * round-trip; callable from Node (translator) via the built-in fetch.
 */

const DEFAULT_REMOTE = 'http://127.0.0.1:8002/v2/';

function remoteBase(): string {
  return process.env.KETCHER_REMOTE_API_PATH ?? DEFAULT_REMOTE;
}

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
 * Returns the 0-based atom indices of all atoms Indigo identifies as
 * stereocenters with UNDEFINED stereo configuration in the given molfile.
 * For a wedge-bearing molfile the list is empty; for a flat molfile, every
 * topological stereocenter (tetrahedral, 4 distinct neighbors) appears.
 *
 * Indigo uses 0-based atom indices in its check messages (verified
 * empirically against `CC(N)C(=O)O` → "(1)" and `C(C)(N)C(=O)O` → "(0)"
 * on indigo-service v1.43). Callers convert to molfile (1-based) ids by
 * adding 1, or look up canvas ids by indexing into the state atom array.
 *
 * Sample response when stereo is missing:
 *   {"stereo":"Structure contains stereocenters with undefined stereo
 *    configuration: (1,3,7,12)"}
 */
export async function indigoCheckStereocenters(molfile: string): Promise<number[]> {
  const result = await postJSON('indigo/check', {
    struct: molfile,
    input_format: 'chemical/x-mdl-molfile',
    types: ['stereo'],
  });
  if (typeof result !== 'object' || result === null) return [];
  const msg = (result as Record<string, unknown>).stereo;
  if (typeof msg !== 'string') return [];
  const match = msg.match(/\(([\d,\s]+)\)/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

/**
 * Returns per-atom CIP labels (R/S) for all atoms in the molfile with a
 * fully-defined stereo configuration. Atom ids are 1-based, matching the
 * V2000 input. Atoms without stereo (or ambiguous '?') are simply absent
 * from the returned map.
 *
 * Indigo emits CIP descriptors via SGROUP DAT records when the
 * `molfile-saving-add-stereo-desc` option is on. Each record carries
 * `ATOMS=(1 N)` (where N is the 1-based atom id) and
 * `FIELDDATA="(R)"` / `"(S)"`.
 */
export async function indigoComputeCIPLabels(
  molfile: string,
): Promise<Map<number, 'R' | 'S'>> {
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
  if (typeof struct !== 'string') return new Map();
  return parseCIPSGroups(struct);
}

/** Public for testing. Parses a V3000 molfile's INDIGO_CIP_DESC SGROUPs. */
export function parseCIPSGroups(v3000: string): Map<number, 'R' | 'S'> {
  const out = new Map<number, 'R' | 'S'>();
  // SGROUP DAT records can span multiple lines via the `-\n` continuation
  // convention. Join continuations first.
  const joined = v3000.replace(/-\nM  V30\s*/g, '');
  const re = /ATOMS=\(\s*\d+\s+(\d+)\s*\)\s+FIELDNAME=INDIGO_CIP_DESC.*?FIELDDATA="\(([RS])\)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(joined)) !== null) {
    const atomId = parseInt(m[1], 10);
    const cip = m[2] as 'R' | 'S';
    if (Number.isFinite(atomId)) {
      out.set(atomId, cip);
    }
  }
  return out;
}
