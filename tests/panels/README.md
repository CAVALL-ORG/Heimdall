# tests/panels/

Typeset PDF companions for the panel definitions in
[../AGENT_RUNBOOK.md](../AGENT_RUNBOOK.md) §Panels. Each panel is a
curated subset of an existing manifest that exercises every distinct
failure surface of a skill at least once. The runbook holds the
source-of-truth id list + trigger phrase + coverage table; these PDFs
are the typeset reference companion showing one row per panel member
with image thumbnail + rationale.

## Panels

| PDF | Source manifest | Rows | Trigger |
|---|---|---|---|
| [`image-to-smiles.pdf`](image-to-smiles.pdf) | [`../ketcher/image-to-smiles/manifest.jsonl`](../ketcher/image-to-smiles/manifest.jsonl) | 16 | `Run image-to-smiles panel per the runbook` |

## Recompile

```bash
cd tests/panels
xelatex -interaction=nonstopmode -halt-on-error image-to-smiles.tex
xelatex -interaction=nonstopmode -halt-on-error image-to-smiles.tex   # second pass for hyperref
```

Images resolve via `\graphicspath{{cropped/}{../scientific/images/}}`.
`cropped/` holds whitespace-trimmed copies of a few wide-canvas
fixtures (tier-2 academic + macrocycle rows) where the raw 1176×638
canvas makes the molecule appear tiny at the panel's 4.2 cm cell
height. LaTeX prefers `cropped/` when a path exists in both — so simple
rows still resolve to the originals under `../scientific/images/` and
no PNG duplication happens for them.

To regenerate `cropped/` after a fixture is added or replaced:

```bash
python3 tests/panels/crop-source-pngs.py
```

The cropper is idempotent — re-running on a fixture that already fills
its canvas leaves it unchanged. Adjust the `TARGETS` list in
[`crop-source-pngs.py`](crop-source-pngs.py) if a new dense fixture
joins the panel.

xelatex byproducts (`.aux`, `.log`, `.out`) are gitignored — see
[`.gitignore`](.gitignore). Cropped PNGs are checked in so contributors
without Pillow can still recompile.

## Adding a new panel

1. Add `PANEL_<NAME>` block + filter rule + per-row coverage table to
   [`../AGENT_RUNBOOK.md`](../AGENT_RUNBOOK.md) §Panels.
2. Author `<panel-slug>.tex` here, copying the structure of
   `image-to-smiles.tex` (preamble, `\panelrow{...}` macro, abstract,
   per-row entries, coverage matrix).
3. Compile twice and check `Overfull` count is zero.
4. Add a row to the table above pointing at the new PDF.
