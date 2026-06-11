#!/usr/bin/env python3
"""
Trim whitespace around the drawn molecule in each panel source PNG.

Why: several test-fixture PNGs (notably the tier-2 academic + macrocycle
rows) are rendered on a wide 1176×638 canvas with the molecule sitting
in the middle. Loaded into the panel PDF at a fixed 4.2 cm cell height
they appear tiny, even though the rendered fixture itself is full-size.

This script finds the bounding box of non-white pixels per source PNG,
crops with a small padding margin, and writes to
tests/panels/cropped/<bucket>/<fixture>.png. The panel .tex's
\graphicspath searches cropped/ first, so cropped versions take effect
without touching the original fixtures under tests/scientific/images/
(which are test inputs and must stay untouched).

Run from the repo root:
    python3 tests/panels/crop-source-pngs.py

Idempotent — re-run any time fixtures are added or replaced.
"""
import os
from pathlib import Path
from PIL import Image, ImageChops

REPO_ROOT = Path(__file__).resolve().parents[2]
SRC_ROOT  = REPO_ROOT / 'tests' / 'scientific' / 'images'
DST_ROOT  = REPO_ROOT / 'tests' / 'panels' / 'cropped'

# Panel-member PNGs that benefit from cropping. Source paths are relative
# to tests/scientific/images/. Restrict to wide-aspect canvases where the
# molecule under-fills the canvas — narrow / fitted PNGs (benzene_clean,
# glucose_pyranose, glycine_zwitterion_clean, etc.) crop to themselves
# and waste cycles.
TARGETS = [
    'academic/penicillin_g.png',
    'academic/taxol_core.png',
    'academic/atp.png',
    'academic/vinblastine.png',
    'academic/hemibrevetoxin_b.png',
    'diverse/porphine.png',
    'diverse/thymine.png',
]

PADDING_PX = 40   # uniform padding around the content bbox

def crop_to_content(src: Path, dst: Path, pad: int) -> tuple[tuple[int,int], tuple[int,int]]:
    """Crop a panel-source PNG to its non-white content bbox.

    Handles three mode classes:
      - RGB        — direct white-pixel detection.
      - LA / RGBA  — composite onto white BEFORE detection (transparent
                     ink pixels would otherwise come through as pure
                     black after a naive .convert('RGB') and the whole
                     canvas would look like content). Source fixtures
                     under tests/scientific/images/ mix all three modes;
                     test runs do their own compositing so the original
                     test inputs stay untouched.
    """
    raw = Image.open(src)
    w, h = raw.size
    if raw.mode in ('LA', 'RGBA', 'PA'):
        bg = Image.new('RGBA', raw.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, raw.convert('RGBA')).convert('RGB')
    else:
        img = raw.convert('RGB')
    # difference from a pure-white image; non-zero pixels => content.
    white = Image.new('RGB', img.size, (255, 255, 255))
    diff  = ImageChops.difference(img, white)
    bbox  = diff.getbbox()
    if bbox is None:
        cropped = img            # blank canvas — copy as-is
    else:
        l, t, r, b = bbox
        l = max(0, l - pad)
        t = max(0, t - pad)
        r = min(w, r + pad)
        b = min(h, b + pad)
        cropped = img.crop((l, t, r, b))
    dst.parent.mkdir(parents=True, exist_ok=True)
    cropped.save(dst, optimize=True)
    return (w, h), cropped.size

def main():
    print(f"Source: {SRC_ROOT}")
    print(f"Dest:   {DST_ROOT}")
    print()
    for rel in TARGETS:
        src = SRC_ROOT / rel
        dst = DST_ROOT / rel
        if not src.exists():
            print(f"  SKIP (missing) {rel}")
            continue
        before, after = crop_to_content(src, dst, PADDING_PX)
        ratio = (after[0] * after[1]) / (before[0] * before[1])
        print(f"  OK {rel:50s} {before[0]}x{before[1]} -> {after[0]}x{after[1]}  ({ratio:.2%} of original)")

if __name__ == '__main__':
    main()
