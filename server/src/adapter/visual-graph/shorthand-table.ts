/**
 * LOCK 11 — deterministic shorthand glyph decomposition table.
 *
 * Agent captures shorthand glyphs (`Me`, `OMe`, `Ph`, `Bn`, `Boc`, ...) as
 * RAW TEXT on a glyph node. Backend decomposes via this table at compile
 * time. Unknown shorthand → validate_graph returns `unknown_shorthand`
 * error; agent must zoom and re-emit explicit atoms or refuse with
 * `unknown_shorthand` (LOCK 21).
 *
 * Agent-side decomposition is forbidden (LOCK 11).
 *
 * Each entry returns either { atoms, bonds, attachment_atom_offset } —
 * the decomposed local subgraph plus the index of the atom that attaches
 * to the parent (anchor) atom — or { unknown: true } for unrecognized text.
 *
 * Atom ids in the returned subgraph are LOCAL (0-indexed). The compiler
 * remaps them to global atom ids during compilation.
 *
 * Pure function. No I/O. No Ketcher. No Indigo.
 */
import { KNOWN_ELEMENT_SYMBOLS } from '../../types/graph-intent';

export type ShorthandAtom = {
  element: string;
  drawn_H?: number;
  /** LOCK 23: nuclear mass number for isotope-labeled atoms (¹³C → 13). */
  isotope?: number;
};

export type ShorthandBond = {
  a: number;
  b: number;
  order: 1 | 2 | 3;
};

export type ShorthandSubgraph = {
  atoms: ShorthandAtom[];
  bonds: ShorthandBond[];
  /** Index in `atoms` of the atom that attaches to the parent (anchor). */
  attachment_atom_offset: number;
};

export type ShorthandDecompositionResult =
  | { unknown: true }
  | ({ unknown: false } & ShorthandSubgraph);

const TABLE: Record<string, ShorthandSubgraph> = {
  // ── Alkyl groups ────────────────────────────────────────────────────
  Me:   { atoms: [{ element: 'C', drawn_H: 3 }], bonds: [], attachment_atom_offset: 0 },
  Et:   { atoms: [{ element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 3 }],
          bonds: [{ a: 0, b: 1, order: 1 }], attachment_atom_offset: 0 },
  nPr:  { atoms: [{ element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 3 }],
          bonds: [{ a: 0, b: 1, order: 1 }, { a: 1, b: 2, order: 1 }], attachment_atom_offset: 0 },
  Pr:   { atoms: [{ element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 3 }],
          bonds: [{ a: 0, b: 1, order: 1 }, { a: 1, b: 2, order: 1 }], attachment_atom_offset: 0 },
  iPr:  { atoms: [{ element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 3 }, { element: 'C', drawn_H: 3 }],
          bonds: [{ a: 0, b: 1, order: 1 }, { a: 0, b: 2, order: 1 }], attachment_atom_offset: 0 },
  nBu:  { atoms: [
            { element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 2 },
            { element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 3 },
          ], bonds: [{ a: 0, b: 1, order: 1 }, { a: 1, b: 2, order: 1 }, { a: 2, b: 3, order: 1 }],
          attachment_atom_offset: 0 },
  Bu:   { atoms: [
            { element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 2 },
            { element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 3 },
          ], bonds: [{ a: 0, b: 1, order: 1 }, { a: 1, b: 2, order: 1 }, { a: 2, b: 3, order: 1 }],
          attachment_atom_offset: 0 },
  sBu:  { atoms: [
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 3 },
            { element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 3 },
          ], bonds: [{ a: 0, b: 1, order: 1 }, { a: 0, b: 2, order: 1 }, { a: 2, b: 3, order: 1 }],
          attachment_atom_offset: 0 },
  iBu:  { atoms: [
            { element: 'C', drawn_H: 2 }, // CH2, attachment
            { element: 'C', drawn_H: 1 }, // CH
            { element: 'C', drawn_H: 3 }, // CH3
            { element: 'C', drawn_H: 3 }, // CH3
          ], bonds: [{ a: 0, b: 1, order: 1 }, { a: 1, b: 2, order: 1 }, { a: 1, b: 3, order: 1 }],
          attachment_atom_offset: 0 },
  tBu:  { atoms: [
            { element: 'C', drawn_H: 0 }, { element: 'C', drawn_H: 3 },
            { element: 'C', drawn_H: 3 }, { element: 'C', drawn_H: 3 },
          ], bonds: [{ a: 0, b: 1, order: 1 }, { a: 0, b: 2, order: 1 }, { a: 0, b: 3, order: 1 }],
          attachment_atom_offset: 0 },
  // ── Oxy groups (O-X) ────────────────────────────────────────────────
  OMe:  { atoms: [{ element: 'O' }, { element: 'C', drawn_H: 3 }],
          bonds: [{ a: 0, b: 1, order: 1 }], attachment_atom_offset: 0 },
  OEt:  { atoms: [{ element: 'O' }, { element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 3 }],
          bonds: [{ a: 0, b: 1, order: 1 }, { a: 1, b: 2, order: 1 }], attachment_atom_offset: 0 },
  OiPr: { atoms: [{ element: 'O' }, { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 3 }, { element: 'C', drawn_H: 3 }],
          bonds: [{ a: 0, b: 1, order: 1 }, { a: 1, b: 2, order: 1 }, { a: 1, b: 3, order: 1 }],
          attachment_atom_offset: 0 },
  OBu:  { atoms: [{ element: 'O' }, { element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 3 }],
          bonds: [{ a: 0, b: 1, order: 1 }, { a: 1, b: 2, order: 1 }, { a: 2, b: 3, order: 1 }, { a: 3, b: 4, order: 1 }],
          attachment_atom_offset: 0 },
  OtBu: { atoms: [{ element: 'O' }, { element: 'C', drawn_H: 0 }, { element: 'C', drawn_H: 3 }, { element: 'C', drawn_H: 3 }, { element: 'C', drawn_H: 3 }],
          bonds: [{ a: 0, b: 1, order: 1 }, { a: 1, b: 2, order: 1 }, { a: 1, b: 3, order: 1 }, { a: 1, b: 4, order: 1 }],
          attachment_atom_offset: 0 },
  // ── Aryl groups ─────────────────────────────────────────────────────
  Ph:   { atoms: [
            { element: 'C', drawn_H: 0 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
          ],
          bonds: [
            { a: 0, b: 1, order: 1 }, { a: 1, b: 2, order: 2 },
            { a: 2, b: 3, order: 1 }, { a: 3, b: 4, order: 2 },
            { a: 4, b: 5, order: 1 }, { a: 5, b: 0, order: 2 },
          ], attachment_atom_offset: 0 },
  Bn:   { atoms: [
            { element: 'C', drawn_H: 2 }, // CH2
            { element: 'C', drawn_H: 0 }, // ring atom 1
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 },
          ],
          bonds: [
            { a: 0, b: 1, order: 1 },
            { a: 1, b: 2, order: 1 }, { a: 2, b: 3, order: 2 },
            { a: 3, b: 4, order: 1 }, { a: 4, b: 5, order: 2 },
            { a: 5, b: 6, order: 1 }, { a: 6, b: 1, order: 2 },
          ], attachment_atom_offset: 0 },
  OBn:  { atoms: [
            { element: 'O' }, { element: 'C', drawn_H: 2 },
            { element: 'C', drawn_H: 0 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
          ],
          bonds: [
            { a: 0, b: 1, order: 1 }, { a: 1, b: 2, order: 1 },
            { a: 2, b: 3, order: 1 }, { a: 3, b: 4, order: 2 },
            { a: 4, b: 5, order: 1 }, { a: 5, b: 6, order: 2 },
            { a: 6, b: 7, order: 1 }, { a: 7, b: 2, order: 2 },
          ], attachment_atom_offset: 0 },
  // ── Acyl groups ─────────────────────────────────────────────────────
  Ac:   { atoms: [{ element: 'C', drawn_H: 0 }, { element: 'O' }, { element: 'C', drawn_H: 3 }],
          bonds: [{ a: 0, b: 1, order: 2 }, { a: 0, b: 2, order: 1 }], attachment_atom_offset: 0 },
  OAc:  { atoms: [{ element: 'O' }, { element: 'C', drawn_H: 0 }, { element: 'O' }, { element: 'C', drawn_H: 3 }],
          bonds: [{ a: 0, b: 1, order: 1 }, { a: 1, b: 2, order: 2 }, { a: 1, b: 3, order: 1 }],
          attachment_atom_offset: 0 },
  Bz:   { atoms: [
            { element: 'C', drawn_H: 0 }, { element: 'O' },
            { element: 'C', drawn_H: 0 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
          ],
          bonds: [
            { a: 0, b: 1, order: 2 }, { a: 0, b: 2, order: 1 },
            { a: 2, b: 3, order: 1 }, { a: 3, b: 4, order: 2 },
            { a: 4, b: 5, order: 1 }, { a: 5, b: 6, order: 2 },
            { a: 6, b: 7, order: 1 }, { a: 7, b: 2, order: 2 },
          ], attachment_atom_offset: 0 },
  OBz:  { atoms: [
            { element: 'O' }, { element: 'C', drawn_H: 0 }, { element: 'O' },
            { element: 'C', drawn_H: 0 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
          ],
          bonds: [
            { a: 0, b: 1, order: 1 }, { a: 1, b: 2, order: 2 },
            { a: 1, b: 3, order: 1 }, { a: 3, b: 4, order: 1 },
            { a: 4, b: 5, order: 2 }, { a: 5, b: 6, order: 1 },
            { a: 6, b: 7, order: 2 }, { a: 7, b: 8, order: 1 },
            { a: 8, b: 3, order: 2 },
          ], attachment_atom_offset: 0 },
  Ts:   { atoms: [
            { element: 'S', drawn_H: 0 }, { element: 'O' }, { element: 'O' },
            { element: 'C', drawn_H: 0 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 0 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 3 },
          ],
          bonds: [
            { a: 0, b: 1, order: 2 }, { a: 0, b: 2, order: 2 },
            { a: 0, b: 3, order: 1 }, { a: 3, b: 4, order: 1 },
            { a: 4, b: 5, order: 2 }, { a: 5, b: 6, order: 1 },
            { a: 6, b: 7, order: 2 }, { a: 7, b: 8, order: 1 },
            { a: 8, b: 3, order: 2 }, { a: 6, b: 9, order: 1 },
          ], attachment_atom_offset: 0 },
  Ms:   { atoms: [
            { element: 'S', drawn_H: 0 }, { element: 'O' }, { element: 'O' },
            { element: 'C', drawn_H: 3 },
          ],
          bonds: [
            { a: 0, b: 1, order: 2 }, { a: 0, b: 2, order: 2 },
            { a: 0, b: 3, order: 1 },
          ], attachment_atom_offset: 0 },
  Tf:   { atoms: [
            { element: 'S', drawn_H: 0 }, { element: 'O' }, { element: 'O' },
            { element: 'C', drawn_H: 0 }, { element: 'F' }, { element: 'F' }, { element: 'F' },
          ],
          bonds: [
            { a: 0, b: 1, order: 2 }, { a: 0, b: 2, order: 2 },
            { a: 0, b: 3, order: 1 }, { a: 3, b: 4, order: 1 },
            { a: 3, b: 5, order: 1 }, { a: 3, b: 6, order: 1 },
          ], attachment_atom_offset: 0 },
  // ── Common functional groups ────────────────────────────────────────
  NO2:  { atoms: [{ element: 'N', drawn_H: 0 }, { element: 'O' }, { element: 'O' }],
          bonds: [{ a: 0, b: 1, order: 2 }, { a: 0, b: 2, order: 2 }],
          attachment_atom_offset: 0 },
  CN:   { atoms: [{ element: 'C', drawn_H: 0 }, { element: 'N' }],
          bonds: [{ a: 0, b: 1, order: 3 }], attachment_atom_offset: 0 },
  CF3:  { atoms: [{ element: 'C', drawn_H: 0 }, { element: 'F' }, { element: 'F' }, { element: 'F' }],
          bonds: [{ a: 0, b: 1, order: 1 }, { a: 0, b: 2, order: 1 }, { a: 0, b: 3, order: 1 }],
          attachment_atom_offset: 0 },
  SO2:  { atoms: [{ element: 'S', drawn_H: 0 }, { element: 'O' }, { element: 'O' }],
          bonds: [{ a: 0, b: 1, order: 2 }, { a: 0, b: 2, order: 2 }],
          attachment_atom_offset: 0 },
  SO3H: { atoms: [{ element: 'S', drawn_H: 0 }, { element: 'O' }, { element: 'O' }, { element: 'O', drawn_H: 1 }],
          bonds: [{ a: 0, b: 1, order: 2 }, { a: 0, b: 2, order: 2 }, { a: 0, b: 3, order: 1 }],
          attachment_atom_offset: 0 },
  OTs:  { atoms: [
            { element: 'O' }, { element: 'S', drawn_H: 0 }, { element: 'O' }, { element: 'O' },
            { element: 'C', drawn_H: 0 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 0 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 3 },
          ],
          bonds: [
            { a: 0, b: 1, order: 1 }, { a: 1, b: 2, order: 2 },
            { a: 1, b: 3, order: 2 }, { a: 1, b: 4, order: 1 },
            { a: 4, b: 5, order: 1 }, { a: 5, b: 6, order: 2 },
            { a: 6, b: 7, order: 1 }, { a: 7, b: 8, order: 2 },
            { a: 8, b: 9, order: 1 }, { a: 9, b: 4, order: 2 },
            { a: 7, b: 10, order: 1 },
          ], attachment_atom_offset: 0 },
  OH:   { atoms: [{ element: 'O', drawn_H: 1 }], bonds: [], attachment_atom_offset: 0 },
  SH:   { atoms: [{ element: 'S', drawn_H: 1 }], bonds: [], attachment_atom_offset: 0 },
  NH:   { atoms: [{ element: 'N', drawn_H: 1 }], bonds: [], attachment_atom_offset: 0 },
  NH2:  { atoms: [{ element: 'N', drawn_H: 2 }], bonds: [], attachment_atom_offset: 0 },
  NHMe: { atoms: [{ element: 'N', drawn_H: 1 }, { element: 'C', drawn_H: 3 }],
          bonds: [{ a: 0, b: 1, order: 1 }], attachment_atom_offset: 0 },
  NMe2: { atoms: [{ element: 'N', drawn_H: 0 }, { element: 'C', drawn_H: 3 }, { element: 'C', drawn_H: 3 }],
          bonds: [{ a: 0, b: 1, order: 1 }, { a: 0, b: 2, order: 1 }],
          attachment_atom_offset: 0 },
  // ── Protecting groups ───────────────────────────────────────────────
  Boc:  { atoms: [
            { element: 'C', drawn_H: 0 }, { element: 'O' }, { element: 'O' },
            { element: 'C', drawn_H: 0 }, { element: 'C', drawn_H: 3 },
            { element: 'C', drawn_H: 3 }, { element: 'C', drawn_H: 3 },
          ],
          bonds: [
            { a: 0, b: 1, order: 2 }, { a: 0, b: 2, order: 1 },
            { a: 2, b: 3, order: 1 }, { a: 3, b: 4, order: 1 },
            { a: 3, b: 5, order: 1 }, { a: 3, b: 6, order: 1 },
          ], attachment_atom_offset: 0 },
  Cbz:  { atoms: [
            { element: 'C', drawn_H: 0 }, { element: 'O' }, { element: 'O' },
            { element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 0 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 },
          ],
          bonds: [
            { a: 0, b: 1, order: 2 }, { a: 0, b: 2, order: 1 },
            { a: 2, b: 3, order: 1 }, { a: 3, b: 4, order: 1 },
            { a: 4, b: 5, order: 1 }, { a: 5, b: 6, order: 2 },
            { a: 6, b: 7, order: 1 }, { a: 7, b: 8, order: 2 },
            { a: 8, b: 9, order: 1 }, { a: 9, b: 4, order: 2 },
          ], attachment_atom_offset: 0 },
  Fmoc: { atoms: [
            { element: 'C', drawn_H: 0 }, { element: 'O' }, { element: 'O' },
            { element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 1 },
            // Two fused phenyl rings — 12 ring atoms total
            { element: 'C', drawn_H: 0 }, { element: 'C', drawn_H: 0 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 0 }, { element: 'C', drawn_H: 0 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
            { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 1 },
          ],
          bonds: [
            { a: 0, b: 1, order: 2 }, { a: 0, b: 2, order: 1 },
            { a: 2, b: 3, order: 1 }, { a: 3, b: 4, order: 1 },
            { a: 4, b: 5, order: 1 }, { a: 5, b: 6, order: 1 },
            { a: 6, b: 7, order: 2 }, { a: 7, b: 8, order: 1 },
            { a: 8, b: 9, order: 2 }, { a: 9, b: 10, order: 1 },
            { a: 10, b: 5, order: 2 }, { a: 4, b: 11, order: 1 },
            { a: 11, b: 12, order: 1 }, { a: 12, b: 13, order: 2 },
            { a: 13, b: 14, order: 1 }, { a: 14, b: 15, order: 2 },
            { a: 15, b: 16, order: 1 }, { a: 16, b: 11, order: 2 },
            { a: 6, b: 12, order: 1 },
          ], attachment_atom_offset: 0 },
  Alloc:{ atoms: [
            { element: 'C', drawn_H: 0 }, { element: 'O' }, { element: 'O' },
            { element: 'C', drawn_H: 2 }, { element: 'C', drawn_H: 1 }, { element: 'C', drawn_H: 2 },
          ],
          bonds: [
            { a: 0, b: 1, order: 2 }, { a: 0, b: 2, order: 1 },
            { a: 2, b: 3, order: 1 }, { a: 3, b: 4, order: 1 },
            { a: 4, b: 5, order: 2 },
          ], attachment_atom_offset: 0 },
};

const ISOTOPE_PATTERN = /^(\d+)([A-Z][a-z]?)$/;

/**
 * Decompose a glyph text token via the deterministic shorthand table OR
 * an isotope pattern (LOCK 23).
 *
 * Recognizes isotope tokens like `13C`, `2H`, `15N` as a single-atom
 * subgraph with the `isotope` field set.
 *
 * Pure function. No side effects.
 */
export function decomposeShorthand(text: string): ShorthandDecompositionResult {
  const trimmed = text.trim();
  if (trimmed in TABLE) {
    return { unknown: false, ...TABLE[trimmed] };
  }
  const isotopeMatch = ISOTOPE_PATTERN.exec(trimmed);
  if (isotopeMatch) {
    const isotope = Number.parseInt(isotopeMatch[1], 10);
    const element = isotopeMatch[2];
    return {
      unknown: false,
      atoms: [{ element, isotope }],
      bonds: [],
      attachment_atom_offset: 0,
    };
  }
  // Bare element symbol pass-through. Worksheet shape uses `text:` glyph
  // nodes; paclitaxel's 10+ bare-`O` glyphs (ester / hydroxyl / oxetane
  // oxygens) fell through to `{ unknown: true }` before this branch and
  // closed the worksheet path for every oxygen-rich molecule.
  if (KNOWN_ELEMENT_SYMBOLS.has(trimmed)) {
    return {
      unknown: false,
      atoms: [{ element: trimmed }],
      bonds: [],
      attachment_atom_offset: 0,
    };
  }
  return { unknown: true };
}

/** Names recognized by the shorthand table (for diagnostics and tests). */
export function knownShorthandNames(): string[] {
  return Object.keys(TABLE).sort();
}
