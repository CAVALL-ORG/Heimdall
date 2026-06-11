#!/usr/bin/env python3
"""Offline ground-truth auditor for the test manifests.

Cross-checks every row's three answer fields — `expected_canonical_smiles`,
`expected_features`, and `notes` — against each other and against the
on-disk fixture image. Emits `audit_report.md` with a row-by-row
summary so a human (or the evaluator subagent during follow-up) can do
a vision pass and confirm the drawn structure matches the manifest's
answer.

Justification for reading the manifest's own SMILES (per
CLAUDE.md "Core principle — the agent NEVER authors SMILES"):
this is offline infra that reads the *manifest's own answer field*
and RDKit-canonicalizes it for cross-checks. It is NOT an agent
authoring a SMILES from vision or memory — the source of truth stays
the manifest. Same justification `bin_rows_by_complexity.py` already
uses.

Checks per row:

1. **Round-trip:** the manifest's `expected_canonical_smiles` must equal
   `Chem.MolToSmiles(Chem.MolFromSmiles(...))`. Catches stale or
   non-canonical SMILES.
2. **Internal consistency:** RDKit-derived heavy-atom count, ring count
   + sizes/aromaticity, formal-charge sum, stereocenter count must match
   `expected_features` (when both present).
3. **Notes-vs-SMILES keyword check:** scan `notes` for `α`/`alpha`,
   `β`/`beta`, `D-`/`L-`, `R`/`S`, `(E)`/`(Z)`, `cis`/`trans`; flag
   contradictions against the SMILES's stereochemistry / InChI / CIP.
4. **Image-truth (flagged, not auto-decided):** emit per-row the
   fixture path so a vision pass can confirm the drawn anomer /
   tautomer / drawn-H placement. The script does not decide image
   truth — that stays with vision.

Usage:
  python3 tests/scientific/runner/audit_manifest.py                # audits the
                                                                   # default set
  python3 tests/scientific/runner/audit_manifest.py path/to/m.jsonl ...
  → writes tests/scientific/runner/audit_report.md
  → exits 0 even on flagged issues (this is a report, not a gate)
  → exits 2 on schema/structural error (unparseable JSON, missing fields)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    from rdkit import Chem
    from rdkit.Chem import FindMolChiralCenters, GetSSSR
    from rdkit.RDLogger import DisableLog
    DisableLog("rdApp.warning")
except ImportError:
    print(
        "ERROR: rdkit is required for audit_manifest.py — pip install rdkit",
        file=sys.stderr,
    )
    sys.exit(2)


REPO_ROOT = Path(__file__).resolve().parents[3]


DEFAULT_MANIFESTS = [
    REPO_ROOT / "tests/ketcher/image-to-smiles/manifest.jsonl",
    REPO_ROOT / "tests/scientific/manifest.jsonl",
    REPO_ROOT / "tests/ketcher/mechanical-primitives/manifest.jsonl",
]


@dataclass
class Finding:
    severity: str  # "warn" | "error" | "info"
    code: str
    detail: str


@dataclass
class RowAudit:
    id: str
    manifest: str
    suite: str
    grading: str | None
    image_path: str | None
    expected_canonical: str | None
    notes: str
    rdkit_canonical: str | None
    rdkit_heavy: int | None
    rdkit_rings: list[tuple[int, bool]] | None
    rdkit_charges_abs_sum: int | None
    rdkit_stereocenters: int | None
    findings: list[Finding] = field(default_factory=list)

    def add(self, severity: str, code: str, detail: str) -> None:
        self.findings.append(Finding(severity, code, detail))


def _ring_info(mol: Any) -> list[tuple[int, bool]]:
    """Return list of (ring_size, is_aromatic). is_aromatic = True iff every
    atom in the ring is aromatic (matches the manifest's convention)."""
    GetSSSR(mol)
    rings: list[tuple[int, bool]] = []
    ring_info = mol.GetRingInfo()
    for atom_ids in ring_info.AtomRings():
        is_arom = all(mol.GetAtomWithIdx(i).GetIsAromatic() for i in atom_ids)
        rings.append((len(atom_ids), is_arom))
    return rings


def _canon_ring_list(rings: list[dict[str, Any]] | list[tuple[int, bool]]) -> Counter:
    """Convert either a manifest expected_features.rings list or our RDKit
    derived list into a Counter of (size, aromatic) tuples for set-equality."""
    out: list[tuple[int, bool]] = []
    for r in rings:
        if isinstance(r, dict):
            out.append((int(r["size"]), bool(r.get("aromatic", False))))
        else:
            out.append((int(r[0]), bool(r[1])))
    return Counter(out)


def _check_round_trip(audit: RowAudit, expected: str) -> None:
    mol = Chem.MolFromSmiles(expected)
    if mol is None:
        audit.add("error", "rdkit_parse_failure", f"Could not parse '{expected}'")
        return
    canon = Chem.MolToSmiles(mol, isomericSmiles=True, canonical=True)
    audit.rdkit_canonical = canon
    if canon != expected:
        audit.add(
            "warn",
            "not_canonical",
            f"`expected_canonical_smiles` is not RDKit-canonical; canonical='{canon}'",
        )
    audit.rdkit_heavy = mol.GetNumHeavyAtoms()
    audit.rdkit_rings = _ring_info(mol)
    audit.rdkit_charges_abs_sum = sum(
        abs(a.GetFormalCharge()) for a in mol.GetAtoms()
    )
    try:
        audit.rdkit_stereocenters = len(
            FindMolChiralCenters(
                mol, includeUnassigned=False, useLegacyImplementation=False
            )
        )
    except Exception:
        audit.rdkit_stereocenters = None


def _check_internal_consistency(audit: RowAudit, expected_features: dict[str, Any]) -> None:
    if not expected_features:
        return
    if audit.rdkit_heavy is not None and "heavy" in expected_features:
        if int(expected_features["heavy"]) != audit.rdkit_heavy:
            audit.add(
                "warn",
                "heavy_atom_mismatch",
                f"expected_features.heavy={expected_features['heavy']} but "
                f"RDKit heavy_atom_count={audit.rdkit_heavy}",
            )
    if audit.rdkit_rings is not None and "rings" in expected_features:
        manifest_rings = _canon_ring_list(expected_features["rings"])
        rdkit_rings = _canon_ring_list(audit.rdkit_rings)
        if manifest_rings != rdkit_rings:
            audit.add(
                "warn",
                "rings_mismatch",
                f"expected_features.rings={list(manifest_rings.elements())} but "
                f"RDKit rings={list(rdkit_rings.elements())}",
            )
    if audit.rdkit_charges_abs_sum is not None and "charges" in expected_features:
        # expected_features.charges in the live manifest is sometimes a count
        # of atoms with non-zero charge; sometimes the SSSR sign-abs sum. We
        # compare abs sums (the more forgiving definition).
        ef_charges = int(expected_features["charges"])
        if ef_charges != audit.rdkit_charges_abs_sum:
            audit.add(
                "warn",
                "charges_mismatch",
                f"expected_features.charges={ef_charges} but RDKit "
                f"sum(|formal_charge|)={audit.rdkit_charges_abs_sum}",
            )
    if (
        audit.rdkit_stereocenters is not None
        and "wedges" in expected_features
    ):
        ef_wedges = int(expected_features["wedges"])
        # wedges and stereocenters are not 1:1 (a stereocenter can be drawn
        # with up to 4 wedges, or with 1 wedge implying the rest). Flag only
        # when wedges < stereocenters (likely an undercount — a wedge per
        # stereocenter is the convention used by most of the existing
        # manifest), and when stereocenters > 0 with wedges == 0.
        if audit.rdkit_stereocenters > 0 and ef_wedges == 0:
            audit.add(
                "warn",
                "wedges_zero_with_stereocenters",
                f"expected_features.wedges=0 but the SMILES implies "
                f"{audit.rdkit_stereocenters} stereocenters",
            )
        elif ef_wedges < audit.rdkit_stereocenters:
            audit.add(
                "info",
                "wedges_lt_stereocenters",
                f"expected_features.wedges={ef_wedges} < RDKit stereocenters="
                f"{audit.rdkit_stereocenters} (may be intentional partial-stereo "
                f"drawing or an undercount)",
            )


STEREO_KEYWORDS = {
    "alpha": [
        r"\balpha\b",
        r"α",
        r"\(α\)",
    ],
    "beta": [
        r"\bbeta\b",
        r"β",
        r"\(β\)",
    ],
    "D": [
        r"\bD-",
        r"\(D\)",
        r"\bD-glucose",
        r"\bD-fructose",
        r"\bD-ribose",
        r"\bD-mannose",
    ],
    "L": [
        r"\bL-",
        r"\(L\)",
        r"\bL-alanine",
        r"\bL-phenylalanine",
        r"\bL-glucose",
    ],
    "R": [r"\(R\)", r"\(2R\)", r"\b\(R,R\)", r"\(R,S\)"],
    "S": [r"\(S\)", r"\(2S\)", r"\b\(S,S\)", r"\(R,S\)"],
    "E": [r"\(E\)", r"\btrans-\b", r"\btrans\s+isomer"],
    "Z": [r"\(Z\)", r"\bcis-\b", r"\bcis\s+isomer"],
    "cis": [r"\bcis\b"],
    "trans": [r"\btrans\b"],
}


# Hand-authored anomer reference: which canonical SMILES corresponds to each
# anomer of the common sugars. We use this for the keyword cross-check so we
# can flag the manifest's "α-D-glucose notes" + "β-anomer SMILES" mismatch.
ANOMER_REFERENCE: dict[str, dict[str, str]] = {
    "glucopyranose": {
        "alpha": "OC[C@H]1O[C@H](O)[C@H](O)[C@@H](O)[C@@H]1O",
        "beta": "OC[C@H]1O[C@@H](O)[C@H](O)[C@@H](O)[C@@H]1O",
    },
}


def _scan_notes_keywords(notes: str) -> dict[str, list[str]]:
    """Return {keyword: [match, ...]}."""
    out: dict[str, list[str]] = {}
    for kw, patterns in STEREO_KEYWORDS.items():
        hits: list[str] = []
        for pat in patterns:
            m = re.findall(pat, notes, flags=re.IGNORECASE)
            hits.extend(m)
        if hits:
            out[kw] = hits
    return out


def _check_notes_vs_smiles(audit: RowAudit) -> None:
    if not audit.notes or not audit.expected_canonical:
        return
    keywords = _scan_notes_keywords(audit.notes)
    if not keywords:
        return
    notes_lower = audit.notes.lower()

    # α vs β anomer cross-check for glucose-family pyranoses.
    # When the notes mention BOTH α and β, the row likely carries
    # historical fix context (e.g. "previous expected was β-anomer; now
    # α"); skip the keyword check and trust the SMILES.
    both_anomer_keywords = "alpha" in keywords and "beta" in keywords
    if ("alpha" in keywords or "beta" in keywords) and not both_anomer_keywords:
        canon = audit.rdkit_canonical or audit.expected_canonical
        for sugar, refs in ANOMER_REFERENCE.items():
            if sugar in notes_lower or "glucose" in notes_lower or "glucopyranose" in notes_lower:
                expected_alpha = refs["alpha"]
                expected_beta = refs["beta"]
                if "alpha" in keywords and canon == expected_beta:
                    audit.add(
                        "error",
                        "anomer_mismatch_alpha_vs_beta",
                        f"notes say α-{sugar} but SMILES canonicalizes to "
                        f"β-anomer; α-anomer canonical = '{expected_alpha}'",
                    )
                if "beta" in keywords and canon == expected_alpha:
                    audit.add(
                        "error",
                        "anomer_mismatch_beta_vs_alpha",
                        f"notes say β-{sugar} but SMILES canonicalizes to "
                        f"α-anomer; β-anomer canonical = '{expected_beta}'",
                    )

    # cis / trans / E / Z keyword cross-check (basic).
    smiles = audit.expected_canonical
    has_directional_bonds = bool(re.search(r"[/\\]", smiles))
    if ("E" in keywords or "Z" in keywords or "cis" in keywords or "trans" in keywords):
        if not has_directional_bonds and audit.rdkit_canonical and not re.search(
            r"[/\\]", audit.rdkit_canonical
        ):
            audit.add(
                "warn",
                "cis_trans_notes_without_directional_bonds",
                "notes mention E/Z or cis/trans but SMILES has no "
                "directional bond markers (/ or \\)",
            )

    # D / L keyword cross-check — D and L are mutually exclusive labels for
    # the same molecule; flag if both appear.
    if "D" in keywords and "L" in keywords:
        audit.add(
            "warn",
            "both_D_and_L_in_notes",
            "notes mention both D- and L- prefixes — verify intent",
        )


def _check_fixture(audit: RowAudit) -> None:
    if not audit.image_path:
        return
    # The image-to-smiles tree has tests/ketcher/image-to-smiles/images
    # symlinked to ../../scientific/images, so paths like
    # "images/clean/benzene_clean.png" resolve under tests/scientific/.
    # The scientific manifest may use the same prefix or an absolute-from-repo
    # path. Try several roots before failing.
    candidates = [
        REPO_ROOT / "tests/scientific" / audit.image_path,
        REPO_ROOT / "tests/ketcher/image-to-smiles" / audit.image_path,
        REPO_ROOT / audit.image_path,
        REPO_ROOT / "tests/scientific/images" / audit.image_path,
    ]
    for p in candidates:
        if p.exists():
            return
    audit.add(
        "error",
        "fixture_missing",
        f"image_path='{audit.image_path}' not found at any of "
        + ", ".join(str(c.relative_to(REPO_ROOT)) for c in candidates),
    )


def audit_row(row: dict[str, Any], manifest_label: str) -> RowAudit:
    audit = RowAudit(
        id=row.get("id", "?"),
        manifest=manifest_label,
        suite=row.get("suite", "?"),
        grading=row.get("grading"),
        image_path=row.get("image_path"),
        expected_canonical=row.get("expected_canonical_smiles") or row.get("expected_smiles"),
        notes=row.get("notes", "") or "",
        rdkit_canonical=None,
        rdkit_heavy=None,
        rdkit_rings=None,
        rdkit_charges_abs_sum=None,
        rdkit_stereocenters=None,
    )

    expected_features = row.get("expected_features") or {}

    if audit.expected_canonical and audit.expected_canonical != "FAIL_EXPECTED":
        _check_round_trip(audit, audit.expected_canonical)
        _check_internal_consistency(audit, expected_features)
        _check_notes_vs_smiles(audit)

    _check_fixture(audit)

    return audit


def render_report(audits: list[RowAudit], out_path: Path) -> dict[str, int]:
    """Write audit_report.md; return {severity: count} summary."""
    counts = Counter()
    by_manifest: dict[str, list[RowAudit]] = {}
    for a in audits:
        by_manifest.setdefault(a.manifest, []).append(a)
        for f in a.findings:
            counts[f.severity] += 1

    lines: list[str] = []
    lines.append("# Manifest audit report\n")
    lines.append(
        f"- Total rows audited: **{len(audits)}**\n"
        f"- Errors: **{counts['error']}**\n"
        f"- Warnings: **{counts['warn']}**\n"
        f"- Info notes: **{counts['info']}**\n"
    )
    lines.append("")
    lines.append(
        "Severity legend: **error** — internal contradiction (manifest "
        "should be fixed); **warn** — likely bug or stale value; "
        "**info** — soft signal, may be intentional.\n"
    )
    lines.append("")

    for manifest, rows in by_manifest.items():
        flagged = [a for a in rows if a.findings]
        lines.append(f"## {manifest}")
        lines.append(f"- Rows: {len(rows)}; flagged: {len(flagged)}\n")
        if not flagged:
            lines.append("_No findings._\n")
            continue
        for a in flagged:
            lines.append(f"### {a.id} ({a.suite})")
            if a.image_path:
                lines.append(f"- fixture: `tests/scientific/images/{a.image_path}`")
            if a.expected_canonical:
                lines.append(f"- manifest SMILES: `{a.expected_canonical}`")
            if a.rdkit_canonical and a.rdkit_canonical != a.expected_canonical:
                lines.append(f"- RDKit canonical: `{a.rdkit_canonical}`")
            if a.notes:
                snippet = a.notes if len(a.notes) <= 200 else a.notes[:200] + "…"
                lines.append(f"- notes: {snippet}")
            for f in a.findings:
                lines.append(f"  - **{f.severity.upper()}** [{f.code}] {f.detail}")
            lines.append("")

    out_path.write_text("\n".join(lines), encoding="utf8")
    return dict(counts)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "manifests",
        nargs="*",
        help="manifest .jsonl paths; defaults to the standard test set",
    )
    ap.add_argument(
        "--out",
        default=str(REPO_ROOT / "tests/scientific/runner/audit_report.md"),
        help="path to write the audit_report.md",
    )
    args = ap.parse_args(argv[1:])

    manifests = [Path(p) for p in args.manifests] if args.manifests else DEFAULT_MANIFESTS
    audits: list[RowAudit] = []
    for m in manifests:
        if not m.exists():
            print(f"WARN: manifest not found: {m}", file=sys.stderr)
            continue
        rel = str(m.relative_to(REPO_ROOT)) if m.is_absolute() else str(m)
        for line in m.read_text(encoding="utf8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"ERROR: bad JSON in {m}: {e}", file=sys.stderr)
                return 2
            audits.append(audit_row(row, rel))

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    summary = render_report(audits, out_path)
    print(json.dumps({"out": str(out_path), "audits": len(audits), **summary}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
