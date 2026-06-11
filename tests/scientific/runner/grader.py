#!/usr/bin/env python3
"""Grader for one test row — the deterministic floor.

Inputs (via flags):
  --row         JSON-encoded manifest row.
  --trace       Path to <id>.trace.json (output of trace_capture.ts).
  --transcript  Path to <id>.transcript.json.
  --out         Path to write <id>.grade.json.

Gates:
  - chemistry_gate — chemistry-mode-dependent (see docs/03_grading.md).
  - execution_gate — row.required_trace_events ⊆ trace labels
    (hard for non-image rows and refusal rows; advisory for expected-success
    image rows).
  - integrity_gate — image-rebuild rows must not emit load_smiles /
    load_canonical (skipped for non-image-rebuild rows).
  - export_provenance_gate — expected-success image rows must prove that the
    candidate SMILES exactly matches a Ketcher export_smiles result.
  - stereo_gate    — advisory per-stereocenter diagnostics.
  - vision_fingerprint_gate — ADVISORY only. Compares the agent's
    `source=` readback against the canvas-computed `VisionCheckCandidate`
    fingerprint that `translator.ts` wrote to the
    `KETCHER_FINGERPRINT_DUMP_DIR` sidecar at build time. The candidate
    side is no longer authored by the agent (Stage 2 of
    PLAN-a004-class-robustness-2026-05-22 — closes the rubber-stamp
    channel structurally). Failures land in `evaluator_notes`, not in
    `deterministic_pass`.
  - beyond_protocol_gate — refusal class for stereocenters the agent
    marked `stereo_label: 'beyond_protocol'` (axial chirality, allene,
    chair-without-coords, hypervalent, indigo-indeterminate). Row-level
    outcome reports the refused atom ids and reasons.

Output schema (post 2026-05-20):
  - deterministic_pass  expected-success image rows: chemistry_gate.pass AND
                        export_provenance_gate.pass AND integrity_gate.pass.
                        Other rows keep the existing deterministic/refusal
                        contract.
  - verdict_owner       "grader" for non-image rows, "evaluator" for
                        image-rebuild rows.
  - certified           expected-success image rows only; true when the hard
                        image-row contract passes.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

try:
    from rdkit import Chem
    from rdkit.Chem import Descriptors, FindMolChiralCenters
except ImportError:
    print(json.dumps({"pass": False, "reason": "rdkit_not_installed"}), file=sys.stderr)
    raise

REFUSAL_PATTERNS = [
    r"recognition failed",
    r"not a chemical structure",
    r"cannot recognize",
    r"no valid molecule",
    r"do not invent",
    r"unable to identify",
]

STRUCTURED_FINAL_TEXT_MARKERS = (
    "===VISION_CHECK_BEGIN===",
    "===STEREO_WORKSHEET_AUDIT_BEGIN===",
    "===COVERAGE_CHECK_BEGIN===",
)


# _load_dense_evidence_sidecar + _get_dense_evidence deleted 2026-05-26 —
# dense-evidence.json sidecar surface is gone. Refusal-grammar gate +
# chemistry_gate are now the sole authority on candidate emission.


def canon(smiles: str, isomeric: bool = True) -> str | None:
    if not smiles or smiles == "FAIL_EXPECTED":
        return None
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    return Chem.MolToSmiles(mol, isomericSmiles=isomeric, canonical=True)


def num_radicals(smiles: str) -> int | None:
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    return Descriptors.NumRadicalElectrons(mol)


def extract_final_smiles(
    transcript_path: str,
    trace: dict[str, Any] | None = None,
) -> str | None:
    """Pull the SMILES line out of the subagent's final assistant message."""
    del trace
    try:
        text = Path(transcript_path).read_text(encoding="utf8")
    except OSError:
        return None
    # Format (b): plain JSON object with candidate_smiles or subagent_summary.
    stripped = text.lstrip()
    if stripped.startswith("{"):
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            obj = None
        if isinstance(obj, dict):
            # Prefer explicit candidate_smiles field if present.
            cs = obj.get("candidate_smiles")
            if isinstance(cs, str) and cs:
                return cs.strip()
            # Respect an EXPLICIT `candidate_smiles: null`. On a refusal /
            # negative-control row the agent-orch candidate.json sets this
            # field to null to mean "I invented no SMILES". Falling through
            # to scrape the prose summary mis-extracts the last SMILES-y
            # token (e.g. the word "refuse"), which then false-fails the
            # refusal aliasing in execution_gate AND would falsely classify a
            # genuine refusal as smiles-authored. An explicit null is an
            # authoritative no-SMILES signal; honor it.
            if "candidate_smiles" in obj and cs is None:
                return None
            # Fall back to extracting from subagent_summary text.
            summary = obj.get("subagent_summary")
            if isinstance(summary, str) and summary:
                final = summary
                m = re.search(r"^\s*\**\s*SMILES\s*:?\**\s*[`*]?\s*([^\s`*]+)\s*[`*]?\s*$",
                              final, re.MULTILINE | re.IGNORECASE)
                if m:
                    return m.group(1).strip("`*.,;")
                candidates = re.findall(r"[A-Za-z0-9@+\-\[\]\(\)/\\=#\.%]+", final)
                candidates = [c for c in candidates if len(c) >= 2 and re.search(r"[A-Za-z]", c)]
                return candidates[-1].strip("`*.,;") if candidates else None
    # Format (a): JSONL with message/content blocks.
    lines = text.splitlines()
    final_message = ""
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict) or obj.get("type") != "assistant":
            continue
        content = (obj.get("message") or {}).get("content") or []
        message_blocks: list[str] = []
        for block in content:
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                message_blocks.append(block["text"])
        if message_blocks:
            final_message = "\n\n".join(message_blocks)
    if not final_message:
        return None
    final = final_message
    # Agents sometimes wrap the SMILES in markdown — `SMILES: \`...\``
    # or `**SMILES:** ...`. Strip backticks, asterisks, and trailing
    # punctuation conservatively before returning. The character class
    # excludes ` ` (space), backtick, asterisk, and trailing dots/commas.
    m = re.search(r"^\s*\**\s*SMILES\s*:?\**\s*[`*]?\s*([^\s`*]+)\s*[`*]?\s*$",
                  final, re.MULTILINE | re.IGNORECASE)
    if m:
        return m.group(1).strip("`*.,;")
    # Fallback — pull last token that looks SMILES-y.
    candidates = re.findall(r"[A-Za-z0-9@+\-\[\]\(\)/\\=#\.%]+", final)
    candidates = [c for c in candidates if len(c) >= 2 and re.search(r"[A-Za-z]", c)]
    return candidates[-1].strip("`*.,;") if candidates else None


def extract_final_text(transcript_path: str) -> str:
    """Extract the runner subagent's final assistant text from one of two
    on-disk formats:

      (a) JSONL — one object per line, each carrying
          ``{message: {content: [{type: "text", text: "..."}, ...]}}``.
          Returns the concatenated text of the LAST assistant message, not just
          the last text block. Used by trace_capture.ts.

      (b) Plain JSON object — written by the agent-orch orchestrator as
          ``candidate.json`` with at minimum ``subagent_summary`` (the
          full returned text from the runner). Returns that field.

    Both shapes appear in practice — the evaluator hands the grader the
    same path it received as ``--transcript``, which is currently
    ``candidate.json``. Without (b) the VISION_CHECK gate is permanently
    starved of input because the JSONL parser misses every line of a
    pretty-printed JSON object.
    """
    try:
        text = Path(transcript_path).read_text(encoding="utf8")
    except OSError:
        return ""
    stripped = text.lstrip()
    # Format (b): plain JSON object with subagent_summary.
    if stripped.startswith("{"):
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            obj = None
        if isinstance(obj, dict):
            summary = obj.get("subagent_summary")
            if isinstance(summary, str):
                return summary
            # Fall through to JSONL path if no summary present.
    # Format (a): JSONL with message/content blocks.
    last = ""
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") != "assistant":
            continue
        content = (obj.get("message") or {}).get("content") or []
        message_blocks: list[str] = []
        for block in content:
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                message_blocks.append(block["text"])
        if message_blocks:
            last = "\n\n".join(message_blocks)
    return last


def resolve_final_text_surface(trace: dict[str, Any], transcript_path: str) -> str:
    """Prefer the trace-capture final assistant text surface when present.

    This keeps grader.py aligned with evaluator-visible `trace.json` rather than
    re-deriving a competing "final text" view from candidate/transcript parsing.
    Transcript parsing remains a legacy fallback only when trace capture did not
    preserve the final assistant text.
    """
    trace_blocks = trace.get("final_assistant_text_blocks")
    if isinstance(trace_blocks, list):
        joined_blocks = "\n\n".join(
            block for block in trace_blocks if isinstance(block, str) and block.strip()
        ).strip()
        if joined_blocks:
            return joined_blocks

    trace_text = trace.get("final_assistant_text")
    transcript_text = extract_final_text(transcript_path)
    if isinstance(trace_text, str) and trace_text.strip():
        if any(marker in trace_text for marker in STRUCTURED_FINAL_TEXT_MARKERS):
            return trace_text
        if any(marker in transcript_text for marker in STRUCTURED_FINAL_TEXT_MARKERS):
            return transcript_text
        return trace_text
    return transcript_text


EXECUTION_LABEL_ALIASES: dict[str, list[str]] = {
    # Agent-orchestrated runs may synthesize trace.json directly from
    # `TRACE:` lines instead of routing through trace_capture.ts. Keep the
    # grader tolerant of that shape by applying the same key load/construct
    # aliases here.
    "load_smiles": ["setMolecule", "load_or_construct_in_ketcher", "set_recognized_structure"],
    "load_molfile": ["setMolecule", "load_or_construct_in_ketcher"],
    "add_fragment": ["addFragment", "load_or_construct_in_ketcher"],
    "build_from_graph": ["buildFromGraph", "load_or_construct_in_ketcher"],
    "render_canvas": ["renderCanvas"],
    "export_smiles": [
        "getSmiles",
        "getSmiles_isomeric",
        "export_from_ketcher",
        "getSmiles_or_product_export",
    ],
    "export_rxn": ["getRxn", "export_products"],
    "export_reaction_smiles": ["export_products"],
}


def expand_execution_labels(trace_labels: list[str]) -> list[str]:
    expanded: list[str] = []
    for label in trace_labels:
        expanded.append(label)
        expanded.extend(EXECUTION_LABEL_ALIASES.get(label, []))
    return expanded


def _has_dense_manifest_signals(row: dict[str, Any]) -> bool:
    expected_features = row.get("expected_features") or {}
    return (
        "ring_connectivity" in expected_features
        or "ring_atom_walks" in expected_features
        or _expected_feature_count(expected_features.get("wedges")) >= 5
        or int(expected_features.get("heavy") or 0) >= 35
    )


def _count_build_from_graph_ops(
    trace_labels: list[str],
    trace_events: list[dict[str, Any]] | None = None,
) -> int:
    if trace_events:
        seen: set[tuple[Any, Any]] = set()
        count = 0
        for event in trace_events:
            if event.get("label") not in {"build_from_graph", "buildFromGraph"}:
                continue
            key = (event.get("ts_index"), event.get("raw_tool"))
            if key in seen:
                continue
            seen.add(key)
            count += 1
        return count
    return sum(
        1 for label in trace_labels if label in {"build_from_graph", "buildFromGraph"}
    )


# The synthetic host event that `trace_capture.ts` (~line 310) pushes on a
# refusal row when the final assistant text matches a recognition-failure
# phrase AND no export occurred. In production / agent-orch, image-rebuild
# rows terminate via the `refuse` MCP tool, so the trace carries a `refuse`
# event but NOT necessarily this host label — the synthesize helper maps
# `refuse` → ['refuse'] only and does not replicate the heuristic. We alias
# `refuse` → this label here (guarded by no-export + no-SMILES) so a genuine,
# SMILES-free refusal satisfies a `required_trace_events` requirement for it.
RECOGNITION_FAILURE_EVENT = "handle_recognition_failure_without_invention"


def execution_gate(
    row: dict[str, Any],
    trace_labels: list[str],
    final_smiles: str | None = None,
) -> dict[str, Any]:
    required = row.get("required_trace_events", []) or []
    matched: list[str] = []
    missing: list[str] = []
    expanded_labels = expand_execution_labels(trace_labels)
    pool = list(expanded_labels)
    # Refusal aliasing: credit `handle_recognition_failure_without_invention`
    # from a terminal `refuse` event ONLY when the agent invented nothing —
    # no export event in the trace AND no candidate SMILES. This mirrors the
    # trace_capture.ts heuristic's guard (`!hadExport`) and additionally
    # refuses to credit if a SMILES was emitted, so a real failure (export
    # happened / SMILES present) is never falsely credited.
    refusal_alias_applied = False
    if (
        RECOGNITION_FAILURE_EVENT in required
        and RECOGNITION_FAILURE_EVENT not in expanded_labels
        and "refuse" in expanded_labels
    ):
        had_export = any(
            lbl in expanded_labels for lbl in EXPORT_PROVENANCE_LABELS
        )
        if not had_export and not final_smiles:
            pool.append(RECOGNITION_FAILURE_EVENT)
            refusal_alias_applied = True
    for req in required:
        # Consume each required event exactly once (the order doesn't
        # matter here, only multiplicity). Multi-step rows like
        # RT001-RT004 require the same label twice in a row; we
        # respect that by popping from the pool.
        try:
            pool.remove(req)
            matched.append(req)
        except ValueError:
            missing.append(req)
    return {
        "pass": not missing,
        "matched_events": matched,
        "missing_events": missing,
        "actual_labels": expanded_labels,
        "refusal_alias_applied": refusal_alias_applied,
    }


PARTIAL_STEREO_REFUSAL_RE = re.compile(
    r"partial_stereo_(\d+)_(?:wedges|centers)_seen_(\d+)_emitted", re.IGNORECASE,
)

VISION_POLARITY_UNRESOLVED_RE = re.compile(
    r"vision_polarity_unresolved_(\d+)", re.IGNORECASE,
)


def extract_stereo_unknown_atom_ids(trace: dict[str, Any]) -> list[int]:
    """Pull atom ids that the agent marked as stereo-unknown — across all
    three encodings:

    1. `atom.stereo_unknown: true` on the per-atom intent (legacy / one-shot).
    2. `stereoTransfer[i].stereo_unknown: true` on a wedge-primitive entry
       (predecessor Fix 1 explicit-skip).
    3. `stereoTransfer[i].stereo_label: 'unknown'` on an R/S-label entry
       (handoff-rs-direct §A explicit-skip).

    Reads from build_from_graph tool calls captured in the trace. If the
    trace lacks per-call `args.graph` (e.g. synthesized trace.json from
    summary text), additionally consult `args.graph_intent_path` and
    `event.graph` shapes that the test orchestrator may inject as fallback
    pointers to the actual GraphIntent JSON on disk.
    """
    import json as _json
    from pathlib import Path as _Path

    ids: list[int] = []
    seen: set[int] = set()

    def _collect_from_graph(graph: dict[str, Any]) -> None:
        for atom in graph.get("atoms", []) or []:
            if atom.get("stereo_unknown") is True and isinstance(atom.get("id"), int):
                if atom["id"] not in seen:
                    seen.add(atom["id"])
                    ids.append(atom["id"])
        for entry in graph.get("stereoTransfer", []) or []:
            if not isinstance(entry, dict):
                continue
            center = entry.get("center")
            if not isinstance(center, int):
                continue
            if entry.get("stereo_unknown") is True or entry.get("stereo_label") == "unknown":
                if center not in seen:
                    seen.add(center)
                    ids.append(center)

    for event in trace.get("events", []) or []:
        if event.get("label") != "build_from_graph":
            continue
        args = event.get("args") or {}
        graph = args.get("graph") or event.get("graph") or {}
        if isinstance(graph, dict):
            _collect_from_graph(graph)
        # Optional fallback: orchestrator may attach a path to the dumped
        # GraphIntent JSON (KETCHER_BUILD_DUMP_DIR convention or per-row
        # scripts dir). Load it lazily if the inline graph was empty.
        if not graph:
            for key in ("graph_intent_path", "graph_path"):
                p = args.get(key) or event.get(key)
                if isinstance(p, str) and _Path(p).exists():
                    try:
                        payload = _json.loads(_Path(p).read_text())
                        if isinstance(payload, dict):
                            _collect_from_graph(payload)
                    except Exception:
                        pass
    return ids


def _resolve_submitted_graph(
    event: dict[str, Any], trace_path: str | None
) -> dict[str, Any] | None:
    """Resolve the GraphIntent a `build_from_graph` event submitted — FAIL OPEN.

    The production agent-orch trace carries label-only build events with NO
    inline `args.graph`; the submitted GraphIntent is written to a per-row
    on-disk dump (`<rowDir>/<rowId>.graph.json`, sibling-task commit
    e7ad83e4) and the success event carries `args.graph_intent_path`.

    Resolution order:
      1. inline `event.args.graph` (the legacy / test inline shape),
      2. `event.args.graph_intent_path` (the production pointer),
      3. `Path(trace_path).parent / f"{row_id}.graph.json"` (the deterministic
         per-row dump; `row_id` is derived from the dir name, which the
         orchestrator names per row).

    The on-disk payload may be a bare flat GraphIntent OR a nested build-dump
    shape `{"graph": {...}, ...}`; both are accepted (the nested case is
    unwrapped via `payload.get('graph', payload)`).

    **§2 FUNDAMENTAL INVARIANT — fail open.** If NO graph can be resolved (no
    inline args, no path key, no on-disk dump, or unreadable JSON), this
    returns `None`. The caller must treat `None` as "cannot evaluate → no
    penalty", NEVER as a violation. A missing dump must never become a new
    false-fail (this is the I015 case — it had no dump in the failing run).
    """
    args = event.get("args") if isinstance(event, dict) else None
    if isinstance(args, dict):
        inline = args.get("graph")
        if isinstance(inline, dict) and inline:
            return inline

    candidate_paths: list[str] = []
    if isinstance(args, dict):
        for key in ("graph_intent_path", "graph_path"):
            p = args.get(key)
            if isinstance(p, str) and p:
                candidate_paths.append(p)
    if isinstance(event, dict):
        for key in ("graph_intent_path", "graph_path"):
            p = event.get(key)
            if isinstance(p, str) and p:
                candidate_paths.append(p)
    if trace_path:
        parent = Path(trace_path).parent
        row_id = parent.name
        if row_id:
            candidate_paths.append(str(parent / f"{row_id}.graph.json"))

    for p in candidate_paths:
        try:
            if not Path(p).exists():
                continue
            payload = json.loads(Path(p).read_text())
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        graph = payload.get("graph", payload)
        if isinstance(graph, dict) and graph:
            return graph
    return None


def _expected_stereocenter_count(row: dict[str, Any]) -> int:
    expected = row.get("expected_canonical_smiles") or ""
    if not expected:
        return 0
    mol = Chem.MolFromSmiles(expected)
    if mol is None:
        return 0
    try:
        return len(
            FindMolChiralCenters(
                mol, includeUnassigned=False, useLegacyImplementation=False
            )
        )
    except Exception:
        return 0


def _candidate_emitted_stereo_count(smiles: str | None) -> int:
    if not smiles:
        return 0
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return 0
    try:
        return len(
            FindMolChiralCenters(
                mol, includeUnassigned=False, useLegacyImplementation=False
            )
        )
    except Exception:
        return 0


def _credit_unspecified(
    candidate_mol: Any, site_idx: int, expected_config: str, expected_canon: str
) -> bool:
    """Assign one of the two tetrahedral chiral tags at site_idx and check
    whether the resulting canonical SMILES (with the expected R|S config
    perceived at that center) equals the expected canonical SMILES.
    Tries both CW/CCW because RDKit's local-order tag doesn't map 1:1
    onto CIP R|S — the surrounding atom order determines the mapping.

    Limitation: this filler only mutates ONE site at a time, then tests
    global canonical equality. When TWO OR MORE centers on the candidate
    are unspecified, the trial mol still has the other unspecified centers
    so the canonical never matches the fully-specified expected. Those
    candidates instead fall through to the `stereo_unknown_budget` path
    where each unspecified site is consumed by an atom the agent explicitly
    flagged `stereo_unknown:true` in `build_from_graph`. Not redesigning."""
    for tag in (Chem.ChiralType.CHI_TETRAHEDRAL_CW, Chem.ChiralType.CHI_TETRAHEDRAL_CCW):
        trial = Chem.Mol(candidate_mol)
        atom = trial.GetAtomWithIdx(site_idx)
        atom.SetChiralTag(tag)
        try:
            Chem.AssignStereochemistry(trial, cleanIt=True, force=True)
            centers = dict(
                FindMolChiralCenters(
                    trial, includeUnassigned=False, useLegacyImplementation=False
                )
            )
        except Exception:
            continue
        if centers.get(site_idx) != expected_config:
            continue
        canon = Chem.MolToSmiles(trial, isomericSmiles=True, canonical=True)
        if canon == expected_canon:
            return True
    return False


STEREO_AUTOMORPHISM_MAX_MAPPINGS = 64


def _score_per_site(per_site: list[dict[str, Any]]) -> tuple[int, int, int]:
    """Higher is better. Returns (matches, credits, -mismatches) where
    `credits` lumps credited-implied + credited-unknown and we negate
    mismatches so a tuple-compare prefers fewer wrongs."""
    matches = sum(1 for s in per_site if s["verdict"] == "match")
    credits = sum(
        1 for s in per_site if s["verdict"] in ("credited-implied", "credited-unknown")
    )
    mismatches = sum(1 for s in per_site if s["verdict"] == "mismatch")
    return (matches, credits, -mismatches)


def _classify_per_site(
    expected_centers: list[tuple[int, str]],
    candidate_by_idx: dict[int, str],
    candidate_mol: Any,
    expected_canon: str,
    expected_to_candidate: dict[int, int],
    stereo_unknown_atom_ids: list[int],
) -> list[dict[str, Any]]:
    """One mapping's per-site verdict list. Pure function — does not
    consume the stereo_unknown_atom_ids list (a private copy is used as
    a budget)."""
    stereo_unknown_budget = len(stereo_unknown_atom_ids)
    per_site: list[dict[str, Any]] = []
    for exp_idx, exp_cfg in expected_centers:
        cand_idx = expected_to_candidate.get(exp_idx)
        cand_cfg = candidate_by_idx.get(cand_idx) if cand_idx is not None else None
        site: dict[str, Any] = {
            "expected_idx": exp_idx,
            "candidate_idx": cand_idx,
            "expected": exp_cfg,
            "candidate": cand_cfg if cand_cfg in ("R", "S") else None,
        }
        if cand_cfg == exp_cfg:
            site["verdict"] = "match"
        elif cand_cfg in (None, "?", "") and cand_idx is not None:
            credited = _credit_unspecified(
                candidate_mol, cand_idx, exp_cfg, expected_canon
            )
            if credited:
                site["verdict"] = "credited-implied"
            elif stereo_unknown_budget > 0:
                site["verdict"] = "credited-unknown"
                stereo_unknown_budget -= 1
            else:
                site["verdict"] = "unspecified-on-candidate"
        elif cand_cfg is None:
            site["verdict"] = "unspecified-on-candidate"
        else:
            site["verdict"] = "mismatch"
        per_site.append(site)
    return per_site


def stereo_gate(
    row: dict[str, Any],
    final_smiles: str | None,
    stereo_unknown_atom_ids: list[int],
) -> dict[str, Any] | None:
    """Per-stereocenter gate.

    For every expected stereocenter derived from the manifest's
    `expected_canonical_smiles`, classify the candidate's mapped center as
    `match` / `mismatch` / `credited-implied` / `credited-unknown` /
    `unspecified-on-candidate`. Passes when no `mismatch` or bare
    `unspecified-on-candidate` verdict remains.

    Returns None for rows whose expected SMILES has no stereocenters, so
    the gate is skipped silently for achiral substrates.

    Automorphism: symmetric molecules (sugars, polyols, steroid scaffolds)
    can substructure-match expected→candidate in multiple ways. A single
    `GetSubstructMatch` returns one arbitrary mapping; a wrong-but-valid
    mapping produces false `mismatch` / `unspecified-on-candidate` per-site
    verdicts. We enumerate up to `STEREO_AUTOMORPHISM_MAX_MAPPINGS`
    mappings via `GetSubstructMatches(..., uniquify=False)` and pick the
    one that scores best (most matches, most credits, fewest mismatches).
    """
    expected = row.get("expected_canonical_smiles") or ""
    if not expected or not final_smiles:
        return None
    expected_mol = Chem.MolFromSmiles(expected)
    candidate_mol = Chem.MolFromSmiles(final_smiles)
    if expected_mol is None or candidate_mol is None:
        return None
    try:
        expected_centers = FindMolChiralCenters(
            expected_mol, includeUnassigned=False, useLegacyImplementation=False
        )
    except Exception:
        return None
    if not expected_centers:
        return None
    try:
        candidate_centers = FindMolChiralCenters(
            candidate_mol,
            includeUnassigned=True,
            useLegacyImplementation=False,
        )
    except Exception:
        candidate_centers = []
    candidate_by_idx = {idx: cfg for idx, cfg in candidate_centers}
    expected_canon = Chem.MolToSmiles(
        expected_mol, isomericSmiles=True, canonical=True
    )

    # Substructure mapping expected → candidate. Query with a stereo-stripped
    # COPY of expected_mol. A re-parsed flat SMILES (the previous approach)
    # renumbers atoms, so match[i] would be keyed on the flat mol's index
    # space while expected_centers is keyed on expected_mol's — a silent
    # misalignment that produced false `unspecified-on-candidate` verdicts.
    # Chem.Mol() copies preserving atom order; RemoveStereochemistry strips
    # stereo in place so a stereo-divergent candidate still maps, while query
    # atom i stays equal to the expected_mol atom index.
    expected_flat = Chem.Mol(expected_mol)
    Chem.RemoveStereochemistry(expected_flat)

    matches = candidate_mol.GetSubstructMatches(
        expected_flat,
        uniquify=False,
        maxMatches=STEREO_AUTOMORPHISM_MAX_MAPPINGS,
    )
    expected_n = expected_flat.GetNumAtoms()
    valid_matches = [m for m in matches if m and len(m) == expected_n]

    best_per_site: list[dict[str, Any]] | None = None
    best_score: tuple[int, int, int] = (-1, -1, -10_000)
    best_mapping: dict[int, int] = {}
    explored = 0
    for match in valid_matches:
        explored += 1
        mapping = {exp_idx: cand_idx for exp_idx, cand_idx in enumerate(match)}
        per_site = _classify_per_site(
            expected_centers,
            candidate_by_idx,
            candidate_mol,
            expected_canon,
            mapping,
            stereo_unknown_atom_ids,
        )
        score = _score_per_site(per_site)
        if score > best_score:
            best_score = score
            best_per_site = per_site
            best_mapping = mapping
            # Early exit: a mapping with zero mismatches AND zero
            # unspecified is already optimal — no later mapping can beat
            # it on this scoring tuple.
            if all(
                s["verdict"] in ("match", "credited-implied", "credited-unknown")
                for s in per_site
            ):
                break

    if best_per_site is None:
        # No substructure match at all. Synthesize a per_site list with
        # candidate_idx=None for every expected center so the report
        # still gives the evaluator something to read.
        best_per_site = _classify_per_site(
            expected_centers,
            candidate_by_idx,
            candidate_mol,
            expected_canon,
            {},
            stereo_unknown_atom_ids,
        )

    passes = all(
        s["verdict"] in ("match", "credited-implied", "credited-unknown")
        for s in best_per_site
    )
    return {
        "expected_centers": [{"idx": i, "config": c} for i, c in expected_centers],
        "candidate_centers": [
            {"idx": i, "config": c} for i, c in candidate_centers
        ],
        "per_site": best_per_site,
        "stereo_unknown_atom_ids": list(stereo_unknown_atom_ids),
        "best_mapping": best_mapping,
        "mappings_explored": explored,
        "mappings_total": len(valid_matches),
        "pass": passes,
    }


def chemistry_gate(row: dict[str, Any], final_smiles: str | None, final_text: str, trace_labels: list[str]) -> dict[str, Any]:
    grading = row["grading"]
    expected_canonicals = row.get("acceptable_canonical_smiles") or [row["expected_canonical_smiles"]]
    forbidden = row.get("forbidden_canonical_smiles") or []
    if grading == "image_refusal_evaluator":
        # Image-rebuild v3 phase 5: refusal-positive fixtures (I-RFG-*).
        # Row terminates via the `refuse` MCP tool with a classification that
        # matches the manifest's `expected_refusal_reason`. Chemistry gate
        # short-circuits to pass when a refuse event was emitted AND no
        # explicit `SMILES:` terminal line is present. We deliberately do
        # NOT consult `final_smiles` here — `extract_final_smiles`'s
        # fallback grabs the last SMILES-y token from prose ("it",
        # "transcribe") on refusal rows, which would falsely classify a
        # genuine refusal as "smiles_authored". The terminal contract is
        # the explicit `SMILES:` line; pre-build prose tokens are not
        # SMILES authorship. Classification audit lives in
        # `refusal_evidence_gate`.
        refuse_observed = "refuse" in trace_labels
        smiles_line_authored = bool(re.search(r"(?m)^\s*SMILES\s*:", final_text or ""))
        if refuse_observed and not smiles_line_authored:
            return {
                "pass": True,
                "mode": grading,
                "actual_canonical": None,
                "refusal_observed": True,
            }
        return {
            "pass": False,
            "mode": grading,
            "reason": "refusal_expected_but_not_observed",
            "refuse_event_in_trace": refuse_observed,
            "smiles_line_authored": smiles_line_authored,
        }
    if grading == "safe_failure_plus_no_invented_smiles":
        refused = any(re.search(p, final_text, re.IGNORECASE) for p in REFUSAL_PATTERNS)
        export_happened = any(lbl in trace_labels for lbl in ("export_smiles", "getSmiles"))
        if refused and not export_happened:
            return {"pass": True, "mode": grading, "actual_canonical": None}
        return {"pass": False, "mode": grading, "reason": "missing_refusal_or_invented_smiles", "final_text": final_text[:300]}

    # Partial-stereo refusal credit. The agent emits
    # {smiles: null, reason: "partial_stereo_<K>_(wedges|centers)_seen_<E>_emitted"}
    # OR "vision_polarity_unresolved_<atom_id>" when stereo is partially
    # readable. Crediting the refusal converts a stereo_missing failure into a
    # soft pass on multi-stereo substrates (A002 penicillin, A003 cholesterol,
    # A005 glucose, W003 morphine, A006 ATP).
    expected_features = row.get("expected_features") or {}
    expected_wedges = expected_features.get("wedges", 0)
    expected_centers_count = _expected_stereocenter_count(row)
    partial_match = PARTIAL_STEREO_REFUSAL_RE.search(final_text or "")
    polarity_unresolved = VISION_POLARITY_UNRESOLVED_RE.search(final_text or "")
    if not final_smiles:
        if partial_match:
            k_seen = int(partial_match.group(1))
            emitted = int(partial_match.group(2))
            wedges_credit = expected_wedges >= 2 and k_seen >= 2 and emitted < k_seen
            centers_credit = (
                expected_centers_count > 0 and expected_centers_count > emitted
            )
            if wedges_credit or centers_credit:
                return {
                    "pass": True,
                    "mode": grading,
                    "actual_canonical": None,
                    "refusal_credited": "partial_stereo",
                    "k_seen": k_seen,
                    "emitted": emitted,
                    "expected_centers_count": expected_centers_count,
                }
        if polarity_unresolved and expected_centers_count > 0:
            return {
                "pass": True,
                "mode": grading,
                "actual_canonical": None,
                "refusal_credited": "vision_polarity_unresolved",
                "atom_id": int(polarity_unresolved.group(1)),
                "expected_centers_count": expected_centers_count,
            }

    if not final_smiles:
        return {"pass": False, "mode": grading, "reason": "no_smiles_in_final_message"}
    actual = canon(final_smiles, isomeric=True)
    if actual is None:
        return {"pass": False, "mode": grading, "reason": "rdkit_parse_failure", "final_smiles": final_smiles}
    if actual in forbidden:
        return {"pass": False, "mode": grading, "reason": "matched_forbidden_canonical", "actual_canonical": actual}
    # Canonicalize the manifest's acceptable list to be safe.
    accepted = []
    for s in expected_canonicals:
        c = canon(s, isomeric=grading not in ("canonical_smiles", "canonical_smiles_plus_trace"))
        if c is not None:
            accepted.append(c)

    if grading in ("canonical_smiles", "canonical_smiles_plus_trace", "canonical_smiles_plus_hidden_input_canvas"):
        # Compare on connectivity-only canonical (isomeric=False).
        actual_flat = canon(final_smiles, isomeric=False)
        accepted_flat = [canon(s, isomeric=False) for s in expected_canonicals]
        ok = actual_flat in accepted_flat
        return {"pass": ok, "mode": grading, "actual_canonical": actual_flat, "expected_canonicals": accepted_flat}

    if grading in ("canonical_isomeric_smiles", "canonical_smiles_from_image_plus_trace",
                   "image_roundtrip_self_corrected",
                   "product_canonical_smiles_plus_rxn_export",
                   "canonical_smiles_plus_isomer_specificity"):
        ok = actual in accepted
        result = {"pass": ok, "mode": grading, "actual_canonical": actual, "expected_canonicals": accepted}
        if not ok and forbidden:
            result["forbidden_canonicals"] = forbidden
        return result

    if grading == "image_roundtrip_evaluator":
        # Two-tier check.
        #   iso_match  — exact isomeric canonical match (stereo + charge).
        #   flat_match — connectivity-only canonical match.
        # Main `pass` is the exact isomeric canonical match. Earlier
        # harnesses let flat connectivity pass and delegated drawn-form
        # details to evaluator vision; the simplified image-row contract
        # makes canonical/isomeric equality the hard correctness oracle.
        # `flat_match` remains diagnostic for failure triage.
        actual_flat = canon(final_smiles, isomeric=False)
        accepted_flat = [c for c in (canon(s, isomeric=False) for s in expected_canonicals) if c]
        iso_match = actual in accepted
        flat_match = actual_flat in accepted_flat
        return {
            "pass": iso_match,
            "mode": grading,
            "iso_match": iso_match,
            "flat_match": flat_match,
            "actual_canonical": actual_flat,
            "actual_isomeric": actual,
            "expected_canonicals": accepted_flat,
        }

    if grading == "canonical_isomeric_smiles_plus_radical_count":
        ok_smiles = actual in accepted
        expected_radicals = num_radicals(expected_canonicals[0])
        actual_radicals = num_radicals(final_smiles)
        ok_rad = expected_radicals is not None and expected_radicals == actual_radicals
        return {
            "pass": ok_smiles and ok_rad,
            "mode": grading,
            "actual_canonical": actual,
            "expected_canonicals": accepted,
            "expected_radicals": expected_radicals,
            "actual_radicals": actual_radicals,
        }

    return {"pass": False, "mode": grading, "reason": "unknown_grading_mode"}


IMAGE_REBUILD_GRADING_MODES = {
    "canonical_smiles_from_image_plus_trace",
    "image_roundtrip_evaluator",
    "image_roundtrip_self_corrected",
    "image_refusal_evaluator",
}


def is_image_rebuild_row(row: dict[str, Any]) -> bool:
    """Image-rebuild rows are identified by grading mode OR by an explicit
    `skill: ketcher-image-rebuild` field OR by the presence of a vision
    trace requirement. Used by the integrity gate to enforce that
    image-rebuild rows never shortcut through load_canonical / load_smiles.
    """
    if row.get("skill") == "ketcher-image-rebuild":
        return True
    if row.get("grading") in IMAGE_REBUILD_GRADING_MODES:
        return True
    required = row.get("required_trace_events", []) or []
    if "vision_identify_structure" in required or "vision_consistency_verified" in required:
        return True
    return False


def integrity_gate(row: dict[str, Any], trace_labels: list[str]) -> dict[str, Any] | None:
    """Image-rebuild rows must not emit load_canonical or load_smiles —
    those bypass the reconstruction-capability test. Returns None for
    non-image-rebuild rows (gate skipped); otherwise pass/fail + the
    offending labels.
    """
    if not is_image_rebuild_row(row):
        return None
    forbidden = [lbl for lbl in ("load_canonical", "load_smiles") if lbl in trace_labels]
    return {
        "pass": not forbidden,
        "forbidden_observed": forbidden,
    }


def is_expected_success_image_row(row: dict[str, Any]) -> bool:
    """True for image-rebuild rows whose expected terminal is a SMILES.

    Negative/refusal rows keep the older refusal-specific semantics; they do
    not need export provenance because a correct refusal emits no SMILES.
    """
    if not is_image_rebuild_row(row):
        return False
    if row.get("grading") == "image_refusal_evaluator":
        return False
    if row.get("expected_failure") is True:
        return False
    if row.get("expected_canonical_smiles") == "FAIL_EXPECTED":
        return False
    return True


EXPORT_PROVENANCE_LABELS = {
    "export_smiles",
    "getSmiles",
    "getSmiles_isomeric",
    "export_from_ketcher",
    "getSmiles_or_product_export",
}


def _extract_export_smiles_from_payload(payload: Any) -> str | None:
    """Return a SMILES string from known MCP/session result shapes."""
    if not isinstance(payload, dict):
        return None
    direct = payload.get("smiles")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    data = payload.get("data")
    if isinstance(data, dict):
        nested = data.get("smiles")
        if isinstance(nested, str) and nested.strip():
            return nested.strip()
    result = payload.get("result")
    if isinstance(result, dict):
        return _extract_export_smiles_from_payload(result)
    return None


def _load_row_session_trace(trace_path: str | None) -> list[dict[str, Any]]:
    if not trace_path:
        return []
    path = Path(trace_path).parent / "_session_trace.json"
    try:
        payload = json.loads(path.read_text(encoding="utf8"))
    except Exception:
        return []
    return payload if isinstance(payload, list) else []


def _export_evidence(
    trace: dict[str, Any],
    trace_path: str | None,
) -> list[dict[str, Any]]:
    evidence: list[dict[str, Any]] = []
    for idx, event in enumerate(trace.get("events", []) or []):
        if not isinstance(event, dict):
            continue
        label = event.get("label")
        raw_tool = event.get("raw_tool")
        if label not in EXPORT_PROVENANCE_LABELS and raw_tool != "export_smiles":
            continue
        smiles = _extract_export_smiles_from_payload(event.get("result"))
        evidence.append(
            {
                "source": "trace",
                "index": idx,
                "label": label,
                "raw_tool": raw_tool,
                "smiles": smiles,
            }
        )

    for idx, event in enumerate(_load_row_session_trace(trace_path)):
        if not isinstance(event, dict) or event.get("tool") != "export_smiles":
            continue
        smiles = _extract_export_smiles_from_payload(event.get("result"))
        evidence.append(
            {
                "source": "session_trace",
                "index": idx,
                "label": "export_smiles",
                "raw_tool": "export_smiles",
                "smiles": smiles,
            }
        )
    return evidence


def export_provenance_gate(
    row: dict[str, Any],
    trace: dict[str, Any],
    final_smiles: str | None,
    trace_path: str | None = None,
) -> dict[str, Any] | None:
    """Expected-success image rows must answer with an exact Ketcher export.

    A label-only `TRACE: export_smiles` is useful chronology but is not
    provenance. The gate requires the exact candidate SMILES to appear in a
    parsed MCP tool result or the row-scoped `_session_trace.json` event that
    `export_smiles` now writes.
    """
    if not is_expected_success_image_row(row):
        return None

    evidence = _export_evidence(trace, trace_path)
    observed = [
        {
            "source": e.get("source"),
            "index": e.get("index"),
            "label": e.get("label"),
            "has_smiles": isinstance(e.get("smiles"), str),
        }
        for e in evidence
    ]
    if not final_smiles:
        return {
            "pass": False,
            "reason": "no_candidate_smiles",
            "observed_exports": observed,
        }
    if not evidence:
        return {
            "pass": False,
            "reason": "missing_export_smiles_event",
            "observed_exports": [],
        }

    exported = [
        e for e in evidence if isinstance(e.get("smiles"), str) and e.get("smiles")
    ]
    if not exported:
        return {
            "pass": False,
            "reason": "export_smiles_missing_result",
            "observed_exports": observed,
        }

    final = final_smiles.strip()
    for e in exported:
        if e["smiles"] == final:
            return {
                "pass": True,
                "matched_source": e["source"],
                "matched_index": e["index"],
                "matched_smiles": final,
                "observed_export_count": len(evidence),
            }

    return {
        "pass": False,
        "reason": "exported_smiles_mismatch",
        "candidate_smiles": final,
        "exported_smiles": [e["smiles"] for e in exported[:5]],
        "observed_export_count": len(evidence),
    }


VISION_CHECK_FEATURES = (
    "heavy",
    "rings",
    "drawn_H_atoms",
    "wedges",
    "cis_trans_bonds",
    "charges",
)

# Per-feature mapping from the manifest's `expected_features` key to the
# scalar that must equal the agent's `source=` value. `rings` and
# `drawn_H_atoms` are special-cased below.
VISION_FEATURE_TO_MANIFEST_KEY = {
    "heavy": "heavy",
    "drawn_H_atoms": "drawn_H_count",
    "wedges": "wedges",
    "cis_trans_bonds": "cis_trans_bonds",
    "charges": "charges",
}


def _count_from_source(feature: str, source_str: str) -> int | None:
    """Best-effort parse of the agent's `source=` field. For scalar features
    (heavy, drawn_H_atoms count, wedges count, etc.) just extract the
    leading integer. For `rings` the source is a list — return its
    length."""
    s = source_str.strip()
    if feature == "rings":
        # Source format: "[(size,arom), (size,arom), ...]". Count entries.
        items = re.findall(r"\(", s)
        return len(items)
    m = re.match(r"-?\d+", s)
    return int(m.group(0)) if m else None


def _count_from_candidate(feature: str, candidate_str: str) -> int | None:
    s = candidate_str.strip()
    if feature == "heavy":
        m = re.match(r"-?\d+", s)
        return int(m.group(0)) if m else None
    if feature == "rings":
        return len(re.findall(r"\(", s))
    # drawn_H_atoms / wedges / cis_trans_bonds / charges: candidate is a list.
    # Empty list → 0; otherwise count comma-separated top-level entries.
    if s in ("[]", ""):
        return 0
    # Strip outer brackets and split on top-level commas (no nested commas
    # except inside (...) tuples — count tuples by '(' instead when present).
    if "(" in s:
        return len(re.findall(r"\(", s))
    inner = s.strip().lstrip("[").rstrip("]").strip()
    if not inner:
        return 0
    return len([p for p in inner.split(",") if p.strip()])


def _load_fingerprint_sidecar(
    row_id: str | None,
    fingerprint_dir: str | None = None,
) -> dict[str, Any] | None:
    """Load the canvas-computed VISION_CHECK fingerprint emitted by
    `translator.ts` via the `KETCHER_FINGERPRINT_DUMP_DIR` sidecar (Stage
    A.2 of PLAN-a004-class-robustness-2026-05-22). Per Stage 2 of the
    same plan, the grader no longer recomputes the candidate from
    `final_smiles` via RDKit; the canonical candidate side is the
    post-build canvas fingerprint that the TypeScript translator wrote
    during the build. The grader reads that sidecar and compares the
    agent's `source=` against it.

    Resolution order:
      1. `fingerprint_dir` argument (test injection).
      2. `KETCHER_FINGERPRINT_DUMP_DIR` env var (orchestrator path).

    Filename pattern (set in
    `server/src/adapter/graph-intent/translator.ts`
    `dumpVisionFingerprint`):
        <row_id>-<ts>-<rand>.fingerprint.json
    Multiple files per row possible (e.g. retried build, repeated row
    invocation); the most recent (newest mtime) wins.

    Returns the inner `fingerprint` object — a `VisionCheckCandidate`
    shape per `vision-fingerprint.ts`. Returns None when:
      - no `fingerprint_dir` argument and no env var,
      - no row_id (cannot match a sidecar deterministically),
      - directory missing, no matching file, parse failure, or the
        sidecar's `fingerprint` field is null/absent.

    None disables the source-vs-sidecar comparison in the gate; the gate
    still grades source-vs-manifest (the deterministic floor).
    """
    if fingerprint_dir is None:
        fingerprint_dir = os.environ.get("KETCHER_FINGERPRINT_DUMP_DIR")
    if not fingerprint_dir or not row_id:
        return None
    dir_path = Path(fingerprint_dir)
    if not dir_path.is_dir():
        return None
    matches = sorted(
        dir_path.glob(f"{row_id}-*.fingerprint.json"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not matches:
        return None
    try:
        payload = json.loads(matches[0].read_text(encoding="utf8"))
    except (OSError, json.JSONDecodeError):
        return None
    fp = payload.get("fingerprint")
    return fp if isinstance(fp, dict) else None


def _load_renderdiff_sidecar(
    row_id: str | None,
    renderdiff_dir: str | None = None,
) -> dict[str, Any] | None:
    """Load the render-diff judge sidecar emitted by the R.4 orchestrator
    subagent (see PLAN-rdr-2026-05-22.md §"Stage R.4"). The translator
    dumps `<row_id>-source.png` + `<row_id>-render.png` into the
    renderDiff dump dir; an orchestrator-dispatched vision-judge subagent
    reads both PNGs in multimodal context and writes
    `<row_id>-renderdiff.json` matching the R.2 schema
    (`{match: true}` OR `{mismatch: true, regions: [...]}`).

    Resolution order:
      1. `renderdiff_dir` argument (test injection).
      2. `KETCHER_RENDER_DIFF_DUMP_DIR` env var (orchestrator path).

    Filename pattern (set in
    `server/src/adapter/render-diff/judge-prompt.ts`
    `judgeSidecarPath`):
        <row_id>-renderdiff.json
    Exactly one file per row by convention (no timestamp suffix); the
    orchestrator overwrites on rerun.

    Returns the parsed sidecar JSON or None when:
      - no `renderdiff_dir` argument and no env var,
      - no row_id (cannot match a sidecar deterministically),
      - directory missing, file not found, or parse failure.

    None disables the render-diff advisory. The translator's PNG dumps
    may still exist on disk even when the subagent has not yet written
    the sidecar; consumers handle that distinction explicitly.
    """
    if renderdiff_dir is None:
        renderdiff_dir = os.environ.get("KETCHER_RENDER_DIFF_DUMP_DIR")
    if not renderdiff_dir or not row_id:
        return None
    dir_path = Path(renderdiff_dir)
    if not dir_path.is_dir():
        return None
    sidecar_path = dir_path / f"{row_id}-renderdiff.json"
    if not sidecar_path.is_file():
        return None
    try:
        payload = json.loads(sidecar_path.read_text(encoding="utf8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def render_diff_gate(
    row: dict[str, Any],
    renderdiff_dir: str | None = None,
) -> dict[str, Any] | None:
    """Render-Diff advisory gate (Stage R.4 of PLAN-rdr-2026-05-22).
    Fires on image-rebuild rows when the R.4 orchestrator has dispatched
    a render-diff-judge subagent and written the sidecar. ADVISORY only —
    does NOT feed `deterministic_pass`. Co-equal with
    `vision_fingerprint_gate`; both surface as advisory notes.

    Returns None when:
      - row is not an image-rebuild row, OR
      - the sidecar is absent (RD_ENABLED was off, the orchestrator did
        not dispatch the judge, or the judge has not completed yet).

    Returns a shape-stable dict otherwise:
        {
          "pass": <match: bool>,
          "match": <bool>,
          "regions": [<RegionDescriptor>, ...],
          "region_count": <int>,
          "judge_unstable": False,
        }
    `judge_unstable` is reserved for R.4 G5 (3-rerun majority); the
    single-sidecar reader sets it False. The orchestrator's cross-table
    writer fills it from the per-rerun majority.
    """
    if not is_image_rebuild_row(row):
        return None
    sidecar = _load_renderdiff_sidecar(row.get("id"), renderdiff_dir)
    if sidecar is None:
        return None
    match_flag = sidecar.get("match") is True
    regions = sidecar.get("regions") or []
    if not isinstance(regions, list):
        regions = []
    return {
        "pass": match_flag,
        "match": match_flag,
        "regions": regions,
        "region_count": len(regions),
        "judge_unstable": False,
    }


def _format_arene_for_compare(arene_entries: list[dict[str, Any]]) -> str:
    """Canonical text form: '[r0:1,2,4; r1:1,3]'."""
    if not arene_entries:
        return "[]"
    parts = []
    for e in arene_entries:
        ring = e["ring"]
        positions = ",".join(str(p) for p in e.get("positions", []))
        parts.append(f"{ring}:{positions}")
    return "[" + "; ".join(parts) + "]"


def _format_ring_hetero_for_compare(hetero_entries: list[dict[str, Any]]) -> str:
    """Canonical text form: '[r0:N@2,N@4; r1:O@1]'."""
    if not hetero_entries:
        return "[]"
    parts = []
    for e in hetero_entries:
        ring = e["ring"]
        items = ",".join(f"{x['element']}@{x['position']}" for x in e.get("entries", []))
        parts.append(f"{ring}:{items}")
    return "[" + "; ".join(parts) + "]"


def _format_ring_atom_walk_for_compare(walks: list[dict[str, Any]]) -> str:
    """Step D fill-in-blank form: '[r0:C,C,O,C; r1:C,C,C,C,C,C]'."""
    if not walks:
        return "[]"
    parts = []
    for w in walks:
        ring = w["ring"]
        elements = ",".join(a["element"] for a in w.get("atoms", []))
        parts.append(f"{ring}:{elements}")
    return "[" + "; ".join(parts) + "]"


def _format_ring_connectivity_for_compare(entries: list[dict[str, Any]]) -> str:
    """Canonical text form: '[r0-r1:fused; r1-r2:spiro]'.

    Ring connectivity is backend readback metadata for dense visual rows. Keep
    the comparison text-shaped so grader diagnostics remain stable, but do not
    treat this as an instruction for agents to author SSSR/ring-basis labels.
    """
    if not entries:
        return "[]"
    parts: list[str] = []
    for e in entries:
        a = e.get("ring_a")
        b = e.get("ring_b")
        kind = e.get("kind")
        if a is None or b is None or kind is None:
            continue
        pair = sorted([str(a), str(b)])
        parts.append(f"{pair[0]}-{pair[1]}:{kind}")
    return "[" + "; ".join(sorted(parts)) + "]"


def _normalize_for_compare(s: str) -> str:
    """Whitespace + trailing-comma normalization. Symmetric ring numbering
    differences (r0 vs ring0) are handled by aliasing both forms upstream."""
    s = re.sub(r"\s+", "", s).rstrip(",")
    # Alias the legacy ring naming convention used in pre-Step-A blocks
    # (`ring0`, `ring1`, ...) to the new canonical form (`r0`, `r1`, ...).
    s = re.sub(r"\bring(\d+)\b", r"r\1", s)
    return s


def _vision_check_body(final_text: str) -> tuple[str, str] | None:
    """Return (body, verdict) for a VISION_CHECK block."""
    fenced_match = re.search(
        r"===VISION_CHECK_BEGIN===\s*\n"
        r"(?P<body>(?:.+\n)+?)"
        r"(?:VERDICT:\s*(?P<verdict>.+)\n)?"
        r"===VISION_CHECK_END===",
        final_text,
    )
    if fenced_match:
        return (
            fenced_match.group("body") or "",
            (fenced_match.group("verdict") or "").strip(),
        )
    block_match = re.search(
        r"VISION_CHECK:\s*\n(?P<body>(?:.+\n)+?)(?:VERDICT:\s*(?P<verdict>.+)\n?|\Z)",
        final_text,
    )
    if not block_match:
        return None
    return block_match.group("body") or "", (block_match.group("verdict") or "").strip()


def _coverage_check_body(final_text: str) -> str | None:
    fenced_match = re.search(
        r"===COVERAGE_CHECK_BEGIN===\s*\n(?P<body>.+?)\n===COVERAGE_CHECK_END===",
        final_text,
        re.S,
    )
    if fenced_match:
        return (fenced_match.group("body") or "").strip()
    block_match = re.search(r"COVERAGE_CHECK:\s*(?P<body>[^\n]+)", final_text)
    if not block_match:
        return None
    return (block_match.group("body") or "").strip()


def _parse_semicolon_fields(body: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for part in body.split(";"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        parsed[key.strip().lower()] = value.strip()
    return parsed


def _expected_feature_count(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (list, tuple, set, dict)):
        return len(value)
    if isinstance(value, (int, float)):
        return int(value)
    return 1


def vision_fingerprint_gate(
    row: dict[str, Any],
    final_text: str,
    fingerprint_dir: str | None = None,
) -> dict[str, Any] | None:
    """Structured readback gate. Fires only on rows that carry an
    `expected_features` block — gradual rollout, missing rows skip the
    gate.

    Per Stage 2 of PLAN-a004-class-robustness-2026-05-22 the candidate
    side is loaded from the canvas-computed sidecar that `translator.ts`
    dumps at build time (`KETCHER_FINGERPRINT_DUMP_DIR`). The old
    `_grader_compute_candidate` RDKit-recompute path is deleted: the
    canvas is the single source of truth, the sidecar IS the canvas
    fingerprint, and the grader compares the agent's `source=` against
    it directly. When the sidecar is absent (env var not set, no row id,
    no file), the source-vs-sidecar comparison is skipped; the gate
    still grades source-vs-manifest.

    Required agent output:

        VISION_CHECK:
          heavy:           source=<N>            candidate=<N>
          rings:           source=[(size,arom)…] candidate=[(size,arom)…]
          drawn_H_atoms:   source=<count>        candidate=[id, id, …]
          wedges:          source=<count>        candidate=[(a,b,solid|hashed)…]
          cis_trans_bonds: source=<count>        candidate=[(a,b,cis|trans)…]
          charges:         source=<count>        candidate=[(id,charge)…]
        VERDICT: VISION_OK | VISION_MISMATCH: <feature>

    Pass criteria:
      - block present
      - each feature's source = manifest expected_features value
      - each feature's source = candidate (scalar count comparison)
      - each feature's source = sidecar (when sidecar loaded)
      - VERDICT consistent with the per-line comparisons
    """
    expected_features = row.get("expected_features")
    if not expected_features:
        return None

    # Stage 2 — canvas-computed authoritative candidate side. None when
    # the sidecar can't be loaded (env unset / row id missing / file not
    # found); the source-vs-sidecar comparison is then skipped, falling
    # back to source-vs-manifest as the only authoritative check.
    sidecar = _load_fingerprint_sidecar(row.get("id"), fingerprint_dir)
    rubber_stamp_flags: list[str] = []

    # Preferred form: fenced sentinels survive transcript compaction by
    # downstream summarizers (orchestrator + LLM compactors both tend to
    # preserve clearly-fenced regions verbatim). Back-compat: also accept
    # the unfenced block written prior to 2026-05-19.
    parsed_block = _vision_check_body(final_text)
    if parsed_block is None:
        return {
            "pass": False,
            "reason": "missing_vision_check_block",
            "expected_features": expected_features,
        }
    body, verdict_str = parsed_block

    per_feature: dict[str, dict[str, Any]] = {}
    failures: list[str] = []

    # Map each scalar feature to its canvas-side counterpart (when the
    # sidecar loaded). Only the scalar features that map cleanly to a
    # single integer; positional features (arene, ring-hetero,
    # ring_atom_walks) are handled in the positional-sub-row loop below.
    # `drawn_H_atoms` is authoritative under the sidecar regime —
    # `translator.ts` reads the agent's GraphIntent `drawn_H` intent and
    # records the materialized canvas atoms in `drawn_H_atoms`, which is
    # what the agent's `source=` count must match.
    sidecar_scalar_for_feature: dict[str, int | None] = {}
    if sidecar is not None:
        sidecar_scalar_for_feature = {
            "heavy": sidecar.get("heavy"),
            "rings": len(sidecar.get("rings") or []),
            "drawn_H_atoms": len(sidecar.get("drawn_H_atoms") or []),
            "wedges": len(sidecar.get("wedges") or []),
            "cis_trans_bonds": sidecar.get("cis_trans_count"),
            "charges": len(sidecar.get("charges") or []),
        }

    for feature in VISION_CHECK_FEATURES:
        line_match = re.search(
            rf"^\s*{re.escape(feature)}\s*:\s*source\s*=\s*(?P<src>.+?)\s+candidate\s*=\s*(?P<cand>.+?)\s*$",
            body,
            re.MULTILINE,
        )
        if not line_match:
            failures.append(f"missing_line_{feature}")
            per_feature[feature] = {"present": False}
            continue
        src_raw = line_match.group("src")
        cand_raw = line_match.group("cand")
        src_count = _count_from_source(feature, src_raw)
        cand_count = _count_from_candidate(feature, cand_raw)
        info: dict[str, Any] = {
            "present": True,
            "source_raw": src_raw,
            "candidate_raw": cand_raw,
            "source_count": src_count,
            "candidate_count": cand_count,
        }

        # source vs manifest expected_features.
        if feature == "rings":
            expected_count = len(expected_features.get("rings", []) or [])
        else:
            mfst_key = VISION_FEATURE_TO_MANIFEST_KEY[feature]
            expected_count = expected_features.get(mfst_key)
        info["expected_count"] = expected_count
        if expected_count is not None and src_count is not None and src_count != expected_count:
            failures.append(f"vision_source_misread_{feature}")
            info["source_vs_manifest"] = "mismatch"
        else:
            info["source_vs_manifest"] = "ok"

        # source vs candidate (agent-typed). Preserves the legacy
        # rubber-stamp self-consistency check; advisory under Step B.
        if src_count is not None and cand_count is not None and src_count != cand_count:
            failures.append(f"vision_candidate_mismatch_{feature}")
            info["source_vs_candidate"] = "mismatch"
        else:
            info["source_vs_candidate"] = "ok"

        # Stage 2 — source vs canvas-computed sidecar. Authoritative
        # comparison: the agent can no longer rubber-stamp matching
        # source/candidate text when the actual built canvas disagrees,
        # because the sidecar candidate is computed from the canvas state
        # the build produced, not from anything the agent typed.
        sidecar_value = sidecar_scalar_for_feature.get(feature)
        if sidecar_value is not None and src_count is not None:
            info["sidecar_candidate"] = sidecar_value
            if src_count != sidecar_value:
                failures.append(f"vision_source_misread_{feature}_vs_sidecar")
                info["source_vs_sidecar"] = "mismatch"
            else:
                info["source_vs_sidecar"] = "ok"
            # Rubber-stamp diagnostic: agent's typed candidate disagrees
            # with the canvas-computed value. When this fires AND the
            # agent's source matches their candidate (so the gate didn't
            # already fail on source-vs-candidate), the agent typed both
            # sides from the same flawed mental model.
            if cand_count is not None and cand_count != sidecar_value:
                info["candidate_vs_sidecar"] = "mismatch"
                if cand_count == src_count:
                    rubber_stamp_flags.append(f"vision_rubber_stamp_detected_{feature}")
            else:
                info["candidate_vs_sidecar"] = "ok"

        per_feature[feature] = info

    # Dense topology sub-row. This distinguishes fused / spiro / bridged
    # topologies with the same scalar ring count.
    connectivity_line = re.search(
        r"^\s*ring_connectivity\s*:\s*source\s*=\s*(?P<src>\[.*?\])\s+candidate\s*=\s*(?P<cand>\[.*?\])\s*$",
        body,
        re.MULTILINE,
    )
    if connectivity_line:
        src_raw = (connectivity_line.group("src") or "").strip()
        cand_raw = (connectivity_line.group("cand") or "").strip()
        info_conn: dict[str, Any] = {
            "present": True,
            "source_raw": src_raw,
            "candidate_raw": cand_raw,
        }
        if _normalize_for_compare(src_raw) != _normalize_for_compare(cand_raw):
            failures.append("vision_candidate_mismatch_ring_connectivity")
            info_conn["source_vs_candidate"] = "mismatch"
        else:
            info_conn["source_vs_candidate"] = "ok"
        if sidecar is not None:
            sidecar_text = _format_ring_connectivity_for_compare(
                sidecar.get("ring_connectivity") or []
            )
            info_conn["sidecar_candidate"] = sidecar_text
            if _normalize_for_compare(src_raw) != _normalize_for_compare(sidecar_text):
                failures.append("vision_source_misread_ring_connectivity_vs_sidecar")
                info_conn["source_vs_sidecar"] = "mismatch"
            else:
                info_conn["source_vs_sidecar"] = "ok"
            if _normalize_for_compare(cand_raw) != _normalize_for_compare(sidecar_text):
                info_conn["candidate_vs_sidecar"] = "mismatch"
                if _normalize_for_compare(cand_raw) == _normalize_for_compare(src_raw):
                    rubber_stamp_flags.append(
                        "vision_rubber_stamp_detected_ring_connectivity"
                    )
            else:
                info_conn["candidate_vs_sidecar"] = "ok"
        expected_connectivity = expected_features.get("ring_connectivity")
        if expected_connectivity is not None:
            expected_text = (
                expected_connectivity
                if isinstance(expected_connectivity, str)
                else _format_ring_connectivity_for_compare(expected_connectivity)
            )
            info_conn["expected_raw"] = expected_connectivity
            if _normalize_for_compare(src_raw) != _normalize_for_compare(expected_text):
                failures.append("vision_source_misread_ring_connectivity")
                info_conn["source_vs_manifest"] = "mismatch"
            else:
                info_conn["source_vs_manifest"] = "ok"
        else:
            info_conn["source_vs_manifest"] = "skipped_no_expected"
        per_feature["ring_connectivity"] = info_conn
    elif expected_features.get("ring_connectivity") is not None:
        failures.append("missing_line_ring_connectivity")
        per_feature["ring_connectivity"] = {"present": False}

    # Positional sub-rows (Class C protocol). Scalar-count features above
    # catch mis-counts but cannot detect positional errors (1,2,4 vs 1,2,3
    # substitution; H on N1 vs N3 in tautomerizable heterocycles). Two
    # additional sub-rows force the agent to commit to positions; both are
    # graded source-vs-candidate equality. Source-vs-manifest is opt-in
    # via matching keys in expected_features; absent → skipped.
    for feature in ("arene_substitution_pattern", "ring_heteroatom_positions"):
        line_match = re.search(
            rf"^\s*{re.escape(feature)}\s*:\s*source\s*=\s*(?P<src>\[.*?\])\s+candidate\s*=\s*(?P<cand>\[.*?\])\s*$",
            body,
            re.MULTILINE,
        )
        if not line_match:
            # Sub-row absent. Tolerate for non-aromatic rows by checking
            # the rings line — if every ring has aromatic=False, the agent
            # may legitimately omit. Conservative: require the explicit
            # empty form `source=[] candidate=[]` whenever the block
            # carries a rings line that has at least one aromatic.
            rings_line = re.search(
                r"^\s*rings\s*:\s*source\s*=\s*(?P<src>.+?)\s+candidate", body, re.MULTILINE,
            )
            has_aromatic = bool(rings_line and re.search(r"True\b|true\b", rings_line.group("src")))
            if has_aromatic:
                failures.append(f"missing_line_{feature}")
                per_feature[feature] = {"present": False, "required_because": "aromatic_ring_present"}
            else:
                per_feature[feature] = {"present": False, "required_because": None}
            continue
        src_raw = (line_match.group("src") or "").strip()
        cand_raw = (line_match.group("cand") or "").strip()
        info: dict[str, Any] = {
            "present": True,
            "source_raw": src_raw,
            "candidate_raw": cand_raw,
        }

        # Source vs candidate equality (legacy self-consistency).
        if _normalize_for_compare(src_raw) != _normalize_for_compare(cand_raw):
            failures.append(f"vision_candidate_mismatch_{feature}")
            info["source_vs_candidate"] = "mismatch"
        else:
            info["source_vs_candidate"] = "ok"

        # Stage 2 — source vs canvas-computed sidecar. Authoritative
        # when the sidecar loaded. For positional features the gate
        # formats the sidecar fingerprint into the same text shape the
        # agent uses, then compares after whitespace normalization.
        sidecar_text: str | None = None
        if sidecar is not None:
            if feature == "arene_substitution_pattern":
                sidecar_text = _format_arene_for_compare(
                    sidecar.get("arene_substitution_pattern") or []
                )
            elif feature == "ring_heteroatom_positions":
                sidecar_text = _format_ring_hetero_for_compare(
                    sidecar.get("ring_heteroatom_positions") or []
                )
        if sidecar_text is not None:
            info["sidecar_candidate"] = sidecar_text
            if _normalize_for_compare(src_raw) != _normalize_for_compare(sidecar_text):
                failures.append(f"vision_source_misread_{feature}_vs_sidecar")
                info["source_vs_sidecar"] = "mismatch"
            else:
                info["source_vs_sidecar"] = "ok"
            if _normalize_for_compare(cand_raw) != _normalize_for_compare(sidecar_text):
                info["candidate_vs_sidecar"] = "mismatch"
                if _normalize_for_compare(cand_raw) == _normalize_for_compare(src_raw):
                    rubber_stamp_flags.append(
                        f"vision_rubber_stamp_detected_{feature}"
                    )
            else:
                info["candidate_vs_sidecar"] = "ok"

        # Source vs manifest — opt-in. Manifest may carry the same key
        # under expected_features; if absent, skip.
        expected_value = expected_features.get(feature)
        if expected_value is not None:
            expected_norm = (
                _normalize_for_compare(json.dumps(expected_value))
                if not isinstance(expected_value, str)
                else _normalize_for_compare(expected_value)
            )
            if expected_norm != _normalize_for_compare(src_raw):
                failures.append(f"vision_source_misread_{feature}")
                info["source_vs_manifest"] = "mismatch"
                info["expected_raw"] = expected_value
            else:
                info["source_vs_manifest"] = "ok"
        else:
            info["source_vs_manifest"] = "skipped_no_expected"

        per_feature[feature] = info

    # Step D — optional per-position ring atom-walk sub-row. Fill-in-blank
    # form: `ring_atom_walks: source=[r0:C,C,O,C; r1:...] candidate=[...]`.
    # When present, the source side must enumerate the ring atoms in
    # canonical-walk position order; the grader compares element-by-element
    # to the RDKit-computed walk. The blank-per-position structure forces
    # the agent to atom-by-atom re-read the source image instead of
    # rubber-stamping a summary token.
    walk_line = re.search(
        r"^\s*ring_atom_walks\s*:\s*source\s*=\s*(?P<src>\[.*?\])\s+candidate\s*=\s*(?P<cand>\[.*?\])\s*$",
        body,
        re.MULTILINE,
    )
    if walk_line:
        src_raw = (walk_line.group("src") or "").strip()
        cand_raw = (walk_line.group("cand") or "").strip()
        info_walk: dict[str, Any] = {
            "present": True,
            "source_raw": src_raw,
            "candidate_raw": cand_raw,
        }
        if _normalize_for_compare(src_raw) != _normalize_for_compare(cand_raw):
            failures.append("vision_candidate_mismatch_ring_atom_walks")
            info_walk["source_vs_candidate"] = "mismatch"
        else:
            info_walk["source_vs_candidate"] = "ok"
        if sidecar is not None:
            sidecar_text = _format_ring_atom_walk_for_compare(
                sidecar.get("ring_atom_walks") or []
            )
            info_walk["sidecar_candidate"] = sidecar_text
            if _normalize_for_compare(src_raw) != _normalize_for_compare(sidecar_text):
                failures.append("vision_source_misread_ring_atom_walks_vs_sidecar")
                info_walk["source_vs_sidecar"] = "mismatch"
            else:
                info_walk["source_vs_sidecar"] = "ok"
            if _normalize_for_compare(cand_raw) != _normalize_for_compare(sidecar_text):
                info_walk["candidate_vs_sidecar"] = "mismatch"
                if _normalize_for_compare(cand_raw) == _normalize_for_compare(src_raw):
                    rubber_stamp_flags.append(
                        "vision_rubber_stamp_detected_ring_atom_walks"
                    )
            else:
                info_walk["candidate_vs_sidecar"] = "ok"
        expected_walks = expected_features.get("ring_atom_walks")
        if expected_walks is not None:
            expected_text = (
                expected_walks
                if isinstance(expected_walks, str)
                else _format_ring_atom_walk_for_compare(expected_walks)
            )
            info_walk["expected_raw"] = expected_walks
            if _normalize_for_compare(src_raw) != _normalize_for_compare(expected_text):
                failures.append("vision_source_misread_ring_atom_walks")
                info_walk["source_vs_manifest"] = "mismatch"
            else:
                info_walk["source_vs_manifest"] = "ok"
        else:
            info_walk["source_vs_manifest"] = "skipped_no_expected"
        per_feature["ring_atom_walks"] = info_walk
    elif expected_features.get("ring_atom_walks") is not None:
        failures.append("missing_line_ring_atom_walks")
        per_feature["ring_atom_walks"] = {"present": False}

    # Verdict consistency: VISION_OK requires zero mismatches.
    verdict_lower = verdict_str.lower()
    verdict_says_ok = verdict_lower.startswith("vision_ok")
    if verdict_says_ok and failures:
        failures.append("vision_verdict_inconsistent")

    result: dict[str, Any] = {
        "pass": not failures,
        "failures": failures,
        "verdict": verdict_str,
        "per_feature": per_feature,
        "expected_features": expected_features,
    }
    if sidecar is not None:
        result["sidecar_candidate"] = sidecar
    if rubber_stamp_flags:
        result["rubber_stamp_detected"] = rubber_stamp_flags
    return result




def _vision_failure_is_hard(row: dict[str, Any], failure: str) -> bool:
    """Hard-fail only the verdict-inconsistency case (VISION_OK declared while
    feature counts mismatch). The former dense-topology branch keyed on an
    undefined `TOPOLOGY_VISION_FAILURE_RE` (guaranteed NameError once any row
    emitted a populated VISION_CHECK whose failure was not
    `vision_verdict_inconsistent`); it was a dead feature — the grading path
    emits no VISION_CHECK today and the companion dense-row plan commits to
    NOT adding one — so it is removed rather than defined. All other vision
    feature mismatches stay ADVISORY (they surface in evaluator_notes and do
    not feed `deterministic_pass`)."""
    if failure == "vision_verdict_inconsistent":
        return True
    return False


def beyond_protocol_gate(
    row: dict[str, Any],
    trace: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Refusal class for stereocenters the agent flagged as
    `stereo_label: 'beyond_protocol'` (Stage 5a of
    PLAN-a004-class-robustness-2026-05-22 — axial chirality, allene,
    chair-without-coords, hypervalent, indigo-indeterminate).

    A row with any beyond-protocol center receives a `refuse-with-reason`
    row-level outcome: the agent has explicitly declared the molecule
    contains stereo features outside the current protocol; treating the
    SMILES as a pass/fail would silently accept a partial answer.

    Returns None when no beyond-protocol centers are present (the
    overwhelming majority of rows). When present, returns the refused
    atom ids and detector reasons so the row-level reporter can surface
    them.

    The trace is scanned in two places because Stage 5a wires the enum
    onto both surfaces of the GraphIntent: `stereoTransfer[]` entries
    for the wedge-primitive path, and per-atom `stereo_label` for dense
    R/S-label routing. At Stage 2 commit time neither path emits the enum
    yet; the gate is a no-op until Stage 5a lands.
    """
    if not trace:
        return None
    refused: list[dict[str, Any]] = []
    for event in trace.get("events") or []:
        if event.get("label") != "build_from_graph":
            continue
        args = event.get("args") or {}
        graph = args.get("graph") or {}
        for entry in graph.get("stereoTransfer") or []:
            if entry.get("stereo_label") == "beyond_protocol":
                refused.append(
                    {
                        "atom_id": entry.get("center"),
                        "reason": entry.get("beyond_protocol_reason"),
                    }
                )
        for atom in graph.get("atoms") or []:
            if atom.get("stereo_label") == "beyond_protocol":
                refused.append(
                    {
                        "atom_id": atom.get("id"),
                        "reason": atom.get("beyond_protocol_reason"),
                    }
                )
    if not refused:
        return None
    return {
        "verdict": "refuse-with-reason",
        "refused": refused,
    }


# ── LOCK enforcement gates (2026-05-26 refactor) ──────────────────────
#
# These replace the deleted dense gates (zoom_protocol_gate,
# coverage_gate, dense_readback_gate, dense_evidence_gate). Each enforces
# one LOCK from the protocol plan. All are transcript-text parsers — no
# canvas state, no Indigo invocation.

LOCK_21_REFUSAL_REASONS = frozenset(
    {
        "non_structure",
        "unreadable_topology",
        "multi_molecule_panel",
        "budget_exhausted",
        "unknown_shorthand",
        "mirror_suspect",
        "reaction_input",
        "markush_or_rgroup",
        "polymer_or_oligomer",
        "organometallic_or_coordinate",
        "source_resolution_too_low",
        "backend_unavailable",
        # `session_capped` is a recognized refusal class ONLY because it is
        # coupled to the runtime artifact requirement below: the backend
        # classifier (`refusal-classifier.ts`) emits `session_capped` solely
        # when the watchdog returned a real `session_terminated` tool error.
        # This entry is forward-compat — it is unreachable from
        # `refusal_evidence_gate` until trace `refuse` events carry a
        # `result.backend_classification` of `session_capped`, and even then
        # the gate independently verifies the `_session_trace.json`
        # `session_terminated` artifact. Adding it WITHOUT that artifact
        # requirement (see `refusal_evidence_gate`) would re-open the
        # fabricated-cap loophole this very fix closes.
        "session_capped",
    }
)

# Fabricated-session-cap detector (Phase 4). VERDICT-HONESTY ONLY: this never
# scrutinizes exported work — it fires solely on a NON-exporting row that
# CLAIMS a runtime cap in prose WITHOUT the runtime `_session_trace.json`
# `session_terminated` artifact backing it.
#
# Artifact is PRIMARY; the regex is a NARROWING filter on top. The regex
# requires a 2+-digit integer WITHIN a short window of a cap token (in either
# order), so honest budget prose ("used 4 of 6 allowed crops", "within the
# 50-atom budget") does NOT trip it. The loose `used\s*:?\s*\d+` and bare
# `budget` alternatives are deliberately DROPPED — they false-fire on that
# honest prose (the reproduced FP in test 1c).
_CAP_TOKEN = r"(?:\bcap\b|watchdog|session[ _-]?terminat)"
FABRICATED_CAP_CLAIM_RE = re.compile(
    r"\b\d{2,}\b[^\n]{0,24}?" + _CAP_TOKEN
    + r"|" + _CAP_TOKEN + r"[^\n]{0,24}?\b\d{2,}\b",
    re.IGNORECASE,
)


def _session_terminated_artifact_present(trace_path: str | None) -> bool:
    """True iff a sibling `_session_trace.json` records a real watchdog cap.

    The watchdog backend is honest: `row-state.ts` writes
    `{ ok: false, error_code: 'session_terminated' }` into the per-session
    event log (`_session_trace.json`, a bare JSON list) ONLY when the cap
    actually fired. This artifact is the PRIMARY exoneration signal for a
    cap-claiming refusal.

    Reads `Path(trace_path).parent / "_session_trace.json"`. FAIL OPEN: any
    absence / unreadable JSON / wrong shape returns False (no artifact found);
    the caller treats "no artifact + cap claim on a non-exporting row" as the
    fabrication, never the reverse.
    """
    if not trace_path:
        return False
    try:
        sidecar = Path(trace_path).parent / "_session_trace.json"
        if not sidecar.exists():
            return False
        payload = json.loads(sidecar.read_text())
    except Exception:
        return False
    if not isinstance(payload, list):
        return False
    for element in payload:
        if not isinstance(element, dict):
            continue
        result = element.get("result")
        if isinstance(result, dict) and result.get("error_code") == "session_terminated":
            return True
    return False

LOCK_17_SCAFFOLD_REGEX = re.compile(
    r"\b(taxane|steroid|quinoline|paclitaxel|vinblastine|morphine|cholesterol|"
    r"aspirin|hemibrevetoxin|alkaloid|terpene|porphyrin|pyranose|furanose|"
    r"nucleoside|amino_acid|peptide|inchikey|canonical[_ ]?smiles|formula[_ ]?match)\b",
    re.IGNORECASE,
)


def _is_image_row(row: dict[str, Any]) -> bool:
    grading = row.get("grading", "")
    return isinstance(grading, str) and (
        "image_roundtrip" in grading
        or "from_image" in grading
        or grading == "image_refusal_evaluator"
    )


def transcript_image_input_gate(
    row: dict[str, Any], trace: dict[str, Any]
) -> dict[str, Any] | None:
    """Trace must contain ≥1 image Read before first build_from_graph.

    The historical `crop_before_full_image` bucket was retired in
    image-rebuild v3 phase 3: T1 (`KETCHER_CROP_AFTER_VALIDATE`)
    structurally prevents crops before the first validate round, which
    in turn cannot occur without an initial Read. The new
    `crop_after_validate_gate` carries the defense-in-depth half.
    """
    if not _is_image_row(row):
        return None
    events = trace.get("events") or []
    if not isinstance(events, list):
        events = []
    labels = [e.get("label", "") for e in events]
    image_read_idx = -1
    first_build_idx = -1
    saw_any_image_read = False
    for i, lbl in enumerate(labels):
        if lbl in ("Read", "read") or "Read(" in lbl:
            saw_any_image_read = True
            if image_read_idx < 0:
                image_read_idx = i
        elif lbl == "build_from_graph" and first_build_idx < 0:
            first_build_idx = i
    failures: list[str] = []
    if first_build_idx >= 0 and not saw_any_image_read:
        failures.append("image_not_read_before_build")
    elif first_build_idx >= 0 and image_read_idx > first_build_idx:
        failures.append("image_not_read_before_build")
    return {"pass": not failures, "failures": failures}


def refusal_evidence_gate(
    row: dict[str, Any],
    trace: dict[str, Any],
    final_text: str,
    trace_path: str | None = None,
) -> dict[str, Any] | None:
    """Refusal terminal-tool-call audit.

    Image-rebuild v3 contract: every row ends with one of two terminal
    tool calls — `export_smiles` (success) or `refuse` (cannot
    transcribe). The agent no longer authors a text-grammar refusal
    token; the `refuse` MCP tool owns classification (see
    `server/src/adapter/refusal-classifier.ts`).

    Verification:
      - If the row terminated with a clean `export_smiles` EVENT (or a
        SMILES line), it is a success path; gate passes and the
        fabricated-cap detector below is NEVER consulted. Keying the
        success exit on the EXPORT EVENT (not just `has_smiles_line`) is
        deliberate — it guarantees no exported (successful) work is ever
        scrutinized for cap prose, which would re-create the
        `stereo_false_green` false-fail-on-correct-work mode.
      - If the row terminated without an export event, a `refuse` tool
        call event must exist in the trace.
      - When the trace carries a `result.backend_classification` (Phase 4
        trace-capture work pairs tool_use with tool_result), that
        classification is reported as the row's refusal_reason and
        must be one of the recognized refusal classes.

    Fabricated-session-cap detector (Phase 4 — VERDICT-HONESTY ONLY):
    on a NON-exporting row whose `final_text` CLAIMS a runtime cap (via
    the narrowing `FABRICATED_CAP_CLAIM_RE`) WITHOUT a real runtime
    `_session_trace.json` `session_terminated` artifact backing it, the
    gate fails with `fabricated_session_cap`. The artifact is the PRIMARY
    exoneration signal; the regex is only a narrowing filter on top. This
    is NOT a new pass/fail requirement — it never scrutinizes exported
    work and never fails on mere artifact-absence alone (a cap CLAIM is
    required).
    """
    if not _is_image_row(row):
        return None
    has_smiles_line = bool(re.search(r"(?m)^\s*SMILES\s*:", final_text))
    events = trace.get("events") or []
    if not isinstance(events, list):
        events = []
    refuse_events = [e for e in events if e.get("label") == "refuse"]
    has_export_event = any(e.get("label") == "export_smiles" for e in events)
    # Success path — keyed on the export EVENT (or a SMILES line). Exported
    # work is NEVER scrutinized for cap prose (re-creating the
    # stereo_false_green false-fail-on-correct-work mode is forbidden).
    if has_export_event or has_smiles_line:
        return {"pass": True, "failures": []}
    # NON-exporting row only: reject a fabricated session-cap refusal — a cap
    # CLAIMED in prose with NO `session_terminated` runtime artifact. Artifact
    # is primary; the regex is the narrowing filter. Never fires on
    # artifact-absence alone (a cap claim is required), so honest budget prose
    # that does NOT also name a cap/watchdog ("used 4 of 6 allowed crops" /
    # "within the 50-atom budget") is safe. Prose that names a cap token near a
    # 2+-digit number can match — bounded: this is the refusal-bucket only and
    # can never fail exported work (the export-event early-exit above), and the
    # evaluator re-checks before crediting a session_capped refusal.
    if FABRICATED_CAP_CLAIM_RE.search(final_text or "") and not _session_terminated_artifact_present(
        trace_path
    ):
        return {
            "pass": False,
            "failures": ["fabricated_session_cap"],
            "refuse_event_count": len(refuse_events),
        }
    if not refuse_events:
        return {
            "pass": False,
            "failures": ["refuse_tool_not_called"],
        }
    classification: str | None = None
    for e in refuse_events:
        result = e.get("result")
        if isinstance(result, dict):
            cls = result.get("backend_classification") or result.get(
                "classification"
            )
            if isinstance(cls, str):
                classification = cls
                break
    if classification is None:
        return {
            "pass": True,
            "failures": [],
            "refuse_event_count": len(refuse_events),
        }
    if classification not in LOCK_21_REFUSAL_REASONS:
        return {
            "pass": False,
            "failures": ["refuse_classification_unknown"],
            "classification": classification,
        }
    expected_reason = row.get("expected_refusal_reason")
    if expected_reason and classification != expected_reason:
        return {
            "pass": False,
            "failures": [f"refuse_classification_mismatch:{classification}!={expected_reason}"],
            "classification": classification,
            "expected_refusal_reason": expected_reason,
            "refuse_event_count": len(refuse_events),
        }
    return {
        "pass": True,
        "failures": [],
        "classification": classification,
        "refuse_event_count": len(refuse_events),
    }


def iteration_budget_gate(
    row: dict[str, Any], trace: dict[str, Any]
) -> dict[str, Any] | None:
    """LOCK 2: cap validate_graph ≤3, crop_source_image ≤6,
    build_from_graph ≤2."""
    if not _is_image_row(row):
        return None
    crop_cap = 6
    events = trace.get("events") or []
    if not isinstance(events, list):
        events = []
    labels = [e.get("label", "") for e in events]
    validate_count = sum(1 for lbl in labels if lbl == "validate_graph")
    crop_count = sum(1 for lbl in labels if lbl == "crop_source_image")
    build_count = sum(1 for lbl in labels if lbl == "build_from_graph")
    failures: list[str] = []
    if validate_count > 3:
        failures.append(f"validate_graph_over_cap:{validate_count}>3")
    if crop_count > crop_cap:
        failures.append(f"crop_source_image_over_cap:{crop_count}>{crop_cap}")
    if build_count > 2:
        failures.append(f"build_from_graph_over_cap:{build_count}>2")
    return {
        "pass": not failures,
        "failures": failures,
        "counts": {
            "validate_graph": validate_count,
            "crop_source_image": crop_count,
            "build_from_graph": build_count,
        },
    }


def crop_after_validate_gate(
    row: dict[str, Any], trace: dict[str, Any]
) -> dict[str, Any] | None:
    """Defense-in-depth audit of T1 (`KETCHER_CROP_AFTER_VALIDATE`).

    Every `crop_source_image` event must be preceded by at least one
    `validate_graph` event in the same trace. The MCP tool is the
    structural enforcer (production rejects preemptive crops with
    `crop_before_validate`); this gate is the trace-side audit that
    surfaces any miss the tool didn't catch (e.g. flag disabled, fixture
    drift, script-transport bypass).
    """
    if not _is_image_row(row):
        return None
    events = trace.get("events") or []
    if not isinstance(events, list):
        events = []
    saw_validate = False
    failures: list[str] = []
    for e in events:
        lbl = e.get("label")
        if lbl == "validate_graph":
            saw_validate = True
        elif lbl == "crop_source_image" and not saw_validate:
            failures.append("crop_before_validate")
            break
    return {"pass": not failures, "failures": failures}


def mirror_check_gate(
    row: dict[str, Any], trace: dict[str, Any], final_text: str
) -> dict[str, Any] | None:
    """Chirality-mirror-warning acknowledgement.

    When the canvas-side warning fires, the agent must either affirm
    `MIRROR_CHECK: ok` in prose (visible wedge sanity check) or
    terminate the row via the `refuse` tool with a `mirror_suspect`
    classification. Image-rebuild v3 retired the text-grammar
    `DIAGNOSTIC: REFUSE mirror_suspect` escape; refusal lives in the
    tool now.
    """
    if not _is_image_row(row):
        return None
    warned = "chirality_mirror_warning" in final_text
    if not warned:
        return {"pass": True, "failures": []}
    has_affirmation = bool(re.search(r"(?m)^\s*MIRROR_CHECK:\s*ok", final_text))
    if has_affirmation:
        return {"pass": True, "failures": []}
    events = trace.get("events") or []
    if not isinstance(events, list):
        events = []
    for e in events:
        if e.get("label") != "refuse":
            continue
        result = e.get("result")
        if not isinstance(result, dict):
            continue
        cls = result.get("backend_classification") or result.get("classification")
        if cls == "mirror_suspect":
            return {"pass": True, "failures": []}
    return {"pass": False, "failures": ["mirror_advisory_unacknowledged"]}


def crop_rationale_gate(
    row: dict[str, Any], trace: dict[str, Any], final_text: str
) -> dict[str, Any] | None:
    """LOCK 17: every crop_source_image must be followed by a CROP_RATIONALE
    line citing a pixel cue. No scaffold names in the rationale."""
    if not _is_image_row(row):
        return None
    events = trace.get("events") or []
    if not isinstance(events, list):
        events = []
    crop_count = sum(
        1 for e in events if e.get("label") == "crop_source_image"
    )
    rationale_lines = re.findall(
        r"(?m)^\s*CROP_RATIONALE:\s*([^\n]+)$", final_text
    )
    failures: list[str] = []
    if crop_count > len(rationale_lines):
        failures.append(
            f"crop_rationale_missing:{crop_count}_crops_{len(rationale_lines)}_rationales"
        )
    for line in rationale_lines:
        if LOCK_17_SCAFFOLD_REGEX.search(line):
            failures.append("crop_rationale_chemistry_leak")
            break
    return {
        "pass": not failures,
        "failures": failures,
        "crop_count": crop_count,
        "rationale_count": len(rationale_lines),
    }


def filename_inference_gate(
    row: dict[str, Any], trace: dict[str, Any]
) -> dict[str, Any] | None:
    """Cardinal-rule audit: agent's pre-build prose must not mirror a
    scaffold-name token visible in the source image filename.

    The image-rebuild v3 cardinal rule says filename + caption + user
    prose are untrusted user input — the agent transcribes pixels, not
    names. This gate scans every assistant message emitted before the
    first `build_from_graph` event for any chemistry-name token that
    also appears in `row.image_path`.

    Trace plumbing: prefers `trace.assistant_message_blocks` (every
    assistant message, populated by trace_capture.ts in Phase 4) and
    falls back to `trace.final_assistant_text` /
    `trace.final_assistant_text_blocks` when the richer field is
    absent.
    """
    if not _is_image_row(row):
        return None
    image_path = row.get("image_path") or row.get("image") or ""
    if not isinstance(image_path, str) or not image_path:
        return {"pass": True, "failures": []}
    filename_tokens = set(
        m.group(0).lower()
        for m in LOCK_17_SCAFFOLD_REGEX.finditer(os.path.basename(image_path))
    )
    if not filename_tokens:
        return {"pass": True, "failures": []}
    prose_blocks: list[str] = []
    messages = trace.get("assistant_message_blocks")
    if isinstance(messages, list):
        prose_blocks.extend(str(m) for m in messages if isinstance(m, str))
    blocks = trace.get("final_assistant_text_blocks")
    if isinstance(blocks, list):
        prose_blocks.extend(str(b) for b in blocks if isinstance(b, str))
    final_text = trace.get("final_assistant_text")
    if isinstance(final_text, str) and final_text:
        prose_blocks.append(final_text)
    # Locate first build_from_graph event to bound the pre-build window
    # when ordering is recoverable. The richer `assistant_message_blocks`
    # plumbing (Phase 4) lets us interleave events; until then, scan
    # everything we have and report any overlap.
    failures: list[str] = []
    leaked_token: str | None = None
    for text in prose_blocks:
        for match in LOCK_17_SCAFFOLD_REGEX.finditer(text):
            token = match.group(0).lower()
            if token in filename_tokens:
                leaked_token = token
                break
        if leaked_token:
            break
    if leaked_token:
        failures.append(f"filename_scaffold_inferred:{leaked_token}")
    return {
        "pass": not failures,
        "failures": failures,
        "filename_tokens": sorted(filename_tokens),
    }


def image_freshness_gate(
    row: dict[str, Any], trace: dict[str, Any]
) -> dict[str, Any] | None:
    """LOCK 20: if ≥4 crops OR ≥10 turns before build, a fresh full-image
    Read must appear within 2 turns before build_from_graph."""
    if not _is_image_row(row):
        return None
    events = trace.get("events") or []
    if not isinstance(events, list):
        events = []
    crop_count = sum(
        1 for e in events if e.get("label") == "crop_source_image"
    )
    first_build_idx = -1
    for i, e in enumerate(events):
        if e.get("label") == "build_from_graph":
            first_build_idx = i
            break
    if first_build_idx < 0:
        return {"pass": True, "failures": []}  # no build, gate moot
    if crop_count < 4 and first_build_idx < 10:
        return {"pass": True, "failures": []}
    # Look back ≤ 2 turns from build for a full-image Read.
    for j in range(max(0, first_build_idx - 2), first_build_idx):
        e = events[j]
        if e.get("label") in ("Read", "read"):
            payload = e.get("path") or e.get("note") or ""
            if "/crops/" not in str(payload):
                return {"pass": True, "failures": []}
    return {"pass": False, "failures": ["stale_image_context_before_build"]}


def stereo_escape_hatch_gate(
    row: dict[str, Any],
    trace: dict[str, Any],
    trace_path: str | None = None,
) -> dict[str, Any] | None:
    """Re-blocks the W5 cheat class deleted in the simplified protocol.

    SKILL.md treats `stereo_label: 'unknown'` as a RARE escape hatch only
    when LOCK 9 needs_zoom triggers on `drawnNeighborsCW` cannot be
    resolved by zoom. An agent under retry pressure could short-circuit
    wedge-primitive transcription by claiming "LOCK 9 zoom unresolved"
    on every center; nothing today checks whether zoom was actually
    attempted.

    Enforcement: for each `stereo_label: 'unknown'` entry in a
    build_from_graph submission, require at least one matching
    `unresolved[]` entry with `field: 'wedge_orientation'` in the same
    submitted graph. The LOCK 5 invariant says successful zoom REMOVES
    the unresolved entry, so a kept entry is evidence that zoom was
    attempted and failed.

    `stereo_label: 'beyond_protocol'` is exempt — that escape has its
    own enforcement via beyond_protocol_gate.

    Trace plumbing (§2 fundamental invariant — fail open). Like
    `stereo_false_green_gate`, the production trace carries label-only build
    events; the submitted graph sits in `<rowDir>/<rowId>.graph.json`. When
    the inline `args.graph` is empty this gate resolves the on-disk dump via
    `_resolve_submitted_graph(event, trace_path)`. If NO graph resolves there
    are no `unknown` centers to police → the gate passes (no penalty); a
    missing dump is never a violation.

    POLARITY NOTE: un-blinding this gate is a TIGHTENING (blind → false-PASS).
    It is kept ADVISORY-first at the `main()` wiring level (does NOT deny
    `deterministic_pass`) until a full-corpus run confirms no legitimate
    `stereo_label:'unknown'` row newly fails. The gate FUNCTION reports the
    real verdict; the wiring decides the (advisory) consequence.
    """
    if not _is_image_row(row):
        return None
    events = trace.get("events") or []
    if not isinstance(events, list):
        events = []
    failures: list[str] = []
    unknown_centers: list[int] = []
    wedge_orientation_unresolved_count = 0
    for e in events:
        if e.get("label") != "build_from_graph":
            continue
        args = e.get("args") or {}
        if not isinstance(args, dict):
            args = {}
        graph = args.get("graph") or {}
        if not isinstance(graph, dict) or not graph:
            # Production shape: label-only event. Resolve the on-disk dump
            # (`<rowDir>/<rowId>.graph.json`) — fail open if none resolves.
            resolved = _resolve_submitted_graph(e, trace_path)
            graph = resolved if isinstance(resolved, dict) else {}
        if not isinstance(graph, dict) or not graph:
            continue
        stereo_transfer = graph.get("stereoTransfer") or []
        unresolved = graph.get("unresolved") or []
        if not isinstance(stereo_transfer, list):
            continue
        if not isinstance(unresolved, list):
            unresolved = []
        for entry in stereo_transfer:
            if not isinstance(entry, dict):
                continue
            if entry.get("stereo_label") == "unknown":
                center = entry.get("center")
                if isinstance(center, int):
                    unknown_centers.append(center)
        wedge_orientation_unresolved_count = sum(
            1
            for u in unresolved
            if isinstance(u, dict) and u.get("field") == "wedge_orientation"
        )
    if not unknown_centers:
        return {"pass": True, "failures": [], "unknown_centers": []}
    if wedge_orientation_unresolved_count < len(unknown_centers):
        failures.append(
            f"stereo_label_unknown_without_zoom_trigger:"
            f"unknown={len(unknown_centers)}_zoom_evidence={wedge_orientation_unresolved_count}"
        )
    return {
        "pass": not failures,
        "failures": failures,
        "unknown_centers": unknown_centers,
        "wedge_orientation_unresolved": wedge_orientation_unresolved_count,
    }


def _smiles_has_stereo_descriptor(smiles: str | None) -> bool:
    """True iff `smiles` carries a tetrahedral (@/@@) or E/Z (/ or \\) token.

    A wedge/dash or E/Z that Indigo actually perceived lands in the exported
    SMILES as one of these tokens. A stereo build run against an UNREACHABLE
    Indigo cannot perceive CIP, so it either drops the descriptor (achiral
    export) or fails the build outright (`stereo_transfer_failed`, observed in
    the adjacent-chiral negative control). So a stereo descriptor in the final
    SMILES is the deterministic, trace-observable evidence that the Indigo-
    backed perception path actually ran for the build — condition (c).
    """
    if not smiles:
        return False
    return ("@" in smiles) or ("/" in smiles) or ("\\" in smiles)


def stereo_false_green_gate(
    row: dict[str, Any],
    trace: dict[str, Any],
    final_smiles: str | None,
    trace_path: str | None = None,
) -> dict[str, Any] | None:
    """Task 6E — deny stereo credit to an IMAGE row that did not genuinely
    READ the stereo from pixels and PERCEIVE it through Indigo.

    A stereo-bearing image row has stronger diagnostic evidence when its trace
    shows a real vision-stereo read. Under the simplified expected-success
    image contract this gate is advisory; the isomeric canonical match is the
    hard stereo oracle. The gate reports failures when a row CLAIMS stereo
    (its expected canonical has ≥1 stereocenter) but the trace shows any of:

      (a) NO image / stereo-crop `Read` before the first `build_from_graph`.
          A wedge "read" with no pixels behind it is not a vision read.
      (b) Stereo arriving as a HARDCODED `stereo_label`/`stereoTransfer` R|S
          literal in the emitted graph rather than a wedge PRIMITIVE
          (`bond.wedge` + `bond.wedge_from`, a `stereoTransfer` wedge-primitive
          entry with `drawnNeighborsCW`, or `wedge_to_implicit_h`). A seeded
          `stereo_label: 'R'|'S'` is the agent authoring CIP directly — exactly
          the "agent never authors R/S" violation. `stereo_label: 'unknown'` /
          `'beyond_protocol'` are NOT R|S claims (they are explicit skips /
          refusals, policed by `stereo_escape_hatch_gate` /
          `beyond_protocol_gate`), so they do not by themselves count as a
          seeded literal.
      (c) NO evidence Indigo was reachable for the build — i.e. the final
          exported SMILES carries NO stereo descriptor (@/@@ or /,\\). A
          stereo target built with Indigo down cannot perceive CIP, so a
          missing descriptor on a row that claims stereo is treated as a
          no-Indigo build and the stereo credit is denied.

    Composes with the 5D pins: it is INDEPENDENT of
    `stereo_escape_hatch_gate` (which polices the `unknown` escape) and the
    anti-tautomer chemistry pins (which police drawn-form swaps on the
    chemistry gate). It only fires on rows that CLAIM stereo, so achiral rows,
    pure-`unknown`/`beyond_protocol` skips, and non-image rows are all skipped
    (returns None).

    Non-image rows and rows whose expected SMILES is achiral return None
    (gate not applicable).

    Trace plumbing (§2 fundamental invariant — fail open). The production
    agent-orch trace carries label-only `build_from_graph` events with NO
    inline `args.graph`; the submitted wedge sits in the per-row on-disk dump
    (`<rowDir>/<rowId>.graph.json`). When the inline scan finds no graph this
    gate resolves the dump via `_resolve_submitted_graph(event, trace_path)`.
    If NO graph resolves anywhere (no inline args, no path key, no on-disk
    dump, unreadable JSON), the gate CANNOT evaluate the wedge-primitive axis
    and therefore does NOT append `no_wedge_primitive_stereo_read` — a missing
    dump is never a violation (the I015 case). The `no_wedge_primitive`
    failure fires ONLY when a graph WAS resolved AND it genuinely carries no
    wedge primitive while the row claims stereo.
    """
    if not _is_image_row(row):
        return None
    # Only rows that actually CLAIM stereo are policed. An achiral expected
    # SMILES cannot false-green on stereo.
    if _expected_stereocenter_count(row) < 1:
        return None

    events = trace.get("events") or []
    if not isinstance(events, list):
        events = []

    # --- (a) image / stereo-crop Read before the first build. Mirrors
    # transcript_image_input_gate's detection (Read / read / "Read(" /
    # crop_source_image all count as a pixel read of the source).
    image_read_idx = -1
    first_build_idx = -1
    for i, e in enumerate(events):
        lbl = e.get("label", "") if isinstance(e, dict) else ""
        is_read = (
            lbl in ("Read", "read", "crop_source_image")
            or "Read(" in lbl
        )
        if is_read and image_read_idx < 0:
            image_read_idx = i
        elif lbl == "build_from_graph" and first_build_idx < 0:
            first_build_idx = i
    read_before_build = (
        first_build_idx >= 0
        and image_read_idx >= 0
        and image_read_idx < first_build_idx
    )

    # --- (b) wedge-primitive vs seeded stereo_label literal in the graph(s).
    seeded_label_centers: list[int] = []
    saw_wedge_primitive = False
    # FAIL OPEN: track whether ANY graph was resolved at all. If none was, the
    # wedge-primitive axis cannot be evaluated and must not hard-fail (§2).
    any_graph_resolved = False

    def _scan_graph(graph: dict[str, Any]) -> None:
        nonlocal saw_wedge_primitive
        # Per-bond wedge primitive: bond.wedge + bond.wedge_from.
        for b in graph.get("bonds", []) or []:
            if isinstance(b, dict) and b.get("wedge") and b.get("wedge_from") is not None:
                saw_wedge_primitive = True
        # Atom-level implicit-H wedge primitive.
        for a in graph.get("atoms", []) or []:
            if isinstance(a, dict) and a.get("wedge_to_implicit_h"):
                saw_wedge_primitive = True
        # stereoTransfer entries: wedge-primitive (drawnNeighborsCW) vs
        # seeded R|S label (stereo_label in {'R','S'}).
        for entry in graph.get("stereoTransfer", []) or []:
            if not isinstance(entry, dict):
                continue
            if "drawnNeighborsCW" in entry:
                saw_wedge_primitive = True
            label = entry.get("stereo_label")
            if label in ("R", "S"):
                center = entry.get("center")
                seeded_label_centers.append(
                    center if isinstance(center, int) else -1
                )

    for e in events:
        if not isinstance(e, dict) or e.get("label") != "build_from_graph":
            continue
        args = e.get("args") or {}
        graph = args.get("graph") if isinstance(args, dict) else None
        if not isinstance(graph, dict) or not graph:
            # Production shape: label-only event. Resolve the on-disk dump
            # (`<rowDir>/<rowId>.graph.json`) — fail open if none resolves.
            graph = _resolve_submitted_graph(e, trace_path)
        if not isinstance(graph, dict) or not graph:
            continue
        any_graph_resolved = True
        _scan_graph(graph)

    # --- (c) Indigo-reachability proxy: the exported SMILES carries a
    # stereo descriptor (see _smiles_has_stereo_descriptor docstring).
    indigo_perceived_stereo = _smiles_has_stereo_descriptor(final_smiles)

    failures: list[str] = []
    if not read_before_build:
        failures.append("no_image_read_before_build")
    if seeded_label_centers:
        failures.append(
            "seeded_stereo_label_literal:centers="
            + ",".join(str(c) for c in seeded_label_centers)
        )
    if (
        any_graph_resolved
        and not saw_wedge_primitive
        and not seeded_label_centers
    ):
        # A graph WAS resolved and it claims stereo, but it carried NO wedge
        # primitive AND no seeded label — there is no genuine wedge-primitive
        # stereo read to credit. (If NO graph resolved at all, this axis is
        # "cannot evaluate → no penalty" per §2 and is intentionally skipped.)
        failures.append("no_wedge_primitive_stereo_read")
    if not indigo_perceived_stereo:
        failures.append("no_indigo_stereo_in_export")

    return {
        "pass": not failures,
        "failures": failures,
        "read_before_build": read_before_build,
        "saw_wedge_primitive": saw_wedge_primitive,
        "graph_resolved": any_graph_resolved,
        "seeded_label_centers": seeded_label_centers,
        "indigo_perceived_stereo": indigo_perceived_stereo,
        "expected_stereocenters": _expected_stereocenter_count(row),
    }


def tile_budget_gate(
    row: dict[str, Any], trace: dict[str, Any]
) -> dict[str, Any] | None:
    """LOCK 30: cumulative vision-tile budget per row ≤ 50.

    Each crop_source_image event consumes ceil(N/200)^2 vision tiles
    (Anthropic vision pricing). High-tile rows degrade attention quality
    late in the trace. The crop_source_image MCP tool enforces tool-side
    via a per-row sidecar; this gate is defense-in-depth from the trace.

    tile_count is computed from event args (square N from args.w), so it
    matches the tool's own computation deterministically.
    """
    if not _is_image_row(row):
        return None
    events = trace.get("events") or []
    if not isinstance(events, list):
        events = []
    crop_events = [e for e in events if e.get("label") == "crop_source_image"]
    total_tiles = 0
    for e in crop_events:
        args = e.get("args") or {}
        n = args.get("w") if isinstance(args, dict) else None
        if not isinstance(n, int) or n <= 0:
            # Args missing or malformed — treat as 1 tile (lower bound) so
            # the gate doesn't over-fail on incomplete trace events.
            total_tiles += 1
            continue
        # The tool may upsample to 400 for sources with min(w,h) ∈ [300,400);
        # we can't know the source dim here, so use the requested N (lower
        # bound). Tool-side sidecar uses the pessimistic estimate (upsample
        # target), so the tool is the strict enforcer; this gate catches
        # cumulative excess.
        total_tiles += (n + 199) // 200 * ((n + 199) // 200)
    if total_tiles > 50:
        return {
            "pass": False,
            "failures": [f"tile_budget_exceeded:{total_tiles}>50"],
            "total_tiles": total_tiles,
            "crop_events": len(crop_events),
        }
    return {
        "pass": True,
        "failures": [],
        "total_tiles": total_tiles,
        "crop_events": len(crop_events),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--row", required=True)
    ap.add_argument("--trace", required=True)
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    row = json.loads(args.row)
    trace = json.loads(Path(args.trace).read_text(encoding="utf8"))
    trace_labels = [e["label"] for e in trace.get("events", [])]
    final_smiles = extract_final_smiles(args.transcript, trace)
    final_text = resolve_final_text_surface(trace, args.transcript)

    chem = chemistry_gate(row, final_smiles, final_text, trace_labels)
    exec_gate = execution_gate(row, trace_labels, final_smiles)
    integ_gate = integrity_gate(row, trace_labels)
    vision_gate = vision_fingerprint_gate(row, final_text)
    renderdiff_gate_result = render_diff_gate(row)
    beyond = beyond_protocol_gate(row, trace)
    stereo_unknown_ids = extract_stereo_unknown_atom_ids(trace)
    stereo = stereo_gate(row, final_smiles, stereo_unknown_ids)
    # Image-rebuild v3 enforcement gates. Shape-choice / skill-invocation
    # gates retired (tool-level barriers handle the work);
    # refusal-grammar gate repurposed to evidence-of-refuse-tool-call
    # audit; crop-after-validate + filename-inference added.
    image_input_gate = transcript_image_input_gate(row, trace)
    refusal_gate = refusal_evidence_gate(
        row, trace, final_text, trace_path=args.trace
    )
    budget_gate = iteration_budget_gate(row, trace)  # advisory
    crop_validate_gate = crop_after_validate_gate(row, trace)
    filename_gate = filename_inference_gate(row, trace)
    mirror_gate = mirror_check_gate(row, trace, final_text)
    rationale_gate = crop_rationale_gate(row, trace, final_text)
    freshness_gate = image_freshness_gate(row, trace)
    tile_gate = tile_budget_gate(row, trace)
    stereo_escape_gate = stereo_escape_hatch_gate(row, trace, trace_path=args.trace)
    stereo_false_green = stereo_false_green_gate(
        row, trace, final_smiles, trace_path=args.trace
    )
    export_gate = export_provenance_gate(row, trace, final_smiles, trace_path=args.trace)
    image_row = is_image_rebuild_row(row)
    success_image_row = is_expected_success_image_row(row)

    # Authority model: expected-success image rows use exactly the
    # fundamental protocol contract:
    #
    #   canonical/isomeric match && exact Ketcher export provenance &&
    #   no forbidden image shortcut.
    #
    # Everything else for those rows is diagnostic. Non-image and
    # refusal/negative rows keep the older deterministic/refusal semantics.
    if success_image_row:
        deterministic_pass = bool(
            chem.get("pass")
            and export_gate is not None
            and export_gate.get("pass")
            and (integ_gate is None or integ_gate.get("pass"))
        )
    else:
        deterministic_pass = bool(chem.get("pass") and exec_gate.get("pass"))
        if integ_gate is not None:
            deterministic_pass = deterministic_pass and bool(integ_gate.get("pass"))
        if stereo is not None:
            deterministic_pass = deterministic_pass and bool(stereo.get("pass"))
    vision_hard_fail = False
    if not success_image_row and vision_gate is not None and not vision_gate.get("pass"):
        failures = vision_gate.get("failures") or []
        vision_hard_fail = any(_vision_failure_is_hard(row, f) for f in failures)
    if vision_hard_fail:
        deterministic_pass = False
    # Diagnostic gates. They feed deterministic_pass only outside the
    # expected-success image-row contract above; for expected-success image
    # rows, canonical/export/integrity are the only hard gates.
    lock_failures: list[str] = []
    for label, gate in (
        ("image_input", image_input_gate),
        ("refusal_evidence", refusal_gate),
        ("crop_after_validate", crop_validate_gate),
        ("filename_inference", filename_gate),
        ("mirror_check", mirror_gate),
        ("tile_budget", tile_gate),
        ("stereo_false_green", stereo_false_green),
    ):
        if gate is not None and not gate.get("pass"):
            if not success_image_row:
                deterministic_pass = False
            for f in gate.get("failures") or []:
                lock_failures.append(f"{label}:{f}")

    verdict_owner = "evaluator" if image_row else "grader"

    certified = bool(success_image_row and deterministic_pass)

    if deterministic_pass:
        reason = "deterministic_pass"
    elif integ_gate is not None and not integ_gate.get("pass"):
        reason = "integrity_gate_failed"
    elif not chem.get("pass"):
        reason = "chemistry_gate_failed"
    elif export_gate is not None and not export_gate.get("pass"):
        reason = "export_provenance_gate_failed"
    elif not exec_gate.get("pass"):
        reason = "execution_gate_failed"
    elif stereo is not None and not stereo.get("pass"):
        reason = "stereo_gate_failed"
    elif vision_hard_fail:
        reason = "vision_check_failed"
    elif lock_failures:
        # Report the first LOCK failure as the headline reason.
        reason = f"lock_failure:{lock_failures[0]}"
    else:
        reason = "fail"

    # Advisory notes from vision_fingerprint_gate stay out of `reason`
    # and `deterministic_pass`; the evaluator can read them via
    # `evaluator_notes` if useful.
    evaluator_notes: list[str] = []
    if vision_gate is not None and not vision_gate.get("pass"):
        failures = vision_gate.get("failures")
        if failures:
            for f in failures:
                evaluator_notes.append(f"vision_advisory:{f}")
        else:
            # `missing_vision_check_block` and similar single-reason
            # variants don't carry a failures[] list; surface the reason.
            reason_str = vision_gate.get("reason") or "vision_check_failed"
            evaluator_notes.append(f"vision_advisory:{reason_str}")
    # Rubber-stamp diagnostic — surface even when the gate technically
    # passes, so the evaluator/operator sees that the agent's typed
    # candidate disagreed with the canvas-computed sidecar (a signal
    # the agent's mental model and the actual canvas diverged).
    if vision_gate is not None:
        for flag in vision_gate.get("rubber_stamp_detected") or []:
            evaluator_notes.append(f"vision_advisory:{flag}")
    # LOCK gate notes — surface each failed gate for evaluator/operator review.
    for f in lock_failures:
        prefix = "diagnostic_advisory" if success_image_row else "lock_failure"
        evaluator_notes.append(f"{prefix}:{f}")
    # Render-Diff (Stage R.4) advisory note. Match → one-line note;
    # mismatch → region count. Does NOT feed `deterministic_pass`
    # (truthfulness over catch rate, per plan §R.4 G6).
    if renderdiff_gate_result is not None:
        if renderdiff_gate_result.get("match"):
            evaluator_notes.append("renderdiff_advisory:match")
        else:
            count = renderdiff_gate_result.get("region_count", 0)
            evaluator_notes.append(
                f"renderdiff_advisory:{count}_regions_flagged"
            )
    # Beyond-protocol refusal — surface as an evaluator note too, so a
    # row-level reporter that only reads `evaluator_notes` still sees
    # the refusal class.
    if beyond is not None:
        for entry in beyond.get("refused") or []:
            atom_id = entry.get("atom_id")
            beyond_reason = entry.get("reason") or "unspecified"
            evaluator_notes.append(
                f"beyond_protocol:atom_id={atom_id}:reason={beyond_reason}"
            )

    grade = {
        "id": row["id"],
        "deterministic_pass": deterministic_pass,
        "verdict_owner": verdict_owner,
        "certified": certified,
        "reason": reason,
        "chemistry_gate": chem,
        "execution_gate": {
            **exec_gate,
            "advisory": success_image_row,
            "hard_fail": (not success_image_row and not exec_gate.get("pass")),
        },
        "final_smiles": final_smiles,
    }
    if integ_gate is not None:
        grade["integrity_gate"] = integ_gate
    if export_gate is not None:
        grade["export_provenance_gate"] = export_gate
    if vision_gate is not None:
        # Advisory for expected-success image rows; preserved so the evaluator
        # can read details without feeding them into pass logic.
        grade["vision_fingerprint_gate"] = {
            **vision_gate,
            "advisory": not vision_hard_fail,
            "hard_fail": vision_hard_fail,
        }
    # Diagnostic/enforcement gate output. For expected-success image rows these
    # are tagged advisory; outside that contract they preserve legacy hard-fail
    # behavior.
    for key, gate in (
        ("transcript_image_input_gate", image_input_gate),
        ("refusal_evidence_gate", refusal_gate),
        ("crop_after_validate_gate", crop_validate_gate),
        ("filename_inference_gate", filename_gate),
        ("mirror_check_gate", mirror_gate),
        ("tile_budget_gate", tile_gate),
        ("stereo_false_green_gate", stereo_false_green),
    ):
        if gate is not None:
            grade[key] = {
                **gate,
                "advisory": success_image_row,
                "hard_fail": (not success_image_row and not gate.get("pass")),
            }
    # ADVISORY-first gates (§2 fundamental invariant). These do NOT feed
    # `deterministic_pass`; they surface their verdict + notes only.
    #   - stereo_escape_hatch (Phase 1): un-blinding is a polarity-risk
    #     tightening, gated on a full-corpus run we cannot do here.
    #   - crop_rationale / image_freshness (Phase 1B): both hard-failed every
    #     >=4-crop dense row on a surface the synthesized trace cannot carry
    #     (absent-evidence fail). Softened to advisory; SKILL.md keeps the
    #     "fresh full-image Read" + per-crop rationale guidance as guidance.
    for key, gate, note_prefix in (
        ("stereo_escape_hatch_gate", stereo_escape_gate, "stereo_escape_hatch_advisory"),
        ("crop_rationale_gate", rationale_gate, "crop_rationale_advisory"),
        ("image_freshness_gate", freshness_gate, "image_freshness_advisory"),
    ):
        if gate is not None:
            grade[key] = {
                **gate,
                "advisory": True,
                "hard_fail": False,
            }
            if not gate.get("pass"):
                for f in gate.get("failures") or []:
                    evaluator_notes.append(f"{note_prefix}:{f}")
    # iteration_budget_gate is now advisory (does NOT feed
    # deterministic_pass). Image-rebuild v3 watchdog (T4) handles runaway
    # session caps silently on the server side; this gate only carries
    # the trace-side count for operator telemetry.
    if budget_gate is not None:
        grade["iteration_budget_gate"] = {
            **budget_gate,
            "advisory": True,
            "hard_fail": False,
        }
        if not budget_gate.get("pass"):
            for f in budget_gate.get("failures") or []:
                evaluator_notes.append(f"iteration_budget_advisory:{f}")
    if renderdiff_gate_result is not None:
        # Stage R.4 advisory. Co-equal with `vision_fingerprint_gate`;
        # both surface for evaluator/cross-table consumption, neither
        # feeds `deterministic_pass`. Cross-table writeout (plan §R.4
        # §6) joins this field with `vision_fingerprint_gate` and the
        # chemistry gates.
        grade["render_diff_gate"] = {**renderdiff_gate_result, "advisory": True}
    if beyond is not None:
        # Refusal class; reported alongside but does not feed
        # `deterministic_pass` (a refusal is distinct from pass/fail).
        grade["beyond_protocol_gate"] = beyond
    if stereo is not None:
        grade["stereo_gate"] = {
            **stereo,
            "advisory": success_image_row,
            "hard_fail": (not success_image_row and not stereo.get("pass")),
        }
    if evaluator_notes:
        grade["evaluator_notes"] = evaluator_notes
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(grade, indent=2))


if __name__ == "__main__":
    main()
