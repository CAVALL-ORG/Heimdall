# heimdall-image-rebuild — examples

Worked traces. The normative contract lives in [SKILL.md](SKILL.md); if anything here disagrees, SKILL.md wins.

All examples use the **direct GraphIntent shape** (atoms + bonds + rings + counts). This is the one submission shape.

---

## Example A — Small printed molecule, no zoom

A 9-heavy single-ring substituted benzene. No wedges, no charges.

```
Read inputs/source.png
```

```ts
validate_graph({
  version: 1,
  atoms: [
    { id: 1, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', x: 200, y: 100 },
    { id: 2, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', x: 230, y: 130 },
    { id: 3, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', x: 230, y: 170 },
    { id: 4, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', x: 200, y: 200 },
    { id: 5, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', x: 170, y: 170 },
    { id: 6, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: 'r1', x: 170, y: 130 },
    // ipso C7, plus O8 (drawn_H: 1) and O9 on C7
    { id: 7, element: 'C', drawn_H: null, charge: 0, radical: 0, ring: null, x: 200, y: 60 },
    { id: 8, element: 'O', drawn_H: 1,    charge: 0, radical: 0, ring: null, x: 165, y: 35 },
    { id: 9, element: 'O', drawn_H: null, charge: 0, radical: 0, ring: null, x: 235, y: 35 },
  ],
  bonds: [
    { a: 1, b: 2, order: 2, wedge: null, wedge_from: null },
    { a: 2, b: 3, order: 1, wedge: null, wedge_from: null },
    { a: 3, b: 4, order: 2, wedge: null, wedge_from: null },
    { a: 4, b: 5, order: 1, wedge: null, wedge_from: null },
    { a: 5, b: 6, order: 2, wedge: null, wedge_from: null },
    { a: 6, b: 1, order: 1, wedge: null, wedge_from: null },
    { a: 1, b: 7, order: 1, wedge: null, wedge_from: null },
    { a: 7, b: 8, order: 1, wedge: null, wedge_from: null },
    { a: 7, b: 9, order: 2, wedge: null, wedge_from: null },
  ],
  rings: [{ id: 'r1', atoms: [1, 2, 3, 4, 5, 6], kind: 'kekule' }],
  counts: { heavy: 9, rings: 1, heteroatoms: { O: 2 } },
})
// → { ok: true }

build_from_graph(<same graph>); render_canvas; export_smiles
// → "OC(=O)c1ccccc1"
```

### Final message
```
9 heavy, 1 aromatic ring, 1 carboxyl group. No zooms.
SMILES: OC(=O)c1ccccc1
```

---

## Example B — Mid-complexity image, one ambiguous glyph

One glyph reads as "OMe" but the printed characters are slightly smeared.
Preflight names the glyph atom for zoom.

```ts
Read inputs/source.png
validate_graph({
  version: 1,
  atoms: [
    // 14 ring/chain atoms at high confidence, plus one shorthand glyph.
    // Shorthand RAW TEXT goes in `shorthand`; `element` is a required 1-2 char
    // placeholder that the backend ignores (convention: 'C'). The deterministic
    // table expands `OMe` → O–CH3 during build. The agent never decomposes.
    { id: 14, element: 'C', shorthand: 'OMe', drawn_H: null, charge: 0,
      radical: 0, ring: null, x: 410, y: 220, charge_confidence: 'high',
      drawn_H_confidence: 'needs_zoom' },
    // ... (other atoms)
  ],
  bonds: [ /* ... */ ],
  rings: [ /* one ring walk */ ],
  counts: { heavy: 15, rings: 1, heteroatoms: { O: 1 } },
  unresolved: [{ field: 'node_glyph_text', record_id: '14',
    note: 'glyph characters smeared at (410,220)', state: 'needs_zoom' }],
})
// → ok: false; unresolved_remaining names atom 14 at (410, 220), bbox_radius 40.

crop_source_image(sourceImagePath, x=380, y=190, w=80, h=80)
Read outputs/.../crops/380_190_80_80.png
// CROP_RATIONALE: outputs/.../crops/380_190_80_80.png resolved
//   14:node_glyph_text=OMe from printed characters "O", "M", "e"
//   clearly readable at upper-right of crop

// flip drawn_H_confidence → 'high', drop unresolved[] entry, re-validate, build, export
```

### Final message
```
15 heavy, 1 ring, 1 OMe glyph (zoomed). SMILES: <ketcher canonical>
```
