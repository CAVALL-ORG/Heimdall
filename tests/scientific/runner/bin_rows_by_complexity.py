#!/usr/bin/env python3
"""
Phase 4 of the vision-suite speedup plan. Bin image-rebuild
manifest rows into "simple" and "complex" so the orchestrator can
dispatch simple bin at K=6 per subagent (more rows packed into one
batched-template invocation) and complex bin at K=3 (smaller batches
keep context within the per-subagent budget).

Heuristic:
  simple  iff  heavy_atoms <= 10 AND wedges == 0 AND charge == 0
  complex otherwise (multi-wedge, large molecule, charged, …)

Heavy / wedge / charge come from `row["expected_features"]` when the
manifest carries it. Otherwise we infer from the expected canonical
SMILES via RDKit (the manifest is the source of truth for the answer,
so this is not "the agent typing a SMILES" — it's offline binning
infra).

Usage:
  python3 bin_rows_by_complexity.py <manifest.jsonl>
  → prints {"simple": [...], "complex": [...]} as JSON on stdout
  → exit 0 on success, 1 on parse error
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def _infer_from_smiles(smiles: str) -> tuple[int | None, int | None, int | None]:
    """Return (heavy, wedges, charges) inferred from a canonical SMILES.

    `wedges` counts isomeric `@`/`@@` tetrahedral markers (proxy for
    drawn-wedge stereocenters); double-bond E/Z is not counted as a
    wedge — Phase 4 binning treats E/Z rows as complex anyway because
    they require coord pinning, which Plan §V4 handles in the
    transcribe step. `charges` is the absolute-sum of formal charges.
    """
    try:
        from rdkit import Chem
    except ImportError:
        return None, None, None
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None, None, None
    heavy = mol.GetNumHeavyAtoms()
    wedges = sum(1 for atom in mol.GetAtoms() if atom.GetChiralTag() != Chem.ChiralType.CHI_UNSPECIFIED)
    charges = sum(abs(atom.GetFormalCharge()) for atom in mol.GetAtoms())
    return heavy, wedges, charges


def classify(row: dict[str, Any]) -> str:
    """Return 'simple' or 'complex' for a manifest row."""
    feats = row.get("expected_features") or {}
    heavy = feats.get("heavy")
    wedges = feats.get("wedges")
    charges = feats.get("charges")

    if heavy is None or wedges is None or charges is None:
        smi = row.get("expected_canonical_smiles") or row.get("expected_smiles")
        if smi and smi != "FAIL_EXPECTED":
            inf_heavy, inf_wedges, inf_charges = _infer_from_smiles(smi)
            heavy = heavy if heavy is not None else inf_heavy
            wedges = wedges if wedges is not None else inf_wedges
            charges = charges if charges is not None else inf_charges

    # Default to complex when we cannot determine — safer (smaller K)
    if heavy is None or wedges is None or charges is None:
        return "complex"

    if heavy <= 10 and wedges == 0 and charges == 0:
        return "simple"
    return "complex"


def bin_manifest(manifest_path: Path) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {"simple": [], "complex": []}
    for line in manifest_path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        out[classify(row)].append(row["id"])
    return out


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: bin_rows_by_complexity.py <manifest.jsonl>", file=sys.stderr)
        return 1
    path = Path(argv[1])
    if not path.exists():
        print(f"manifest not found: {path}", file=sys.stderr)
        return 1
    bins = bin_manifest(path)
    json.dump(bins, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
