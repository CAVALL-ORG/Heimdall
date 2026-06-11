import { execFile } from 'node:child_process';

export type IndigoMode = 'standalone' | 'remote';
export interface IndigoResolution {
  mode: IndigoMode;
  degraded: boolean; // true => exports carry the "stereo/canonical degraded" advisory
  probed: boolean;
}

/** Interpreter to probe/run Indigo with: $HEIMDALL_PYTHON, else `python3`. */
export function indigoPython(): string {
  return process.env.HEIMDALL_PYTHON || 'python3';
}

/** Returns true iff `<indigoPython> -c "import epam.indigo"` exits 0. */
export function probeIndigoImportable(): Promise<boolean> {
  return new Promise((res) => {
    execFile(indigoPython(), ['-c', 'import epam.indigo'], (err) => res(!err));
  });
}

/**
 * Decide the runtime mode from the WHEEL probe. `requested` is KETCHER_AGENT_MODE
 * (or 'auto'). `probe` is injected for testability; defaults to the real check.
 * NOTE: this only knows about the local epam.indigo wheel (source B). The server
 * composes this with isRemoteApiReachable (source A) — see the wiring step.
 */
export async function resolveIndigoMode(
  requested: string | undefined,
  probe: () => Promise<boolean> = probeIndigoImportable,
): Promise<IndigoResolution> {
  if (requested === 'remote') return { mode: 'remote', degraded: false, probed: false };
  if (requested === 'standalone') return { mode: 'standalone', degraded: true, probed: false };
  // 'auto' or unset
  const ok = await probe();
  return ok
    ? { mode: 'remote', degraded: false, probed: true }
    : { mode: 'standalone', degraded: true, probed: true };
}

export const INDIGO_DEGRADE_ADVISORY =
  'stereo/canonical degraded — Indigo not detected; SMILES is non-canonical and '
  + 'CIP/wedge stereo may be unresolved. See README to enable the Indigo shim.';
