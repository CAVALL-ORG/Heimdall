# Known SMILES-Writer Quirks

Ketcher's SMILES writer has a few corners that silently produce a wrong
canonical export even when the bridge mutation succeeded and `get_state`
shows the correct atom/bond table. These are workarounds, not bugs to fix
in our code — Ketcher's behaviour is the source.

## Aromatic-cation protonation (pyridinium, imidazolium, thiazolium, …)

Do NOT use `set_atom_charge` + `set_atom_implicit_h_count` to protonate
an aromatic ring atom. Ketcher's SMILES writer recomputes implicit H from
valence for aromatic `[n+]` / `[o+]` / `[s+]` and drops the explicit H
even though the bridge stored it.

Verified case: pyridine →
`set_atom_charge(N, +1) + set_atom_implicit_h_count(N, 1)` exports as
`c1cc[n+]cc1` instead of `c1cc[nH+]cc1`.

**Workaround — use the load path.** Compute the target SMILES with the
explicit bracket atom (`[nH+]`, `[oH+]`, `[sH+]`) using chemistry
knowledge, then `load_smiles({ "smiles": "c1cc[nH+]cc1" })`. Load
preserves explicit H; edit-then-export does not.

The same workaround applies any time a mutation produces an aromatic
charged atom whose H is implicit in valence but explicit in the canonical
SMILES — when in doubt, prefer the load path for aromatic-charge changes.

## Aromaticity-aware implicit-H clamping

`set_atom_implicit_h_count` on an aromatic ring atom is silently clamped
by Ketcher's auto-valence to whatever the ring's π count permits. The
bridge wraps this with an explicit-valence pre-set so the requested
count survives; see `server/src/ui/bridge.ts` around the
`setAtomImplicitHCount` section for the implementation detail. Skills
should not need to reason about the clamp themselves — call the tool and
trust the mutation receipt.

## Round-trip detection

To detect writer quirks, round-trip a structure through
`export_smiles` then `load_smiles`. If the canonical form differs from
the expected bracket-H form, build the correct SMILES via the load path
and re-validate.

## Stereo cheat sheet (READ-ONLY — Ketcher writes these)

The mnemonic below applies **only** to the linear pattern
`X[slash]C=C[slash]X` where both slashes sit outside the C=C (e.g.
`F/C=C\F`). As soon as a substituent moves inside a branch
(`C(/X)=C\Y`) the same slashes may encode the opposite isomer, because
each `/`/`\` is a directional vector on the bond *as written*, not a
side-label on the double bond.

- `F/C=C/F` and `F\C=C\F` → **trans (E)** (substituents opposite).
- `F/C=C\F` and `F\C=C/F` → **cis (Z)** (substituents same side).

Producers (image-rebuild, etc.) never write these slashes — they emit a
GraphIntent with bond orders + as-drawn geometry, the translator runs
`clean()` so Indigo lays out a chemically reasonable geometry, and
`export_smiles` emits the slashes itself. The table above only exists
so you can sanity-check what Ketcher emitted.

Past failure (RT001 cis-stilbene): the agent applied this mnemonic to a
branched SMILES `C(/c1)=C\c1ccccc1` and concluded "cis"; RDKit
canonicalized to trans. The mnemonic does not survive moving a
substituent into a branch.

## Wedge-stereo footgun

Raw `set_bond_stereo(bondId, 'up'|'down')` interprets stereo relative
to whichever atom is `bond.begin`. If the wedge bond was created with
the chiral neighbor as begin (e.g. via `add_bond(neighborId,
chiralId, 1)`), the same `'up'` flag silently inverts CIP. Concrete
past failure: L-phenylalanine — agent used `set_bond_stereo`,
bond.begin was the phenyl-side carbon, RDKit canonicalized to D.

Producers emit `wedge_from` on the chiral atom; the translator routes
through `setWedgeBond(chiralId, neighborId, wedge)`, which auto-orients
the bond so the chiral atom is always `bond.begin`. The footgun is
removed at the translator boundary — image-rebuild callers never see it.

## Tautomer-equivalence trap

Histidine and cytosine are classic failures — the agent built
"the remembered tautomer" instead of the drawn one. RDKit canonicalizes
N1-H and N3-H of cytosine to *different* SMILES, so "they're equivalent"
is wrong as a grader bypass.

Producers carry the drawn H in `drawn_H` on the specific atom that
bears it. The translator applies `drawn_H` after `aromatize()` so the
explicit H survives Ketcher's aromaticity-aware implicit-H clamp.

## Skeleton miscount trap

Common dense-molecule miscounts (paclitaxel C45 vs C47, sildenafil missing
CH₂, oseltamivir regio) are atom-miscount errors. The `counts` field on
GraphIntent forces commitment to heavy / rings / heteroatoms BEFORE
build; `build_from_graph` aborts on mismatch, reverts canvas, returns
error. Recount and retry — do not try to "patch" the wrong skeleton.

