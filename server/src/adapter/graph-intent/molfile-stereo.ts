/**
 * Pure V2000 molfile stereo manipulation. Ported from
 * `outputs/a004-option1-fixture/scripts/gate3e-direct-molfile.py` — the
 * research prototype that validated 84/84 stereocenter recovery across 13
 * drug-class molecules including paclitaxel (A004) at 11/11.
 *
 * Why direct molfile manipulation instead of `setWedgeBond`. When two adjacent
 * chiral centers each have a wedge applied via the Ketcher API, the second
 * `setWedgeBond` rebuilds the bond, which can overwrite or conflict with the
 * first. RDKit / Indigo readers detect the conflict and drop one stereo
 * assignment to '?'. Bypassing the API and modifying V2000 bond stereo flags
 * directly side-steps the conflict (the file is read in one pass).
 *
 * V2000 bond stereo flag values used here:
 *   0 — no stereo
 *   1 — UP (solid wedge from a1 to a2)
 *   6 — DOWN (hashed wedge from a1 to a2)
 */

export type ParsedMolfile = {
  headerLines: string[];
  atomLines: string[];
  bondRecords: BondRecord[];
  footerLines: string[];
  nAtoms: number;
  nBonds: number;
};

export type BondRecord = {
  a1: number;
  a2: number;
  order: number;
  stereo: number;
  raw: string;
};

const COUNTS_LINE_INDEX = 3;

export function parseV2000(mb: string): ParsedMolfile {
  const lines = mb.split(/\r?\n/);
  if (lines.length < 5) {
    throw new Error('V2000 molfile shorter than 5 lines');
  }
  const counts = lines[COUNTS_LINE_INDEX];
  const nAtoms = parseInt(counts.slice(0, 3).trim(), 10);
  const nBonds = parseInt(counts.slice(3, 6).trim(), 10);
  if (!Number.isFinite(nAtoms) || !Number.isFinite(nBonds)) {
    throw new Error(`V2000 counts line unparseable: "${counts}"`);
  }
  const atomLines = lines.slice(4, 4 + nAtoms);
  const bondLines = lines.slice(4 + nAtoms, 4 + nAtoms + nBonds);
  const bondRecords: BondRecord[] = bondLines.map((bl) => ({
    a1: parseInt(bl.slice(0, 3).trim(), 10),
    a2: parseInt(bl.slice(3, 6).trim(), 10),
    order: parseInt(bl.slice(6, 9).trim(), 10),
    stereo: parseInt(bl.slice(9, 12).trim() || '0', 10),
    raw: bl,
  }));
  return {
    headerLines: lines.slice(0, 4),
    atomLines,
    bondRecords,
    footerLines: lines.slice(4 + nAtoms + nBonds),
    nAtoms,
    nBonds,
  };
}

export function writeV2000(parsed: ParsedMolfile): string {
  const bondLines = parsed.bondRecords.map((r) => {
    const a1 = pad3(r.a1);
    const a2 = pad3(r.a2);
    const order = pad3(r.order);
    const stereo = pad3(r.stereo);
    // Preserve any suffix bytes (the molfile bond line has additional fixed
    // columns past the first 12 for query bond / reacting center / etc.).
    const suffix = r.raw.length > 12 ? r.raw.slice(12) : '';
    return `${a1}${a2}${order}${stereo}${suffix}`;
  });
  return [
    ...parsed.headerLines,
    ...parsed.atomLines,
    ...bondLines,
    ...parsed.footerLines,
  ].join('\n');
}

/**
 * Set the V2000 counts-line chiral flag. Ketcher interprets wedge-bearing
 * molfiles with flag=0 as enhanced AND stereo; flag=1 marks the centers as
 * absolute so SMILES export emits fixed per-center stereochemistry.
 */
export function setV2000ChiralFlag(parsed: ParsedMolfile, enabled = true): void {
  const counts = parsed.headerLines[COUNTS_LINE_INDEX] ?? '';
  const padded = counts.padEnd(15, ' ');
  parsed.headerLines[COUNTS_LINE_INDEX] =
    `${padded.slice(0, 12)}${enabled ? '  1' : '  0'}${padded.slice(15)}`;
}

function pad3(n: number): string {
  return String(n).padStart(3, ' ');
}

export function findBondIndex(
  parsed: ParsedMolfile,
  a1: number,
  a2: number,
): number | null {
  for (let i = 0; i < parsed.bondRecords.length; i++) {
    const r = parsed.bondRecords[i];
    if ((r.a1 === a1 && r.a2 === a2) || (r.a1 === a2 && r.a2 === a1)) {
      return i;
    }
  }
  return null;
}

/** Set wedge on bond between chiral (1-based) and neighbor. Ensures chiral
 * atom is the begin (a1) — swaps if needed. solid=1, hashed=6. Returns true
 * if the bond was found and updated. */
export function setWedge(
  parsed: ParsedMolfile,
  chiral1Based: number,
  nbr1Based: number,
  kind: 'solid' | 'hashed',
): boolean {
  const i = findBondIndex(parsed, chiral1Based, nbr1Based);
  if (i === null) return false;
  const r = parsed.bondRecords[i];
  if (r.a1 !== chiral1Based) {
    r.a1 = chiral1Based;
    r.a2 = nbr1Based;
  }
  r.stereo = kind === 'solid' ? 1 : 6;
  return true;
}

/** Strip every wedge bond in the parsed molfile (set stereo=0 on UP/DOWN). */
export function stripWedges(parsed: ParsedMolfile): void {
  for (const r of parsed.bondRecords) {
    if (r.stereo === 1 || r.stereo === 6) {
      r.stereo = 0;
    }
  }
}

/** Heavy (non-H) neighbors of a 1-based atom id, reading from the bond table.
 * Returns 1-based neighbor ids. The atomLines pass provides the element so
 * we can filter explicit Hs. */
export function heavyNeighbors(
  parsed: ParsedMolfile,
  center1Based: number,
): number[] {
  const elementOf = (a1Based: number) => {
    const line = parsed.atomLines[a1Based - 1] ?? '';
    return line.slice(31, 34).trim();
  };
  const nbrs: number[] = [];
  for (const b of parsed.bondRecords) {
    let n: number | null = null;
    if (b.a1 === center1Based) n = b.a2;
    else if (b.a2 === center1Based) n = b.a1;
    if (n === null) continue;
    if (elementOf(n) === 'H') continue;
    nbrs.push(n);
  }
  return nbrs;
}
