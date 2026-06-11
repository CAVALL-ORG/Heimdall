# GraphIntent Count Contract

All `GraphIntent` producers — including image rebuild — must fill the
`counts` field before calling `build_from_graph`. The translator verifies
the produced canvas against `counts`; mismatch triggers rollback + throw.

## Fields

```ts
counts: {
  heavy: number;                       // total non-H atom count
  rings: number;                       // backend/compiler ring count
  heteroatoms: Record<string, number>; // per-element + 'halogens' bucket
  drawn_H_atoms?: number[];            // ids of atoms with a non-null drawn_H
  degree_sequence?: Array<[string, number]>;
}
```

### `heavy`

Every drawn non-hydrogen atom counted once. Atoms shared between visible
loops count **once**, not once per loop. Wedge / dash neighbors counted
once. Explicit H labels (NH, NH₂, OH) contribute to `drawn_H` on the
parent atom, **not** to `heavy`.

### `rings`

The **Euler ring count** of the graph: `bonds − atoms + connected_components`
(the circuit rank the validator enforces) — NOT "number of drawn faces." For a
fused polycyclic system this equals the number of drawn rings; for a bridged
cage it is FEWER (cubane: 6 drawn faces, but Euler 5 — declare 5). The image
agent does not compute SSSR, but `counts.rings` MUST equal the independent-cycle
count its own `bonds[]` imply: the build cross-checks exactly that
(`computeCounts`) and rejects a mismatch. Per schema rule #9, `counts.rings`
also equals `rings.length` (the `rings[]` array length).

### `heteroatoms`

Per-element heavy-atom count for every non-C, non-H element drawn.
Halogens (F, Cl, Br, I) are tallied under a single `halogens` key —
the contract treats them as one bucket because vision routinely
misreads `F` vs `Cl` and the count-check should still catch a
missed-halogen error even when the specific halogen was wrong.

Example: chloroform (CHCl₃) → `{halogens: 3}`. Chloroform with one
F mis-OCR'd as Cl → still `{halogens: 3}` (the heteroatom-class check
passes; the per-atom `element` field is what the SMILES export will
ultimately surface).

Elements other than halogens get their own key: `N`, `O`, `S`, `P`,
`B`, `Si`, `Se`, etc. Omit entries that are zero.

### `drawn_H_atoms` (optional — recommended for tautomer-sensitive substrates)

List the atom ids whose `drawn_H` is non-null. The validator rejects
when this set differs from `{ atom.id : atom.drawn_H != null }`.
Catches summary-vs-detail drift such as typos and mid-emission edits.
Cytosine N1-H tautomer → `drawn_H_atoms: [<N1 atom id>]`.

### `degree_sequence` (optional)

Per-atom `[element, sum of bond orders]` across the GraphIntent. The
validator computes the same vector from `atoms[]` + `bonds[]`, sorts
lexicographically, and rejects on mismatch.

## Worked counts

### Benzene

```
counts: { heavy: 6, rings: 1, heteroatoms: {} }
```

### Pyridine

```
counts: { heavy: 6, rings: 1, heteroatoms: { N: 1 } }
```

### Naphthalene

```
counts: { heavy: 10, rings: 2, heteroatoms: {} }
```

### Anisole (methoxybenzene)

```
counts: { heavy: 8, rings: 1, heteroatoms: { O: 1 } }
```

### Cytosine (N1-H tautomer)

```
counts: { heavy: 8, rings: 1, heteroatoms: { N: 3, O: 1 } }
```

The drawn N1-H is captured in `drawn_H` on the N1 atom — **not** in
`heavy`. `heavy` counts heavy atoms only.

### Sodium acetate (two-component salt)

```
counts: { heavy: 5, rings: 0, heteroatoms: { Na: 1, O: 2 } }
```

Two disconnected fragments share one `GraphIntent`; total heavy
atoms across both fragments is what `heavy` reports.

## Mismatch handling

`build_from_graph({graph, validate_counts: true})` (default) compares
`graph.counts` against `computeCounts(canvas)`. If any field differs,
the translator throws `BuildFromGraphError("count_mismatch", diff)`,
`runtime.applyMutation` rolls the canvas back, and the agent must
recount the source image and emit a new `GraphIntent`.

`validate_counts: false` is **FORBIDDEN on image rebuild** — the
`build_from_graph` tool pins the count cross-check ON for the image path
regardless of the caller's value (an agent self-authorizing `false` once
silently shipped a wrong fused-core skeleton). A count mismatch is a
transcription error to FIX by re-reading the image, never to silence. A
`counts.rings` mismatch in particular usually means a **fusion-atom-sharing
error** — you split a fused core into disjoint ring blocks, so your `bonds[]`
form more cycles than you declared — NOT a benign SSSR difference. (Non-image
producers historically passed `false` to prove counts by construction; the
tool now ignores it.)
