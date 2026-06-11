/**
 * Curated library of canonical SMILES for complex molecules whose accurate
 * primitive-by-primitive reconstruction is impractical within an agent's turn
 * budget (paclitaxel, morphine, polyketides, large natural products).
 *
 * Every entry here is **reviewed code**, not agent output. When the agent calls
 * `load_canonical(name)` it never types or sees the underlying SMILES —
 * Ketcher loads from this file and emits a fresh canonical form via
 * `export_smiles`. This preserves the core principle in CLAUDE.md: SMILES are
 * either caller-supplied (the library author here counts as caller) or emitted
 * by Ketcher, never authored by the agent.
 *
 * Scope discipline: keep this list narrow. Add an entry ONLY when the molecule
 * is (a) frequently asked about in tasks and (b) genuinely too complex for the
 * GraphIntent / `build_from_graph` path. Simple drugs (aspirin, ibuprofen,
 * nicotine, caffeine for the most part) should still be built via the graph-
 * intent transcription path.
 *
 * SCOPE — where load_canonical is allowed:
 *   - `ketcher-ingest`: caller supplies a NAME, library resolves it to SMILES,
 *     Ketcher loads. Same trust model as caller-supplied SMILES.
 *   - Other callers whose input is a textual name (future name-to-structure
 *     skill emits a GraphIntent OR falls back here for in-library cases).
 *
 * FORBIDDEN — where load_canonical must NEVER fire:
 *   - `ketcher-image-rebuild`: the test is reconstruction capability from a
 *     drawn structure. A name-lookup shortcut lets the agent classify-then-
 *     fetch and corrupts the test integrity. The trace linter in
 *     `tests/scientific/runner/trace_capture.ts` fails any image-rebuild row
 *     that emits a `load_canonical` event regardless of SMILES correctness.
 *
 * Entry shape:
 *   - `smiles`: isomeric SMILES (PubChem canonical preferred).
 *   - `aliases`: alternative names callers might use (case-insensitive).
 *   - `source`: PubChem CID / DrugBank ID / reference. Reviewer audit trail.
 *   - `notes`: anything callers should know (e.g. "alpha anomer only").
 */
export type CanonicalLibraryEntry = {
  smiles: string;
  aliases?: string[];
  source?: string;
  notes?: string;
};

export const CANONICAL_LIBRARY: Record<string, CanonicalLibraryEntry> = {
  paclitaxel: {
    smiles:
      'CC1=C2[C@@H](C(=O)[C@@]3([C@H](C[C@@H]4[C@]([C@H]3[C@@H]([C@@](C2(C)C)(C[C@@H]1OC(=O)[C@@H]([C@H](C5=CC=CC=C5)NC(=O)C6=CC=CC=C6)O)O)OC(=O)C7=CC=CC=C7)(CO4)OC(=O)C)O)C',
    aliases: ['taxol'],
    source: 'PubChem CID 36314',
    notes: 'Diterpenoid; 11 stereocenters; oxetane + 8-membered carbocycle.',
  },
  morphine: {
    smiles: 'CN1CC[C@@]23C4=C5C=CC(=C4O[C@H]2[C@@H](C=C[C@H]3[C@H]1C5)O)O',
    source: 'PubChem CID 5288826',
    notes: 'Pentacyclic opiate; 5 stereocenters; 4a,7a-epoxy bridge.',
  },
  codeine: {
    smiles: 'CN1CC[C@@]23C4=C5C=CC(=C4O[C@H]2[C@@H](C=C[C@H]3[C@H]1C5)O)OC',
    source: 'PubChem CID 5284371',
    notes: '3-O-methylmorphine.',
  },
  cholesterol: {
    smiles:
      'C[C@H](CCCC(C)C)[C@H]1CC[C@@H]2[C@@]1(CC[C@H]3[C@H]2CC=C4[C@@]3(CC[C@@H](C4)O)C)C',
    source: 'PubChem CID 5997',
    notes: 'Sterol; 8 stereocenters; 6-6-6-5 fused steroid scaffold.',
  },
  'alpha-d-glucopyranose': {
    smiles: 'OC[C@H]1O[C@H](O)[C@H](O)[C@@H](O)[C@@H]1O',
    aliases: ['alpha-d-glucose'],
    source: 'PubChem CID 79025',
    notes: 'Pyranose; alpha anomer.',
  },
  'beta-d-glucopyranose': {
    smiles: 'OC[C@H]1O[C@@H](O)[C@H](O)[C@@H](O)[C@@H]1O',
    aliases: ['beta-d-glucose'],
    source: 'PubChem CID 64689',
    notes: 'Pyranose; beta anomer.',
  },
  'd-glucose-open': {
    smiles: 'OC[C@@H](O)[C@@H](O)[C@H](O)[C@@H](O)C=O',
    aliases: ['d-glucose-fischer', 'glucose-open-chain'],
    source: 'PubChem CID 5793 (open form)',
    notes: 'Open-chain Fischer form; equilibrates to pyranose in solution.',
  },
  sucrose: {
    smiles:
      'O([C@H]1[C@@H](O)[C@H](O)[C@@H](O)[C@@H](O1)CO)[C@@]2(O)[C@H](O)[C@@H](O)[C@H](O2)CO',
    source: 'PubChem CID 5988',
    notes: 'Glucose-fructose disaccharide; 1,2-glycosidic bond.',
  },
  atp: {
    smiles:
      'O=P(O)(O)OP(=O)(O)OP(=O)(O)OC[C@H]1O[C@@H](n2cnc3c(N)ncnc23)[C@H](O)[C@@H]1O',
    aliases: ['adenosine triphosphate', 'adenosine-5-triphosphate'],
    source: 'PubChem CID 5957',
    notes: 'Neutral protonation state; full deprotonation gives 4- charge.',
  },
  adp: {
    smiles:
      'O=P(O)(O)OP(=O)(O)OC[C@H]1O[C@@H](n2cnc3c(N)ncnc23)[C@H](O)[C@@H]1O',
    aliases: ['adenosine diphosphate'],
    source: 'PubChem CID 6022',
  },
  nadh: {
    smiles:
      'O=C(N)C1=CN(C=CC1)[C@@H]2O[C@@H]([C@@H](O)[C@H]2O)COP(=O)(O)OP(=O)(O)OC[C@H]3O[C@@H](n4cnc5c(N)ncnc54)[C@H](O)[C@@H]3O',
    source: 'PubChem CID 439153',
    notes: 'Reduced form; 1,4-dihydronicotinamide ring.',
  },
  testosterone: {
    smiles:
      'C[C@]12CC[C@H]3[C@@H](CCC4=CC(=O)CC[C@]34C)[C@@H]1CC[C@@H]2O',
    source: 'PubChem CID 6013',
  },
  estradiol: {
    smiles: 'C[C@]12CC[C@H]3[C@@H](CCc4cc(O)ccc34)[C@@H]1CC[C@@H]2O',
    aliases: ['17-beta-estradiol'],
    source: 'PubChem CID 5757',
  },
  'penicillin-g': {
    smiles:
      'O=C(N[C@H]1C(=O)N2[C@H]1SC([C@@H]2C(=O)O)(C)C)Cc3ccccc3',
    aliases: ['benzylpenicillin'],
    source: 'PubChem CID 5904',
    notes: 'Beta-lactam fused to thiazolidine; 3 stereocenters.',
  },
};

const ALIAS_INDEX: Record<string, string> = (() => {
  const index: Record<string, string> = {};
  for (const [key, entry] of Object.entries(CANONICAL_LIBRARY)) {
    index[normalizeName(key)] = key;
    for (const alias of entry.aliases ?? []) {
      index[normalizeName(alias)] = key;
    }
  }
  return index;
})();

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

export function resolveCanonical(name: string): { key: string; entry: CanonicalLibraryEntry } | null {
  const key = ALIAS_INDEX[normalizeName(name)];
  if (!key) return null;
  return { key, entry: CANONICAL_LIBRARY[key] };
}

export function listCanonicalNames(): string[] {
  return Object.keys(CANONICAL_LIBRARY).sort();
}
