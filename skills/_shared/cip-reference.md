# CIP rules — quick reference

Loaded by `heimdall-image-rebuild` when the agent uses the R/S `stereo_label`
escape hatch (in lieu of the default wedge-primitive transcription). The
reference distills the Cahn-Ingold-Prelog priority + R/S determination rules
so the agent can emit `{center, stereo_label: 'R' | 'S' | 'unknown'}` entries
from a source drawing.

The agent never types `@`/`@@` — `stereo_label` is the CIP letter only.
Uncertainty maps to `stereo_label: 'unknown'`, not to a guessed R/S.

## Priority ordering at a stereocenter

For each of the four substituents off the chiral atom, walk outward and
compare in this order:

1. **Atomic number at the first sphere.** Higher atomic number wins.
   `I > Br > Cl > S > P > F > O > N > C > H`. A double bond counts as
   *two* copies of the partner atom (phantom-atom convention) for
   priority purposes: `C=O` ranks as if the C has TWO O neighbors.
2. **Tie-break by the next sphere.** If the first-sphere atoms tie,
   compare the highest-priority neighbor of each. Continue outward, one
   sphere at a time, until a difference is found. Compare ordered tuples
   (largest first), not multisets.
3. **Isotope / stereo descriptor as last resort.** Higher mass wins;
   then descriptor priority (Z over E, R over S, M over P).

Practical heuristics that cover most real cases:

- Halogens almost always win priority 1 if any are present at the center.
- An sp² neighbor with `=O` (carbonyl) usually outranks a saturated CH₂
  because the phantom-atom rule double-counts the O.
- Phenyl outranks methyl because the ring atoms count as `(C, C, C)`
  via the aromatic ring duplication, vs methyl's `(H, H, H)`.
- An implicit H is always priority 4.

## Wedge / hash interpretation

- **Solid wedge** (filled triangle, narrow end on the chiral atom):
  bond points TOWARD the viewer (out of the page).
- **Hashed wedge** (striped/dashed triangle, narrow end on the chiral
  atom): bond points AWAY from the viewer (into the page).
- A normal line bond is in the plane of the page.

The wedge attaches to the chiral atom; the wide end identifies the
out-of-plane neighbor.

## R/S from a 2D drawing

1. Assign priorities 1–4 (1 highest, 4 lowest) to the four substituents.
2. Orient mentally so priority 4 points AWAY from you (into the page).
   - If priority 4 is already on a hashed wedge: read directly.
   - If priority 4 is on a solid wedge (toward you): read the rotation,
     then **invert** the result.
   - If priority 4 is in the plane: rotate the molecule mentally (or
     use the cross-fingers trick — swap two priorities, read, swap
     back to invert).
3. Trace 1 → 2 → 3:
   - Clockwise → **R**
   - Counter-clockwise → **S**

## Worked example — paclitaxel C3' (α-amide side chain)

Drawing: C3' is a CH center bearing
- a benzamide nitrogen (NHC(=O)Ph)
- a phenyl ring
- an oxygen ester (OC(=O)CHR)
- an implicit H, drawn as a hash wedge into the page

Priority ranking:
1. O (ester) — highest atomic number at first sphere
2. N (benzamide) — second highest
3. C (phenyl) — sp² C ranked as (C, C, C); higher than CH₂ but lower
   than N
4. H (implicit) — always last

Wedge: priority-4 H is on the hashed wedge (away from viewer). Read
directly. Tracing O → N → phenyl traces clockwise in the source.
**stereo_label: 'R'**.

Emit:

```json
{ "center": 17, "stereo_label": "R" }
```

## Worked example — paclitaxel C8 (methylated quaternary bridgehead)

C8 is a quaternary carbon at the bridgehead between the A and B rings,
bearing
- a methyl group (drawn outside the ring)
- a CH₂ (into the C ring)
- a CH ring atom (into the B ring)
- a CH ring atom (into the A ring)

There is no implicit H — C8 is quaternary. The four substituents are
all sp³ carbons; priority depends on what each one's neighbors are.

Priority ranking (require tree comparison):
1. The ring carbon whose tree includes the C9 ketone (=O appears
   one sphere out) — highest because the phantom-atom O double-counts.
2. The other ring carbon (in the A ring, no =O at sphere 2 but a
   higher substituent count).
3. The CH₂ between A and B.
4. The methyl group (only H at sphere 2 — lowest).

If the source drawing puts methyl on a solid wedge (toward viewer) and
1→2→3 traces clockwise in the page, then with priority 4 toward viewer
we invert: actual sense is counter-clockwise = **S**.

Emit:

```json
{ "center": 14, "stereo_label": "S" }
```

If the priority comparison at sphere 2+ feels uncertain, emit
`stereo_label: 'unknown'` and let the grader credit the site as
match-any. Do not guess.

## When to use `'unknown'`

- The drawing is too small / cluttered to read the wedge polarity at
  this center.
- The four substituents are too similar to confidently priority-rank by
  CIP (rare; usually only at hindered quaternary carbons in natural
  products).
- The center is conventionally implied (D-/L-sugars, ATP) and the source
  does not draw a wedge — same convention-implied semantics as the
  wedge-primitive path.
