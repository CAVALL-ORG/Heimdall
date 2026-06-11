import {
  Action,
  Atom,
  AtomAttr,
  Bond,
  fromAtomsAttrs,
  fromBondAddition,
  fromBondsAttrs,
  fromOneAtomDeletion,
  fromOneBondDeletion,
  KetSerializer,
  prepareStructToRender,
} from 'ketcher-core';
// ketcher-core exports AtomMove from its CJS bundle but does not declare it in
// its .d.ts. The diagnostic setAtomXY primitive needs it to translate an atom
// to an absolute position via a (target - current) delta. Cast through unknown
// to bypass the missing type, mirroring how the rest of the bridge already
// accesses untyped Ketcher internals (`window.ketcher` is `any`).
import * as KetcherCoreNS from 'ketcher-core';

import {
  bondOrderWeight,
  buildAdjacency,
  componentCount,
  computeBondInRingFlags,
} from '../adapter/graph';
import {
  computeConjugationGroups,
  computeLonePairs,
} from '../adapter/chemistry-derivations';

type AgentAtom = {
  id: number;
  label: string;
  charge: number | null;
  radical: number | null;
  x: number;
  y: number;
};

type AgentBond = {
  id: number;
  beginAtomId: number;
  endAtomId: number;
  order: number;
  stereo: number;
};

export type AgentState = {
  smiles: string | null;
  ket: string | null;
  molfile: string | null;
  isEmpty: boolean;
  isReaction: boolean;
  hasExportFailure: boolean;
  exportErrorMessage: string | null;
  atoms: AgentAtom[];
  bonds: AgentBond[];
};

type AgentEvent = {
  type: string;
  timestamp: string;
  detail?: string;
};

const MAX_EVENTS = 200;
const events: AgentEvent[] = [];
const bondOrderMap = new Map<number, number>([
  [1, Bond.PATTERN.TYPE.SINGLE],
  [2, Bond.PATTERN.TYPE.DOUBLE],
  [3, Bond.PATTERN.TYPE.TRIPLE],
  [4, Bond.PATTERN.TYPE.AROMATIC],
]);

const atomRadicalMap = new Map<number, number>([
  [0, Atom.PATTERN.RADICAL.NONE],
  [1, Atom.PATTERN.RADICAL.SINGLET],
  [2, Atom.PATTERN.RADICAL.DOUPLET],
  [3, Atom.PATTERN.RADICAL.TRIPLET],
]);

function pushEvent(type: string, detail?: string) {
  events.push({
    type,
    timestamp: new Date().toISOString(),
    detail,
  });
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
}

function normalizeBondOrder(order: number): number {
  const normalized = bondOrderMap.get(order);
  if (!normalized) {
    throw new Error(`Unsupported bond order: ${order}`);
  }
  return normalized;
}

function normalizeRadical(radical: number): number {
  const normalized = atomRadicalMap.get(radical);
  if (normalized === undefined) {
    throw new Error(`Unsupported radical value: ${radical}`);
  }
  return normalized;
}

function getKetcher(): any {
  const ketcher = window.ketcher;
  if (!ketcher) {
    throw new Error('Ketcher instance is not initialized');
  }
  return ketcher;
}

function toAtomTable(struct: any): AgentAtom[] {
  const atoms: AgentAtom[] = [];
  struct.atoms.forEach((atom: any, atomId: number) => {
    atoms.push({
      id: atomId,
      label: atom.label,
      charge: atom.charge ?? null,
      radical: atom.radical ?? null,
      x: atom.pp.x,
      y: atom.pp.y,
    });
  });
  return atoms;
}

function toBondTable(struct: any): AgentBond[] {
  const bonds: AgentBond[] = [];
  struct.bonds.forEach((bond: any, bondId: number) => {
    bonds.push({
      id: bondId,
      beginAtomId: bond.begin,
      endAtomId: bond.end,
      order: bond.type,
      stereo: bond.stereo,
    });
  });
  return bonds;
}

async function safeGetSmiles(ketcher: any): Promise<string | null> {
  try {
    return await ketcher.getSmiles();
  } catch (error) {
    pushEvent(
      'SMILES_EXPORT_FAILED',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

async function safeGetMolfile(ketcher: any): Promise<string | null> {
  try {
    return await ketcher.getMolfile();
  } catch {
    return null;
  }
}

async function getState(includeMolfile = false): Promise<AgentState> {
  const ketcher = getKetcher();
  const struct = ketcher.editor.struct();

  let ket: string | null = null;
  let exportErrorMessage: string | null = null;
  let hasExportFailure = false;

  try {
    ket = await ketcher.getKet();
  } catch (error) {
    hasExportFailure = true;
    exportErrorMessage = error instanceof Error ? error.message : String(error);
  }

  const smiles = await safeGetSmiles(ketcher);
  const molfile = includeMolfile ? await safeGetMolfile(ketcher) : null;

  return {
    smiles,
    ket,
    molfile,
    isEmpty: struct.isBlank(),
    isReaction: ketcher.containsReaction(),
    hasExportFailure,
    exportErrorMessage,
    atoms: toAtomTable(struct),
    bonds: toBondTable(struct),
  };
}

function ensureBondExists(bondId: number) {
  const bond = getKetcher().editor.struct().bonds.get(bondId);
  if (!bond) {
    throw new Error(`Bond ${bondId} was not found`);
  }
}

function ensureAtomExists(atomId: number) {
  const atom = getKetcher().editor.struct().atoms.get(atomId);
  if (!atom) {
    throw new Error(`Atom ${atomId} was not found`);
  }
}

function setBondOrder(bondId: number, order: number) {
  ensureBondExists(bondId);
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const reStruct = editor.render.ctab;
  const normalizedOrder = normalizeBondOrder(order);
  editor.update(fromBondsAttrs(reStruct, bondId, { type: normalizedOrder }));
  pushEvent('SET_BOND_ORDER', `bond=${bondId},order=${normalizedOrder}`);
}

function setAtomCharge(atomId: number, charge: number) {
  ensureAtomExists(atomId);
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const reStruct = editor.render.ctab;
  editor.update(fromAtomsAttrs(reStruct, atomId, { charge }));
  pushEvent('SET_ATOM_CHARGE', `atom=${atomId},charge=${charge}`);
}

function setAtomRadical(atomId: number, radical: number) {
  ensureAtomExists(atomId);
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const reStruct = editor.render.ctab;
  const normalizedRadical = normalizeRadical(radical);
  editor.update(fromAtomsAttrs(reStruct, atomId, { radical: normalizedRadical }));
  pushEvent('SET_ATOM_RADICAL', `atom=${atomId},radical=${normalizedRadical}`);
}

function setAtomElement(atomId: number, element: string) {
  ensureAtomExists(atomId);
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const reStruct = editor.render.ctab;
  // fromAtomsAttrs handles label changes, including the implicit-H recompute
  // for the new element. atomList is reset to null inside fromAtomsAttrs when
  // a label is provided, so query-list state from a prior label won't bleed in.
  editor.update(fromAtomsAttrs(reStruct, atomId, { label: element }));
  pushEvent('SET_ATOM_ELEMENT', `atom=${atomId},label=${element}`);
}

// Set the nuclear mass number (isotope) on an atom. `isotope` is a first-class
// field of Ketcher's Atom model (Atom.attrlist includes 'isotope') and is
// emitted by the SMILES writer as the bracket-atom mass prefix ([13C], [15N],
// [2H], …). Passing 0 / null clears the label back to natural abundance.
function setAtomIsotope(atomId: number, isotope: number) {
  ensureAtomExists(atomId);
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const reStruct = editor.render.ctab;
  editor.update(fromAtomsAttrs(reStruct, atomId, { isotope }));
  pushEvent('SET_ATOM_ISOTOPE', `atom=${atomId},isotope=${isotope}`);
}

// Set the MDL enhanced-stereo group label on an atom. `stereoLabel` is a
// first-class Ketcher Atom attribute (Atom.attrlist includes 'stereoLabel');
// its string form is "abs" (absolute), "&<n>" (AND group n), or "or<n>" (OR
// group n) — see StereoLabel enum. Only meaningful once the center carries a
// defined parity (a wedge / CIP assignment); the enhanced-stereo grouping
// rides on top of that parity in the V2000 STEABS/STEREL/STERAC collections.
function setAtomStereoLabel(atomId: number, stereoLabel: string) {
  ensureAtomExists(atomId);
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const reStruct = editor.render.ctab;
  editor.update(fromAtomsAttrs(reStruct, atomId, { stereoLabel }));
  pushEvent('SET_ATOM_STEREO_LABEL', `atom=${atomId},stereoLabel=${stereoLabel}`);
}

// Pin an atom to an absolute (x, y) model-space position. Diagnostic primitive
// used to test whether Ketcher's CIP perception is coordinate-dependent for
// wedge bonds. `pp` is NOT in Atom.attrlist, so fromAtomsAttrs({pp: ...}) is a
// no-op; the supported path is the AtomMove op, which takes a *delta* Vec2 and
// calls atom.pp.add_(d) internally. We compute the delta from current pp →
// target (x, y) and submit a single-op Action.
function setAtomXY(atomId: number, x: number, y: number): void {
  ensureAtomExists(atomId);
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const reStruct = editor.render.ctab;
  const atom = editor.struct().atoms.get(atomId);
  if (!atom) throw new Error(`Atom ${atomId} not found`);
  const AtomMoveOp = (KetcherCoreNS as any).AtomMove;
  const Vec2Ctor = (KetcherCoreNS as any).Vec2;
  if (!AtomMoveOp) throw new Error('AtomMove operation not available from ketcher-core');
  // Vec2 may not be on the package surface; reuse atom.pp's prototype constructor
  // as a fallback (the canvas already has Vec2 instances on every atom.pp).
  const Vec2Use = Vec2Ctor ?? Object.getPrototypeOf(atom.pp).constructor;
  const dx = x - atom.pp.x;
  const dy = y - atom.pp.y;
  const delta = new Vec2Use(dx, dy, 0);
  const action = new Action();
  action.addOp(new AtomMoveOp(atomId, delta).perform(reStruct));
  editor.update(action);
  pushEvent('SET_ATOM_XY', `atom=${atomId},x=${x},y=${y}`);
}

const bondStereoMap = new Map<string, number>([
  ['none', Bond.PATTERN.STEREO.NONE],
  ['up', Bond.PATTERN.STEREO.UP],
  ['down', Bond.PATTERN.STEREO.DOWN],
  ['either', Bond.PATTERN.STEREO.EITHER],
  ['cis_trans', Bond.PATTERN.STEREO.CIS_TRANS],
]);

function normalizeBondStereo(stereo: string | number): number {
  if (typeof stereo === 'number') return stereo;
  const lookup = bondStereoMap.get(stereo.toLowerCase());
  if (lookup === undefined) {
    throw new Error(`Unsupported bond stereo: ${stereo}`);
  }
  return lookup;
}

function setBondStereo(bondId: number, stereo: string | number) {
  ensureBondExists(bondId);
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const reStruct = editor.render.ctab;
  const bondById = editor.struct().bonds.get(bondId);
  if (!bondById) throw new Error(`Bond ${bondId} not found`);
  const normalized = normalizeBondStereo(stereo);
  // CIS_TRANS=3 is only meaningful on double bonds. Indigo reads the surrounding
  // 2D layout at export time to decide E vs Z, so callers must also pin atom
  // coordinates (see setAtomXY / build_from_graph coord pinning).
  if (normalized === Bond.PATTERN.STEREO.CIS_TRANS && bondById.type !== Bond.PATTERN.TYPE.DOUBLE) {
    throw new Error('CIS_TRANS stereo only valid on double bonds');
  }
  editor.update(fromBondsAttrs(reStruct, bondId, { stereo: normalized }));
  pushEvent('SET_BOND_STEREO', `bond=${bondId},stereo=${normalized}`);
}

// Wedge/dash semantics in Ketcher (and in MDL molfiles): the stereo flag lives
// on a *bond*, but is interpreted relative to that bond's `begin` atom — the
// chiral center. UP (=1) = wedge pointing up toward the viewer; DOWN (=6) =
// hash pointing down away from the viewer. If a bond's begin atom is NOT the
// chiral center, the same UP/DOWN flag inverts the CIP parity Ketcher emits.
//
// setWedgeBond hides that invariant from callers: it locates the bond between
// the chiral atom and the named neighbor, guarantees the chiral atom is the
// `begin` end (rebuilding the bond if needed), then sets UP or DOWN per
// `wedge`. Callers describe the image they see ("from chiral C, wedge points
// up to N") and Ketcher computes the resulting SMILES @/@@.
function setWedgeBond(
  chiralAtomId: number,
  neighborAtomId: number,
  wedge: 'solid' | 'hashed',
): { bondId: number } {
  ensureAtomExists(chiralAtomId);
  ensureAtomExists(neighborAtomId);
  if (chiralAtomId === neighborAtomId) {
    throw new Error('chiralAtomId and neighborAtomId must differ');
  }
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const struct = editor.struct();
  let existingBondId: number | null = null;
  let existingBond: any = null;
  struct.bonds.forEach((bond: any, bondId: number) => {
    if (
      (bond.begin === chiralAtomId && bond.end === neighborAtomId) ||
      (bond.begin === neighborAtomId && bond.end === chiralAtomId)
    ) {
      existingBondId = bondId;
      existingBond = bond;
    }
  });
  if (existingBondId === null || !existingBond) {
    throw new Error(
      `No bond between atoms ${chiralAtomId} and ${neighborAtomId}`,
    );
  }
  if (existingBond.type !== Bond.PATTERN.TYPE.SINGLE) {
    throw new Error(
      `Wedge/dash stereo requires a single bond (bond ${existingBondId} is order ${existingBond.type})`,
    );
  }
  const stereo =
    wedge === 'solid' ? Bond.PATTERN.STEREO.UP : Bond.PATTERN.STEREO.DOWN;

  if (existingBond.begin === chiralAtomId) {
    editor.update(
      fromBondsAttrs(editor.render.ctab, existingBondId, { stereo }),
    );
    pushEvent(
      'SET_WEDGE_BOND',
      `chiral=${chiralAtomId},to=${neighborAtomId},wedge=${wedge},rebuilt=false`,
    );
    return { bondId: existingBondId };
  }

  // begin/end need swapping. Delete the existing bond, recreate with the
  // chiral atom as begin and stereo applied in the same Action.
  editor.update(fromOneBondDeletion(editor.render.ctab, existingBondId));
  const [action, , , newBondId] = fromBondAddition(
    editor.render.ctab,
    { type: Bond.PATTERN.TYPE.SINGLE, stereo },
    chiralAtomId,
    neighborAtomId,
  );
  editor.update(action);
  pushEvent(
    'SET_WEDGE_BOND',
    `chiral=${chiralAtomId},to=${neighborAtomId},wedge=${wedge},rebuilt=true`,
  );
  return { bondId: newBondId };
}

async function addFragment(smiles: string) {
  const ketcher = getKetcher();
  const fragmentStruct = await prepareStructToRender(
    smiles,
    ketcher.structService,
    ketcher,
  );
  const currentStruct = ketcher.editor.struct().clone();
  // Translate the new fragment so it doesn't overlap the existing structure.
  // mergeInto preserves both fragments; we offset the new one by the bbox of
  // the existing canvas content (plus a small gap) along the x-axis.
  let offsetX = 0;
  if (currentStruct.atoms.size > 0) {
    let maxX = -Infinity;
    currentStruct.atoms.forEach((atom: any) => {
      if (atom.pp.x > maxX) maxX = atom.pp.x;
    });
    let minNewX = Infinity;
    fragmentStruct.atoms.forEach((atom: any) => {
      if (atom.pp.x < minNewX) minNewX = atom.pp.x;
    });
    if (Number.isFinite(maxX) && Number.isFinite(minNewX)) {
      offsetX = maxX - minNewX + 2;
    }
  }
  if (offsetX !== 0) {
    fragmentStruct.atoms.forEach((atom: any) => {
      atom.pp.x += offsetX;
    });
  }
  // mergeInto copies THIS struct's atoms/bonds into the cp argument. We want
  // the existing canvas content kept and the new fragment appended, so we
  // merge fragment → canvas.
  fragmentStruct.mergeInto(currentStruct);
  const ketSerializer = new KetSerializer();
  await ketcher.setMolecule(ketSerializer.serialize(currentStruct));
  pushEvent('ADD_FRAGMENT', `smiles=${smiles}`);
}

function addAtomWithSingleBond(
  anchorAtomId: number,
  element: string,
  bondOrder = Bond.PATTERN.TYPE.SINGLE,
) {
  ensureAtomExists(anchorAtomId);
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const reStruct = editor.render.ctab;
  const normalizedOrder = normalizeBondOrder(bondOrder);
  const [action, beginAtomId, endAtomId, bondId] = fromBondAddition(
    reStruct,
    { type: normalizedOrder },
    anchorAtomId,
    { label: element },
  );
  editor.update(action);
  pushEvent(
    'ADD_ATOM_WITH_SINGLE_BOND',
    `anchor=${anchorAtomId},element=${element},bondOrder=${normalizedOrder}`,
  );
  return { beginAtomId, endAtomId, bondId };
}

function deleteAtom(atomId: number) {
  ensureAtomExists(atomId);
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const beforeComponents = componentCount(editor.struct());
  const reStruct = editor.render.ctab;
  editor.update(fromOneAtomDeletion(reStruct, atomId));
  const afterComponents = componentCount(editor.struct());
  pushEvent(
    'DELETE_ATOM',
    `atom=${atomId},componentsBefore=${beforeComponents},componentsAfter=${afterComponents}`,
  );
}

function addBond(atomId1: number, atomId2: number, order: number) {
  ensureAtomExists(atomId1);
  ensureAtomExists(atomId2);
  if (atomId1 === atomId2) {
    throw new Error('Cannot create a bond between the same atom');
  }
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const beforeComponents = componentCount(editor.struct());
  const reStruct = editor.render.ctab;
  const normalizedOrder = normalizeBondOrder(order);
  const [action, beginAtomId, endAtomId, bondId] = fromBondAddition(
    reStruct,
    { type: normalizedOrder },
    atomId1,
    atomId2,
  );
  editor.update(action);
  const afterComponents = componentCount(editor.struct());
  pushEvent(
    'ADD_BOND',
    `begin=${atomId1},end=${atomId2},order=${normalizedOrder},componentsBefore=${beforeComponents},componentsAfter=${afterComponents}`,
  );
  return { beginAtomId, endAtomId, bondId };
}

function deleteBond(bondId: number) {
  ensureBondExists(bondId);
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const beforeComponents = componentCount(editor.struct());
  const reStruct = editor.render.ctab;
  editor.update(fromOneBondDeletion(reStruct, bondId));
  const afterComponents = componentCount(editor.struct());
  pushEvent(
    'DELETE_BOND',
    `bond=${bondId},componentsBefore=${beforeComponents},componentsAfter=${afterComponents}`,
  );
}

async function layout() {
  const ketcher = getKetcher();
  await ketcher.layout();
  pushEvent('LAYOUT');
}

async function clean() {
  const ketcher = getKetcher();
  const cleanedStruct = await ketcher.indigo.clean(ketcher.editor.struct());
  const ketSerializer = new KetSerializer();
  await ketcher.setMolecule(ketSerializer.serialize(cleanedStruct));
  pushEvent('CLEAN');
}

async function aromatize() {
  const ketcher = getKetcher();
  const aromatizedStruct = await ketcher.indigo.aromatize(ketcher.editor.struct());
  const ketSerializer = new KetSerializer();
  await ketcher.setMolecule(ketSerializer.serialize(aromatizedStruct));
  pushEvent('AROMATIZE');
}

async function dearomatize() {
  const ketcher = getKetcher();
  const dearomatizedStruct = await ketcher.indigo.dearomatize(ketcher.editor.struct());
  const ketSerializer = new KetSerializer();
  await ketcher.setMolecule(ketSerializer.serialize(dearomatizedStruct));
  pushEvent('DEAROMATIZE');
}

function setAtomImplicitHCount(atomId: number, count: number) {
  ensureAtomExists(atomId);
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const reStruct = editor.render.ctab;
  // ketcher-core's fromAtomsAttrs overwrites implicitHCount with the recomputed
  // implicitH on aromatic-ring atoms (see actions/atom.ts ~line 115). For
  // aromatic atoms whose implicit H is constrained by the aromaticity-aware
  // valence clamp (struct.ts calcImplicitHydrogen), that overwrite zeroes out
  // the user-requested count — e.g. pyridinium [nH+] gets clamped back to no H.
  // Apply the attribute via a direct AtomAttr op so the user-provided count
  // sticks; KET serialization writes implicitHCount and SMILES export honors it.
  const action = new Action();
  action.addOp(new AtomAttr(atomId, 'implicitHCount', count).perform(reStruct));
  editor.update(action);
  pushEvent('SET_ATOM_IMPLICIT_H_COUNT', `atom=${atomId},count=${count}`);
}

function setAtomExplicitValence(atomId: number, valence: number) {
  ensureAtomExists(atomId);
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const reStruct = editor.render.ctab;
  editor.update(fromAtomsAttrs(reStruct, atomId, { explicitValence: valence }));
  pushEvent('SET_ATOM_EXPLICIT_VALENCE', `atom=${atomId},valence=${valence}`);
}

async function exportMolfile() {
  const ketcher = getKetcher();
  try {
    return await ketcher.getMolfile();
  } catch (error) {
    pushEvent('MOLFILE_EXPORT_FAILED', error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function exportCanonicalSmiles() {
  // Indigo has a canonical-SMILES mode (option `smiles: 'canonical'`) that
  // produces a deterministic traversal regardless of how atoms were entered.
  // Ketcher's structService.convert wrapper drops the `smiles` option before
  // forwarding to Indigo, so we call /indigo/convert directly via the proxy.
  // Note: Indigo canonical ≠ RDKit canonical — two callers canonicalizing
  // through different toolkits may still get different strings for the same
  // molecule. Within Ketcher's pipeline this is stable.
  const apiPath = getRemoteApiPath();
  if (!apiPath) {
    throw new Error('Canonical SMILES requires remote mode (Indigo backend).');
  }
  const ketcher = getKetcher();
  const ketSerializer = new KetSerializer();
  const ket = ketSerializer.serialize(ketcher.editor.struct());
  const response = await fetch(`${apiPath}indigo/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      struct: ket,
      output_format: 'chemical/x-daylight-smiles',
      options: { smiles: 'canonical' },
    }),
    credentials: 'same-origin',
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Canonical SMILES conversion failed (HTTP ${response.status}): ${text.slice(0, 200)}`,
    );
  }
  let parsed: { struct?: string; error?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Canonical SMILES response was not JSON: ${text.slice(0, 200)}`);
  }
  if (parsed.error || typeof parsed.struct !== 'string') {
    throw new Error(`Canonical SMILES error: ${parsed.error ?? text.slice(0, 200)}`);
  }
  return parsed.struct;
}

type AnnotatedAtom = AgentAtom & {
  implicitH: number;
  implicitHCount: number | null;
  explicitValence: number;
  computedValence: number;
  aromatic: boolean;
  inRing: boolean;
  degree: number;
  lonePairs: number;
  neighborAtomIds: number[];
  neighborBondIds: number[];
};

type AnnotatedBond = AgentBond & {
  aromatic: boolean;
  inRing: boolean;
  conjugationGroupId: number | null;
};

type AnnotatedState = AgentState & {
  atoms: AnnotatedAtom[];
  bonds: AnnotatedBond[];
  conjugationGroups: Array<{
    id: number;
    atomIds: number[];
    bondIds: number[];
  }>;
};

async function getAnnotatedState(): Promise<AnnotatedState> {
  const ketcher = getKetcher();
  const struct = ketcher.editor.struct();

  // Ensure neighbors / half-bonds are populated for valence calculations.
  try {
    struct.prepareLoopStructure();
  } catch {
    // Standalone structures may not need this; ignore failures.
  }

  const baseState = await getState(false);
  const { atomBonds, atomNeighbors, bondList } = buildAdjacency(struct);
  const bondInRing = computeBondInRingFlags(bondList);
  // Heavy-neighbor bond-order sum per atom; uses bondOrderWeight from
  // ../adapter/graph (aromatic counts as 1 σ; π electrons shared ring-wide).
  const heavyBondOrderSum = new Map<number, number>();
  baseState.atoms.forEach((atom) => heavyBondOrderSum.set(atom.id, 0));
  for (const bond of bondList) {
    const w = bondOrderWeight(bond.type);
    heavyBondOrderSum.set(bond.begin, (heavyBondOrderSum.get(bond.begin) ?? 0) + w);
    heavyBondOrderSum.set(bond.end, (heavyBondOrderSum.get(bond.end) ?? 0) + w);
  }
  const atomInfo = new Map<number, { label: string; computedValence: number; charge: number }>();
  baseState.atoms.forEach((atom) => {
    const structAtom = struct.atoms.get(atom.id);
    const sigmaBonds = heavyBondOrderSum.get(atom.id) ?? 0;
    // implicitHCount is the user override (set via set_atom_implicit_h_count);
    // implicitH is Ketcher's valence-recomputed value. For non-aromatic atoms
    // Ketcher does not propagate the override into implicitH, so the effective
    // H count is `implicitHCount ?? implicitH`. SMILES export honors the
    // override; annotated state must too, otherwise downstream chem-* skills
    // see stale H counts after radical / proton mutations.
    const implicitH = structAtom?.implicitHCount ?? structAtom?.implicitH ?? 0;
    atomInfo.set(atom.id, {
      label: atom.label,
      computedValence: sigmaBonds + implicitH,
      charge: atom.charge ?? 0,
    });
  });
  const { bondGroup, groups } = computeConjugationGroups(bondList, atomInfo);

  const annotatedAtoms: AnnotatedAtom[] = baseState.atoms.map((atom) => {
    const structAtom = struct.atoms.get(atom.id);
    const bondsOnAtom = atomBonds.get(atom.id) ?? [];
    const neighbors = atomNeighbors.get(atom.id) ?? [];
    const aromatic = bondsOnAtom.some(
      (bondId) => struct.bonds.get(bondId)?.type === Bond.PATTERN.TYPE.AROMATIC,
    );
    const inRing = bondsOnAtom.some((bondId) => bondInRing.get(bondId) === true);
    const sigmaBondSum = heavyBondOrderSum.get(atom.id) ?? 0;
    const implicitH = structAtom?.implicitHCount ?? structAtom?.implicitH ?? 0;
    const computedValence = sigmaBondSum + implicitH;
    const charge = atom.charge ?? 0;
    return {
      ...atom,
      implicitH,
      implicitHCount: structAtom?.implicitHCount ?? null,
      explicitValence: structAtom?.explicitValence ?? -1,
      computedValence,
      aromatic,
      inRing,
      degree: bondsOnAtom.length,
      lonePairs: computeLonePairs(atom.label, computedValence, charge),
      neighborAtomIds: [...new Set(neighbors)].sort((a, b) => a - b),
      neighborBondIds: [...bondsOnAtom].sort((a, b) => a - b),
    };
  });

  const annotatedBonds: AnnotatedBond[] = baseState.bonds.map((bond) => ({
    ...bond,
    aromatic: bond.order === Bond.PATTERN.TYPE.AROMATIC,
    inRing: bondInRing.get(bond.id) === true,
    conjugationGroupId: bondGroup.get(bond.id) ?? null,
  }));

  return {
    ...baseState,
    atoms: annotatedAtoms,
    bonds: annotatedBonds,
    conjugationGroups: groups,
  };
}

async function resetToSnapshot(ket: string) {
  const ketcher = getKetcher();
  await ketcher.setMolecule(ket);
  pushEvent('RESET_TO_SNAPSHOT');
}

async function clearCanvas() {
  const ketcher = getKetcher();
  // KetSerializer can serialize an empty Struct unambiguously; passing '' to
  // setMolecule routes through prepareStructToRender which can be format-
  // ambiguous on empty input.
  const ketSerializer = new KetSerializer();
  const Struct = ketcher.editor.struct().constructor;
  const emptyKet = ketSerializer.serialize(new Struct());
  await ketcher.setMolecule(emptyKet);
  pushEvent('CLEAR_CANVAS');
}

async function validateState() {
  const ketcher = getKetcher();
  return await ketcher.indigo.check(ketcher.editor.struct());
}

async function validateSmilesString(smiles: string) {
  const ketcher = getKetcher();
  await prepareStructToRender(smiles, ketcher.structService, ketcher);
  return { ok: true };
}

async function loadSmiles(smiles: string) {
  const ketcher = getKetcher();
  // Ketcher.setMolecule wraps parsing in runAsyncAction, which swallows errors and
  // resolves the promise; parse first so invalid SMILES reject the bridge call.
  const struct = await prepareStructToRender(smiles, ketcher.structService, ketcher);
  const ketSerializer = new KetSerializer();
  await ketcher.setMolecule(ketSerializer.serialize(struct));
  pushEvent('LOAD_SMILES');
}

async function loadMolfile(molfile: string) {
  const ketcher = getKetcher();
  // Molfile (V2000/V3000) is parsed through prepareStructToRender like SMILES so
  // a malformed payload rejects synchronously instead of being swallowed.
  const struct = await prepareStructToRender(molfile, ketcher.structService, ketcher);
  const ketSerializer = new KetSerializer();
  await ketcher.setMolecule(ketSerializer.serialize(struct));
  pushEvent('LOAD_MOLFILE');
}

type RenderCanvasOptions = {
  showAtomIds?: boolean;
  format?: 'png' | 'svg';
  backgroundColor?: string;
  /**
   * Generic passthrough into Ketcher's `editor.options({...})` render-option
   * bag, merged just before serialization. Lets callers flip publication-
   * style display flags the dedicated fields above do not cover — e.g.
   * `{ stereoLabelStyle: 'Off', ignoreChiralFlag: true, hideTerminalLabels:
   * true, showStereoFlags: false }` to drop the on-canvas "abs" enhanced-
   * stereo flags and terminal CH3 labels for a clean figure. Additive and
   * back-compat: unset → only `showAtomIds` is applied, as before. Keys are
   * forwarded verbatim to ketcher-core RenderOptions; unknown keys are
   * ignored by Ketcher.
   */
  renderOptions?: Record<string, unknown>;
  /**
   * Stage R.1 rework (post-smoke). Target raster dimensions in pixels.
   * When set, the rasterizer scales the (cropped or full) SVG into
   * exactly these dimensions so the render-diff judge can compare
   * apples-to-apples against a source image with known dims. When
   * unset, falls back to the SVG element's clientRect (legacy
   * behavior).
   */
  width?: number;
  height?: number;
  /**
   * Stage R.1 rework. Tighten the SVG viewBox to the molecule's
   * drawn-content bbox before rasterization. Without this, Ketcher's
   * default canvas is 1170×658 with the molecule at native model
   * scale — render-diff smokes showed the molecule landing as an ~80px
   * glyph in the corner, defeating any vision-judge compare. Opt-in;
   * default false to preserve back-compat for existing render_canvas
   * MCP callers and trace-vision-readback users who rely on the full
   * canvas framing.
   */
  cropToContent?: boolean;
  /**
   * Stage R.1 rework. Padding added to the cropped bbox as a fraction
   * of the bbox's max dimension. Defaults to 0.05 (5%) when
   * `cropToContent` is set; ignored otherwise. Prevents the crop from
   * clipping wedge tips, charge labels, or atom-id overlays right at
   * the molecule boundary.
   */
  cropPadding?: number;
  /**
   * Stage R.1 rework (post-rework R.4 smoke). Dearomatize the canvas
   * before rendering so aromatic rings render as explicit Kekule
   * (alternating single/double bonds) rather than the Ketcher default
   * `data-bondtype=4` solid+dashed-parallel-line style. The render-
   * diff vision-judge reads the dashed parallel line as additional
   * structure ("two 4-rings on benzene") when the source image uses
   * explicit Kekule style — this option closes the style gap.
   *
   * Canvas state is RESTORED to the original aromatic form before
   * the function returns; consumers reading the canvas after the
   * render call see the un-dearomatized state. Mutation-during-render
   * is invisible to the caller modulo the `RENDER_CANVAS` /
   * `DEAROMATIZE` trace events.
   */
  dearomatizeBeforeRender?: boolean;
};

async function renderCanvas(opts?: RenderCanvasOptions): Promise<string> {
  const ketcher = getKetcher();
  const editor = ketcher.editor;
  const showAtomIds = !!opts?.showAtomIds;
  const format = opts?.format === 'svg' ? 'svg' : 'png';
  const backgroundColor = opts?.backgroundColor ?? '#ffffff';
  const cropToContent = !!opts?.cropToContent;
  const cropPadding = opts?.cropPadding ?? 0.05;
  const dearomatizeBeforeRender = !!opts?.dearomatizeBeforeRender;

  // Dearomatize-before-render (Stage R.1 rework post-R.4 smoke). Snapshot
  // the current Struct as a KET string, dearomatize via Indigo, render,
  // then restore the snapshot in a finally block so the caller's view of
  // the canvas is unchanged. Failure to dearomatize (Indigo unreachable)
  // falls through to aromatic-style render rather than failing the whole
  // dump path — the render-diff is forensic, not load-bearing.
  let savedKetForRestore: string | null = null;
  if (dearomatizeBeforeRender) {
    try {
      const ksSnap = new KetSerializer();
      savedKetForRestore = ksSnap.serialize(ketcher.editor.struct());
      const dearomatized = await ketcher.indigo.dearomatize(ketcher.editor.struct());
      await ketcher.setMolecule(ksSnap.serialize(dearomatized));
      pushEvent('DEAROMATIZE_FOR_RENDER');
    } catch {
      // Dearomatize unavailable / failed; leave canvas as-is and proceed
      // with aromatic-style render. The restore step below is a no-op
      // when `savedKetForRestore` stayed null.
      savedKetForRestore = null;
    }
  }

  try {
  // editor.options({...}) rebuilds the Render with the merged options and re-
  // attaches the current Struct — this is the documented way to flip render
  // flags like showAtomIds (Render.updateOptions only mutates the option bag
  // without invalidating the existing SVG). We do not restore the prior value;
  // headless runs are stateless between bridge calls and the next render will
  // set whatever flag it needs.
  editor.options({ showAtomIds, ...(opts?.renderOptions ?? {}) });
  // One animation frame so the Raphael paint pipeline finishes before we
  // serialize the SVG.
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 16);
    }
  });

  const clientArea: HTMLElement | undefined = editor.render?.clientArea;
  const svgEl = clientArea?.querySelector('svg') as SVGSVGElement | null;
  if (!svgEl) {
    throw new Error('Ketcher canvas SVG not found in clientArea');
  }

  // Compute the tight content viewBox if requested. The root-element
  // `getBBox()` includes background rects that span the whole clientArea
  // (Ketcher's Render lays a full-canvas background fill behind the
  // molecule), which would leave the cropped output identical to the
  // un-cropped one. Iterate the drawing-primitive descendants instead
  // (paths = bonds, text = atom labels, lines/polylines/etc = misc
  // decorations) and union their bboxes. Empty union → no drawn
  // content → fall through to the legacy clientArea framing.
  let contentViewBox: string | null = null;
  // Aspect ratio (w/h) of the padded content bbox. When cropToContent crops
  // the viewBox to the molecule but the caller gives no explicit width/height,
  // the raster step below derives its dimensions from this so the PNG keeps
  // the molecule's true aspect instead of being stretched to fill the fixed
  // full-canvas clientRect (~1.84:1) — the latter silently distorts a square
  // molecule into a landscape one.
  let contentAspect: number | null = null;
  if (cropToContent) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const drawn = svgEl.querySelectorAll(
      'path, text, line, polyline, polygon, circle, ellipse',
    );
    drawn.forEach((el) => {
      try {
        const b = (el as SVGGraphicsElement).getBBox();
        if (b.width === 0 && b.height === 0) return;
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
      } catch {
        // getBBox throws on not-yet-rendered elements in some browsers;
        // skip the offender and keep iterating.
      }
    });
    if (Number.isFinite(minX) && Number.isFinite(maxX) && maxX > minX && maxY > minY) {
      const w = maxX - minX;
      const h = maxY - minY;
      const pad = cropPadding * Math.max(w, h);
      contentViewBox = `${minX - pad} ${minY - pad} ${w + 2 * pad} ${h + 2 * pad}`;
      contentAspect = (w + 2 * pad) / (h + 2 * pad);
    }
  }

  const serializer = new XMLSerializer();
  let svgString = serializer.serializeToString(svgEl);
  if (!svgString.includes('xmlns="http://www.w3.org/2000/svg"')) {
    svgString = svgString.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (contentViewBox) {
    if (/viewBox="[^"]*"/.test(svgString)) {
      svgString = svgString.replace(/viewBox="[^"]*"/, `viewBox="${contentViewBox}"`);
    } else {
      svgString = svgString.replace('<svg', `<svg viewBox="${contentViewBox}"`);
    }
    // Strip explicit width/height attrs so the viewBox alone drives the
    // intrinsic aspect ratio. The drawImage step below sets the raster
    // dimensions; without stripping these the SVG could clip the new
    // viewBox to the old element-size box.
    svgString = svgString.replace(/\s(width|height)="[^"]*"/g, '');
  }

  if (format === 'svg') {
    pushEvent(
      'RENDER_CANVAS',
      `format=svg,showAtomIds=${showAtomIds},crop=${cropToContent}`,
    );
    return btoa(unescape(encodeURIComponent(svgString)));
  }

  // Raster dimensions: explicit target wins; otherwise back-compat
  // clientRect; otherwise sensible fallback.
  const bbox = svgEl.getBoundingClientRect();
  const fallbackW = Math.max(1, Math.round(bbox.width || svgEl.clientWidth || 600));
  const fallbackH = Math.max(1, Math.round(bbox.height || svgEl.clientHeight || 400));
  // Explicit dims win. Otherwise, if cropToContent gave us a content aspect,
  // derive dims from it at a fixed long edge so the molecule keeps its true
  // proportions. Fall back to the full-canvas clientRect only when neither is
  // available (legacy un-cropped render).
  const CROP_LONG_EDGE = 1100;
  let width: number;
  let height: number;
  if (opts?.width || opts?.height) {
    width = opts?.width ? Math.max(1, Math.round(opts.width)) : fallbackW;
    height = opts?.height ? Math.max(1, Math.round(opts.height)) : fallbackH;
  } else if (contentAspect && Number.isFinite(contentAspect) && contentAspect > 0) {
    if (contentAspect >= 1) {
      width = CROP_LONG_EDGE;
      height = Math.max(1, Math.round(CROP_LONG_EDGE / contentAspect));
    } else {
      height = CROP_LONG_EDGE;
      width = Math.max(1, Math.round(CROP_LONG_EDGE * contentAspect));
    }
  } else {
    width = fallbackW;
    height = fallbackH;
  }
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Failed to decode Ketcher SVG into an Image'));
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/png');
    pushEvent(
      'RENDER_CANVAS',
      `format=png,showAtomIds=${showAtomIds},w=${width},h=${height},crop=${cropToContent}`,
    );
    const prefix = 'data:image/png;base64,';
    return dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
  } finally {
    if (savedKetForRestore !== null) {
      try {
        await ketcher.setMolecule(savedKetForRestore);
      } catch {
        // Restore failure — best effort. Subsequent canvas reads will
        // see the dearomatized state, but the render-diff dump already
        // captured what it needed.
      }
    }
  }
}

async function loadKet(ket: string) {
  await getKetcher().setMolecule(ket);
  pushEvent('LOAD_KET');
}

// Resolve the Indigo API base path used by the in-browser bridge. The runtime
// passes ?api_path=/__api/ when started in remote mode (see runtime.ts and
// App.tsx) and the Node-side proxy at /__api/ forwards to the Indigo Docker
// service. In standalone mode there is no api_path query param and we surface
// a stable error code that matches tools/ingest.ts's classifier.
function getRemoteApiPath(): string | null {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('api_path');
    if (fromQuery) return fromQuery.endsWith('/') ? fromQuery : `${fromQuery}/`;
  } catch {
    /* fall through */
  }
  return null;
}

async function constructReaction(reactantSmiles: string, productSmiles: string) {
  const ketcher = getKetcher();
  // Reaction SMILES format: "reactants>>products" (reagents are between the >>;
  // we leave that empty for now). Ketcher's struct service parses this and
  // produces a struct with reactants on the left, an arrow, and products on
  // the right. setMolecule then routes through prepareStructToRender which
  // hands it to indigo for layout.
  const reactionSmiles = `${reactantSmiles}>>${productSmiles}`;
  const struct = await prepareStructToRender(
    reactionSmiles,
    ketcher.structService,
    ketcher,
  );
  const ketSerializer = new KetSerializer();
  await ketcher.setMolecule(ketSerializer.serialize(struct));
  pushEvent('CONSTRUCT_REACTION', `reactants=${reactantSmiles},products=${productSmiles}`);
}

async function exportRxn(format: 'v2000' | 'v3000' = 'v2000') {
  const ketcher = getKetcher();
  if (!ketcher.containsReaction()) {
    throw new Error('No reaction on the canvas (no reaction arrow). Use construct_reaction first.');
  }
  return await ketcher.getRxn(format);
}

async function exportReactionSmiles() {
  const ketcher = getKetcher();
  // Ketcher's getSmiles() emits reaction-SMILES (with >>) automatically when
  // the canvas contains a reaction arrow.
  return await ketcher.getSmiles();
}

function listRecentEvents(limit = 20) {
  const capped = Math.max(0, Math.min(limit, MAX_EVENTS));
  return events.slice(-capped);
}

function initializeEventSubscriptions(ketcher: any) {
  ketcher.changeEvent.add(() => pushEvent('CHANGE_EVENT'));
  ketcher.eventBus.on('LOADING', () => pushEvent('ASYNC_LOADING'));
  ketcher.eventBus.on('SUCCESS', () => pushEvent('ASYNC_SUCCESS'));
  ketcher.eventBus.on('FAILURE', () => pushEvent('ASYNC_FAILURE'));
}

export const ketcherAgentBridge = {
  initializeEventSubscriptions,
  getState,
  getAnnotatedState,
  loadSmiles,
  loadMolfile,
  loadKet,
  renderCanvas,
  setBondOrder,
  setBondStereo,
  setWedgeBond,
  setAtomCharge,
  setAtomElement,
  setAtomIsotope,
  setAtomStereoLabel,
  setAtomRadical,
  setAtomXY,
  setAtomImplicitHCount,
  setAtomExplicitValence,
  addAtomWithSingleBond,
  addFragment,
  deleteAtom,
  addBond,
  deleteBond,
  layout,
  clean,
  aromatize,
  dearomatize,
  resetToSnapshot,
  clearCanvas,
  listRecentEvents,
  validateState,
  validateSmilesString,
  exportMolfile,
  exportCanonicalSmiles,
  constructReaction,
  exportRxn,
  exportReactionSmiles,
};

declare global {
  interface Window {
    __ketcherAgent: typeof ketcherAgentBridge;
  }
}
