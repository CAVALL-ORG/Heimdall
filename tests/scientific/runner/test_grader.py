"""Tests for grader gates + verdict composition.

Run via stdlib unittest (pytest not installed in this environment):

    python3 -m unittest tests/scientific/runner/test_grader.py

Tests live in three layers:
- Per-gate unit tests (stereo / chemistry / execution / integrity / vision).
- main() composition tests asserting the new deterministic_pass /
  verdict_owner / certified fields are emitted with the right values for
  image vs non-image rows.
- Regression tests for bugs we've already shipped (so a re-introduction
  fails the CI gate, not the next test run).
"""
from __future__ import annotations

import unittest

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from grader import (
    beyond_protocol_gate,
    chemistry_gate,
    crop_after_validate_gate,
    crop_rationale_gate,
    execution_gate,
    export_provenance_gate,
    expand_execution_labels,
    extract_final_smiles,
    extract_final_text,
    extract_stereo_unknown_atom_ids,
    filename_inference_gate,
    image_freshness_gate,
    integrity_gate,
    is_image_rebuild_row,
    iteration_budget_gate,
    mirror_check_gate,
    refusal_evidence_gate,
    render_diff_gate,
    resolve_final_text_surface,
    stereo_escape_hatch_gate,
    stereo_false_green_gate,
    stereo_gate,
    tile_budget_gate,
    transcript_image_input_gate,
    vision_fingerprint_gate,
)

REPO_ROOT = Path(__file__).resolve().parents[3]


L_ALANINE = "C[C@H](N)C(=O)O"
D_ALANINE = "C[C@@H](N)C(=O)O"
ALANINE_NO_STEREO = "CC(N)C(=O)O"
# NOTE: this constant is named "ALPHA_D_GLUCOSE" for back-compat with the
# refusal-credit tests below, but the SMILES below is actually the
# β-D-glucopyranose anomer (the original manifest bug it was modelled
# from). The refusal-credit tests don't care about α vs β identity, only
# stereocenter count. Tests that DO care use ALPHA_D_GLUCOSE_TRUE.
ALPHA_D_GLUCOSE = "OC[C@H]1O[C@@H](O)[C@H](O)[C@@H](O)[C@@H]1O"
ALPHA_D_GLUCOSE_TRUE = "OC[C@H]1O[C@H](O)[C@H](O)[C@@H](O)[C@@H]1O"
# Glucose with the C5 (ring-O-adjacent ring C) center erased — agent emitted
# four wedges, dropped the fifth. The credit_unspecified check should fill it
# in because the resulting canonical equals the full glucose canonical.
ALPHA_D_GLUCOSE_DROP_ONE = "OCC1O[C@@H](O)[C@H](O)[C@@H](O)[C@@H]1O"

# Image-truth / anti-tautomer-swap fixtures (Task 5D, Guard 4). A drawn
# tautomer pair: 2-pyridone (lactam — drawn N-H + ring C=O) vs
# 2-hydroxypyridine (lactim — drawn O-H + ring C=N). These two forms are
# chemically interconvertible, but they are DIFFERENT DRAWN STRUCTURES. The
# grader must grade what the image shows, so a candidate drawn as one form
# against an expected drawn as the other must NOT be credited. RDKit's
# canonical SMILES (the grader's normalizer) preserves the H-placement /
# double-bond position, so the two canonicalize differently on BOTH the
# isomeric and the connectivity-only (flat) channel — confirmed empirically
# in test_anti_tautomer_swap_rejected_by_grader below.
PYRIDONE_LACTAM = "O=c1cccc[nH]1"     # drawn N-H lactam (the expected form)
PYRIDINOL_LACTIM = "Oc1ccccn1"        # drawn O-H lactim (the forbidden swap)


def _row(expected_canonical: str, **extras):
    base = {
        "id": "TEST",
        "expected_canonical_smiles": expected_canonical,
    }
    base.update(extras)
    return base


def _trace_with_stereo_unknown(atom_ids: list[int]) -> dict:
    return {
        "events": [
            {
                "label": "build_from_graph",
                "args": {
                    "graph": {
                        "atoms": [
                            {"id": aid, "stereo_unknown": True} for aid in atom_ids
                        ],
                    }
                },
            }
        ]
    }


class StereoGateTests(unittest.TestCase):
    def test_pass_when_candidate_matches_expected(self):
        gate = stereo_gate(_row(L_ALANINE), L_ALANINE, stereo_unknown_atom_ids=[])
        self.assertIsNotNone(gate)
        self.assertTrue(gate["pass"])
        self.assertEqual(gate["per_site"][0]["verdict"], "match")

    def test_returns_none_for_achiral_row(self):
        gate = stereo_gate(_row("c1ccccc1"), "c1ccccc1", stereo_unknown_atom_ids=[])
        self.assertIsNone(gate)

    def test_pass_when_candidate_omits_one_center_implied_by_canonical(self):
        gate = stereo_gate(
            _row(ALPHA_D_GLUCOSE),
            ALPHA_D_GLUCOSE_DROP_ONE,
            stereo_unknown_atom_ids=[],
        )
        self.assertIsNotNone(gate)
        verdicts = [s["verdict"] for s in gate["per_site"]]
        # Exactly one site should be credited-implied (the dropped C5).
        self.assertIn("credited-implied", verdicts)
        # No mismatch / unspecified should remain.
        self.assertNotIn("mismatch", verdicts)
        self.assertNotIn("unspecified-on-candidate", verdicts)
        self.assertTrue(gate["pass"])

    def test_pass_when_stereo_unknown_credits_remaining_unspecified(self):
        # L-Isoleucine has 2 stereocenters. Candidate has neither specified.
        # credit_unspecified for one center alone cannot recreate the full
        # canonical because the OTHER center is still unspecified — so both
        # centers must fall through to credited-unknown via the budget.
        expected = "CC[C@H](C)[C@@H](N)C(=O)O"
        candidate_flat = "CCC(C)C(N)C(=O)O"
        gate = stereo_gate(
            _row(expected),
            candidate_flat,
            stereo_unknown_atom_ids=[10, 11],
        )
        self.assertIsNotNone(gate)
        self.assertTrue(gate["pass"])
        verdicts = [s["verdict"] for s in gate["per_site"]]
        self.assertIn("credited-unknown", verdicts)

    def test_fail_when_candidate_has_opposite_config(self):
        gate = stereo_gate(_row(L_ALANINE), D_ALANINE, stereo_unknown_atom_ids=[])
        self.assertIsNotNone(gate)
        self.assertFalse(gate["pass"])
        self.assertEqual(gate["per_site"][0]["verdict"], "mismatch")


class ExtractStereoUnknownTests(unittest.TestCase):
    def test_pulls_flagged_atoms_from_build_from_graph_event(self):
        trace = _trace_with_stereo_unknown([3, 7, 9])
        self.assertEqual(extract_stereo_unknown_atom_ids(trace), [3, 7, 9])

    def test_returns_empty_when_no_flagged_atoms(self):
        trace = {
            "events": [
                {
                    "label": "build_from_graph",
                    "args": {
                        "graph": {
                            "atoms": [{"id": 1}, {"id": 2}],
                        }
                    },
                }
            ]
        }
        self.assertEqual(extract_stereo_unknown_atom_ids(trace), [])


class PartialStereoRefusalTests(unittest.TestCase):
    def test_credits_refusal_when_expected_centers_exceed_emitted(self):
        # α-D-glucose has 5 chiral centers; agent claims to have seen 4 wedges.
        # k_seen=4 == emitted=4 (the old wedges-only rule did not credit), but
        # expected_centers_count (5) > emitted (4) → new centers-based rule
        # credits the refusal.
        final_text = (
            "Cannot reliably commit all centers; partial_stereo_4_wedges_seen_4_emitted"
        )
        row = _row(
            ALPHA_D_GLUCOSE,
            grading="image_roundtrip_evaluator",
            expected_features={"wedges": 4},
            acceptable_canonical_smiles=[ALPHA_D_GLUCOSE],
            forbidden_canonical_smiles=[],
        )
        verdict = chemistry_gate(
            row, final_smiles=None, final_text=final_text, trace_labels=[]
        )
        self.assertTrue(verdict.get("pass"))
        self.assertEqual(verdict.get("refusal_credited"), "partial_stereo")

    def test_credits_partial_stereo_centers_form(self):
        final_text = "Refusing: partial_stereo_5_centers_seen_3_emitted"
        row = _row(
            ALPHA_D_GLUCOSE,
            grading="image_roundtrip_evaluator",
            expected_features={"wedges": 5},
            acceptable_canonical_smiles=[ALPHA_D_GLUCOSE],
            forbidden_canonical_smiles=[],
        )
        verdict = chemistry_gate(
            row, final_smiles=None, final_text=final_text, trace_labels=[]
        )
        self.assertTrue(verdict.get("pass"))
        self.assertEqual(verdict.get("refusal_credited"), "partial_stereo")

    def test_credits_vision_polarity_unresolved(self):
        final_text = "I see crowded wedges; vision_polarity_unresolved_17"
        row = _row(
            ALPHA_D_GLUCOSE,
            grading="image_roundtrip_evaluator",
            acceptable_canonical_smiles=[ALPHA_D_GLUCOSE],
            forbidden_canonical_smiles=[],
        )
        verdict = chemistry_gate(
            row, final_smiles=None, final_text=final_text, trace_labels=[]
        )
        self.assertTrue(verdict.get("pass"))
        self.assertEqual(
            verdict.get("refusal_credited"), "vision_polarity_unresolved"
        )


class ExtractFinalTextTests(unittest.TestCase):
    def test_reads_subagent_summary_from_candidate_json(self):
        # candidate.json shape — plain JSON object.
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf8"
        ) as fh:
            json.dump(
                {
                    "id": "I001",
                    "candidate_smiles": "c1ccccc1",
                    "subagent_summary": "===VISION_CHECK_BEGIN===\nfoo\n===VISION_CHECK_END===",
                },
                fh,
            )
            path = fh.name
        try:
            text = extract_final_text(path)
            self.assertIn("===VISION_CHECK_BEGIN===", text)
            self.assertIn("foo", text)
        finally:
            Path(path).unlink()

    def test_jsonl_joins_last_assistant_message_blocks(self):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".jsonl", delete=False, encoding="utf8"
        ) as fh:
            fh.write(
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {
                            "content": [
                                {"type": "text", "text": "older block"},
                            ]
                        },
                    }
                )
                + "\n"
            )
            fh.write(
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {
                            "content": [
                                {
                                    "type": "text",
                                    "text": "===VISION_CHECK_BEGIN===\nfoo\n===VISION_CHECK_END===",
                                },
                                {
                                    "type": "text",
                                    "text": "===STEREO_WORKSHEET_AUDIT_BEGIN===\nbar\n===STEREO_WORKSHEET_AUDIT_END===",
                                },
                            ]
                        },
                    }
                )
                + "\n"
            )
            path = fh.name
        try:
            text = extract_final_text(path)
            self.assertIn("===VISION_CHECK_BEGIN===", text)
            self.assertIn("===STEREO_WORKSHEET_AUDIT_BEGIN===", text)
            self.assertNotIn("older block", text)
        finally:
            Path(path).unlink()

    def test_prefers_trace_final_text_surface_when_present(self):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf8"
        ) as fh:
            json.dump(
                {
                    "id": "I001",
                    "candidate_smiles": "c1ccccc1",
                    "subagent_summary": "SMILES: c1ccccc1",
                },
                fh,
            )
            path = fh.name
        try:
            text = resolve_final_text_surface(
                {"final_assistant_text": "===VISION_CHECK_BEGIN===\njoined\n===VISION_CHECK_END==="},
                path,
            )
            self.assertIn("===VISION_CHECK_BEGIN===", text)
            self.assertIn("joined", text)
        finally:
            Path(path).unlink()

    def test_falls_back_to_candidate_surface_when_trace_text_is_summary_only(self):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf8"
        ) as fh:
            json.dump(
                {
                    "id": "I001",
                    "candidate_smiles": "c1ccccc1",
                    "subagent_summary": (
                        "Summary line only in trace.\n\n"
                        "===VISION_CHECK_BEGIN===\n"
                        "ring_connectivity: source=[r0-r1 fused] candidate=[r0-r1 fused]\n"
                        "===VISION_CHECK_END===\n"
                    ),
                },
                fh,
            )
            path = fh.name
        try:
            text = resolve_final_text_surface(
                {"final_assistant_text": "short summary only"},
                path,
            )
            self.assertIn("===VISION_CHECK_BEGIN===", text)
            self.assertIn("ring_connectivity", text)
        finally:
            Path(path).unlink()

    def test_prefers_trace_text_blocks_when_present(self):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf8"
        ) as fh:
            json.dump(
                {
                    "id": "I001",
                    "candidate_smiles": "c1ccccc1",
                    "subagent_summary": "fallback summary",
                },
                fh,
            )
            path = fh.name
        try:
            text = resolve_final_text_surface(
                {
                    "final_assistant_text": "short summary only",
                    "final_assistant_text_blocks": [
                        "===VISION_CHECK_BEGIN===\nfoo\n===VISION_CHECK_END===",
                        "===STEREO_WORKSHEET_AUDIT_BEGIN===\nbar\n===STEREO_WORKSHEET_AUDIT_END===",
                    ],
                },
                path,
            )
            self.assertIn("===VISION_CHECK_BEGIN===", text)
            self.assertIn("===STEREO_WORKSHEET_AUDIT_BEGIN===", text)
        finally:
            Path(path).unlink()

    def test_ignores_dense_evidence_rendered_final_text_sidecar(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            candidate_path = Path(tmpdir) / "candidate.json"
            dense_evidence_path = Path(tmpdir) / "dense-evidence.json"
            candidate_path.write_text(
                json.dumps(
                    {
                        "id": "I001",
                        "candidate_smiles": "c1ccccc1",
                        "subagent_summary": "fallback summary",
                    }
                ),
                encoding="utf8",
            )
            dense_evidence_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "sourceReadback": {
                            "renderedFinalText": "===VISION_CHECK_BEGIN===\nfrom-sidecar\n===VISION_CHECK_END==="
                        },
                    }
                ),
                encoding="utf8",
            )
            text = resolve_final_text_surface(
                {"final_assistant_text": "short summary only"},
                str(candidate_path),
            )
            self.assertNotIn("from-sidecar", text)
            self.assertEqual(text, "short summary only")

    def test_ignores_trace_embedded_dense_evidence_rendered_final_text(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            candidate_path = Path(tmpdir) / "candidate.json"
            candidate_path.write_text(
                json.dumps(
                    {
                        "id": "I001",
                        "candidate_smiles": "c1ccccc1",
                        "subagent_summary": "fallback summary",
                    }
                ),
                encoding="utf8",
            )
            text = resolve_final_text_surface(
                {
                    "final_assistant_text": "short summary only",
                    "dense_evidence": {
                        "path": str(Path(tmpdir) / "dense-evidence.json"),
                        "payload": {
                            "version": 1,
                            "sourceReadback": {
                                "renderedFinalText": "===VISION_CHECK_BEGIN===\nfrom-trace\n===VISION_CHECK_END==="
                            },
                        },
                    },
                },
                str(candidate_path),
            )
            self.assertNotIn("from-trace", text)
            self.assertEqual(text, "short summary only")

class VisionFingerprintGateTests(unittest.TestCase):
    BENZENE_FEATURES = {
        "heavy": 6,
        "rings": [{"size": 6, "aromatic": True}],
        "drawn_H_count": 0,
        "wedges": 0,
        "cis_trans_bonds": 0,
        "charges": 0,
    }

    def _benzene_block(self, fenced: bool, substitution: str = "[]", heteroatoms: str = "[]") -> str:
        body = (
            "VISION_CHECK:\n"
            "  heavy:           source=6              candidate=6\n"
            "  rings:           source=[(6,True)]     candidate=[(6,True)]\n"
            "  drawn_H_atoms:   source=0              candidate=[]\n"
            "  wedges:          source=0              candidate=[]\n"
            "  cis_trans_bonds: source=0              candidate=[]\n"
            "  charges:         source=0              candidate=[]\n"
            f"  arene_substitution_pattern: source={substitution} candidate={substitution}\n"
            f"  ring_heteroatom_positions:  source={heteroatoms} candidate={heteroatoms}\n"
            "VERDICT: VISION_OK"
        )
        if fenced:
            return f"===VISION_CHECK_BEGIN===\n{body}\n===VISION_CHECK_END==="
        return body

    def test_passes_with_fenced_block(self):
        row = {"id": "I001", "expected_features": self.BENZENE_FEATURES}
        gate = vision_fingerprint_gate(row, self._benzene_block(fenced=True))
        self.assertTrue(gate["pass"], gate)

    def test_passes_with_unfenced_block_back_compat(self):
        row = {"id": "I001", "expected_features": self.BENZENE_FEATURES}
        gate = vision_fingerprint_gate(row, self._benzene_block(fenced=False))
        self.assertTrue(gate["pass"], gate)

    def test_fails_when_block_absent_with_expected_features(self):
        row = {"id": "I001", "expected_features": self.BENZENE_FEATURES}
        gate = vision_fingerprint_gate(row, "VISION_OK")
        self.assertFalse(gate["pass"])
        self.assertEqual(gate["reason"], "missing_vision_check_block")

    def test_substitution_sub_row_mismatch_fails(self):
        # arene_substitution_pattern source != candidate.
        text = (
            "===VISION_CHECK_BEGIN===\n"
            "VISION_CHECK:\n"
            "  heavy:           source=8              candidate=8\n"
            "  rings:           source=[(6,True)]     candidate=[(6,True)]\n"
            "  drawn_H_atoms:   source=0              candidate=[]\n"
            "  wedges:          source=0              candidate=[]\n"
            "  cis_trans_bonds: source=0              candidate=[]\n"
            "  charges:         source=0              candidate=[]\n"
            "  arene_substitution_pattern: source=[ring0:1,2,4] candidate=[ring0:1,2,3]\n"
            "  ring_heteroatom_positions:  source=[] candidate=[]\n"
            "VERDICT: VISION_OK\n"
            "===VISION_CHECK_END==="
        )
        row = {
            "id": "D036",
            "expected_features": {
                "heavy": 8,
                "rings": [{"size": 6, "aromatic": True}],
                "drawn_H_count": 0,
                "wedges": 0,
                "cis_trans_bonds": 0,
                "charges": 0,
            },
        }
        gate = vision_fingerprint_gate(row, text)
        self.assertFalse(gate["pass"])
        self.assertIn(
            "vision_candidate_mismatch_arene_substitution_pattern", gate["failures"],
        )

    def test_missing_positional_sub_row_required_for_aromatic(self):
        # Block omits the two new positional sub-rows. Rings list has an
        # aromatic ring → both sub-rows are required.
        text = (
            "===VISION_CHECK_BEGIN===\n"
            "VISION_CHECK:\n"
            "  heavy:           source=6              candidate=6\n"
            "  rings:           source=[(6,True)]     candidate=[(6,True)]\n"
            "  drawn_H_atoms:   source=0              candidate=[]\n"
            "  wedges:          source=0              candidate=[]\n"
            "  cis_trans_bonds: source=0              candidate=[]\n"
            "  charges:         source=0              candidate=[]\n"
            "VERDICT: VISION_OK\n"
            "===VISION_CHECK_END==="
        )
        row = {"id": "I001", "expected_features": self.BENZENE_FEATURES}
        gate = vision_fingerprint_gate(row, text)
        self.assertFalse(gate["pass"])
        self.assertIn("missing_line_arene_substitution_pattern", gate["failures"])
        self.assertIn("missing_line_ring_heteroatom_positions", gate["failures"])

    def test_missing_positional_sub_row_tolerated_for_non_aromatic(self):
        # Non-aromatic ring → sub-rows optional.
        text = (
            "===VISION_CHECK_BEGIN===\n"
            "VISION_CHECK:\n"
            "  heavy:           source=11             candidate=11\n"
            "  rings:           source=[(5,False),(5,False)] candidate=[(5,False),(5,False)]\n"
            "  drawn_H_atoms:   source=0              candidate=[]\n"
            "  wedges:          source=0              candidate=[]\n"
            "  cis_trans_bonds: source=0              candidate=[]\n"
            "  charges:         source=0              candidate=[]\n"
            "VERDICT: VISION_OK\n"
            "===VISION_CHECK_END==="
        )
        row = {
            "id": "D026",
            "expected_features": {
                "heavy": 11,
                "rings": [
                    {"size": 5, "aromatic": False},
                    {"size": 5, "aromatic": False},
                ],
                "drawn_H_count": 0,
                "wedges": 0,
                "cis_trans_bonds": 0,
                "charges": 0,
            },
        }
        gate = vision_fingerprint_gate(row, text)
        self.assertTrue(gate["pass"], gate)


class BeyondProtocolGateTests(unittest.TestCase):
    """Stage 2 (PLAN-a004-class-robustness-2026-05-22) — beyond_protocol
    refusal class scanned out of the build_from_graph trace event. At
    Stage 2 commit time no row emits the enum yet (Stage 5a wires the
    agent-emit side); these tests pin the grader-accept side so it is
    ready when 5a lands."""

    def test_returns_none_when_no_beyond_protocol_centers(self):
        trace = {
            "events": [
                {
                    "label": "build_from_graph",
                    "args": {
                        "graph": {
                            "stereoTransfer": [
                                {"center": 1, "stereo_label": "R"},
                                {"center": 2, "stereo_label": "S"},
                            ],
                            "atoms": [{"id": 1}, {"id": 2}],
                        }
                    },
                }
            ]
        }
        gate = beyond_protocol_gate({"id": "X"}, trace)
        self.assertIsNone(gate)

    def test_returns_none_for_empty_or_missing_trace(self):
        self.assertIsNone(beyond_protocol_gate({"id": "X"}, None))
        self.assertIsNone(beyond_protocol_gate({"id": "X"}, {"events": []}))

    def test_detects_beyond_protocol_in_stereo_transfer(self):
        trace = {
            "events": [
                {
                    "label": "build_from_graph",
                    "args": {
                        "graph": {
                            "stereoTransfer": [
                                {
                                    "center": 7,
                                    "stereo_label": "beyond_protocol",
                                    "beyond_protocol_reason": "axial_chirality",
                                }
                            ]
                        }
                    },
                }
            ]
        }
        gate = beyond_protocol_gate({"id": "X"}, trace)
        self.assertIsNotNone(gate)
        self.assertEqual(gate["verdict"], "refuse-with-reason")
        self.assertEqual(gate["refused"][0]["atom_id"], 7)
        self.assertEqual(gate["refused"][0]["reason"], "axial_chirality")

    def test_detects_beyond_protocol_in_atoms_array(self):
        # Dense R/S-label routing: the enum lives on atoms[], not on
        # stereoTransfer[].
        trace = {
            "events": [
                {
                    "label": "build_from_graph",
                    "args": {
                        "graph": {
                            "atoms": [
                                {"id": 3},
                                {
                                    "id": 11,
                                    "stereo_label": "beyond_protocol",
                                    "beyond_protocol_reason": "hypervalent",
                                },
                            ]
                        }
                    },
                }
            ]
        }
        gate = beyond_protocol_gate({"id": "X"}, trace)
        self.assertIsNotNone(gate)
        self.assertEqual(len(gate["refused"]), 1)
        self.assertEqual(gate["refused"][0]["atom_id"], 11)
        self.assertEqual(gate["refused"][0]["reason"], "hypervalent")


def _write_renderdiff_sidecar(
    tmp_dir: str, row_id: str, payload: dict
) -> None:
    """Write a `<row_id>-renderdiff.json` mimicking the R.4 orchestrator
    subagent's output so the grader can load it via
    `_load_renderdiff_sidecar` (resolved through the `renderdiff_dir`
    arg)."""
    path = Path(tmp_dir) / f"{row_id}-renderdiff.json"
    path.write_text(json.dumps(payload), encoding="utf8")


class RenderDiffGateTests(unittest.TestCase):
    """Stage R.4 coverage — the render-diff advisory gate. Mirrors the
    structure of `VisionFingerprintGateTests`: sidecar absent → None;
    sidecar present with `match: true` → advisory pass; sidecar present
    with `mismatch` + regions → advisory fail. Non-image row → None.
    Gate is ADVISORY — `pass` is informational, does NOT feed
    `deterministic_pass`. Verified separately under `MainCompositionTests`
    if needed (the gate's pass field is a passthrough of `match`).
    """

    IMAGE_ROW = {"id": "I001", "skill": "ketcher-image-rebuild"}
    NON_IMAGE_ROW = {"id": "C001"}

    def test_returns_none_when_no_renderdiff_dir(self):
        gate = render_diff_gate(self.IMAGE_ROW)
        self.assertIsNone(gate)

    def test_returns_none_for_non_image_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write_renderdiff_sidecar(tmp, "C001", {"match": True})
            old = os.environ.pop("KETCHER_RENDER_DIFF_DUMP_DIR", None)
            try:
                # Even with a populated sidecar, non-image rows skip RD.
                gate = render_diff_gate(self.NON_IMAGE_ROW, renderdiff_dir=tmp)
                self.assertIsNone(gate)
            finally:
                if old is not None:
                    os.environ["KETCHER_RENDER_DIFF_DUMP_DIR"] = old

    def test_returns_none_when_sidecar_file_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            # tmp exists but no <row_id>-renderdiff.json inside.
            gate = render_diff_gate(self.IMAGE_ROW, renderdiff_dir=tmp)
            self.assertIsNone(gate)

    def test_match_sidecar_passes_advisory(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write_renderdiff_sidecar(tmp, "I001", {"match": True})
            gate = render_diff_gate(self.IMAGE_ROW, renderdiff_dir=tmp)
            self.assertIsNotNone(gate)
            self.assertTrue(gate["pass"])
            self.assertTrue(gate["match"])
            self.assertEqual(gate["regions"], [])
            self.assertEqual(gate["region_count"], 0)

    def test_mismatch_sidecar_fails_advisory_with_regions(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = {
                "mismatch": True,
                "regions": [
                    {
                        "bbox": [10, 20, 30, 40],
                        "description": "Region at [10,20,30,40].",
                        "source_features": {
                            "atoms_by_element": {"C": 6, "N": 1},
                            "bonds_by_order": {"1": 4, "2": 3},
                            "wedges": {"solid": 0, "hashed": 0},
                            "charges": {},
                        },
                        "render_features": {
                            "atoms_by_element": {"C": 6},
                            "bonds_by_order": {"1": 3, "2": 3},
                            "wedges": {"solid": 0, "hashed": 0},
                            "charges": {},
                        },
                    },
                ],
            }
            _write_renderdiff_sidecar(tmp, "I001", payload)
            gate = render_diff_gate(self.IMAGE_ROW, renderdiff_dir=tmp)
            self.assertIsNotNone(gate)
            self.assertFalse(gate["pass"])
            self.assertFalse(gate["match"])
            self.assertEqual(len(gate["regions"]), 1)
            self.assertEqual(gate["region_count"], 1)
            self.assertEqual(gate["regions"][0]["bbox"], [10, 20, 30, 40])

    def test_malformed_sidecar_returns_none(self):
        # Garbage JSON → loader returns None → gate returns None.
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "I001-renderdiff.json").write_text(
                "not valid json", encoding="utf8"
            )
            gate = render_diff_gate(self.IMAGE_ROW, renderdiff_dir=tmp)
            self.assertIsNone(gate)


class StereoGateRegressionTests(unittest.TestCase):
    """Regression coverage for the May-2026 stereo_gate atom-index bug.

    Old behaviour: stereo_gate parsed the expected SMILES via
    `Chem.MolFromSmiles(expected)`, then queried a re-parsed flat copy. The
    flat copy renumbered atoms, so `match[i]` indexed the FLAT mol's atom
    space while `expected_centers` came from the ORIGINAL mol's. Any time
    the two numberings diverged (most candidates), per-site verdicts were
    silently misaligned.

    Coverage shape (what every test in this class must do):
    1. Expected and candidate SMILES use DIFFERENT RDKit atom numberings.
    2. The two molecules are stereochemically equivalent.
    3. The new multi-mapping stereo_gate must classify all expected
       centers as `match` and return `pass=True`.
    """

    def test_l_alanine_reverse_written_candidate(self):
        # Expected: chiral C at idx 1. Candidate written reverse (acid
        # first): chiral C at idx 3. Both are L-alanine.
        expected = "C[C@H](N)C(=O)O"
        candidate = "OC(=O)[C@@H](N)C"
        gate = stereo_gate(_row(expected), candidate, stereo_unknown_atom_ids=[])
        self.assertIsNotNone(gate)
        self.assertTrue(gate["pass"], gate)
        self.assertEqual(len(gate["per_site"]), 1)
        self.assertEqual(gate["per_site"][0]["verdict"], "match")
        # The mapping must point expected idx 1 → candidate idx 3.
        self.assertEqual(gate["best_mapping"][1], 3)


class StereoGateAutomorphismTests(unittest.TestCase):
    """For symmetric molecules a single `GetSubstructMatch` returns one
    arbitrary mapping; a wrong-but-valid mapping silently produces false
    `mismatch` per-site verdicts. The W1 multi-mapping fix enumerates
    every valid mapping and accepts the best-scoring one."""

    def test_scyllo_inositol_round_trip(self):
        # All-cis cyclohexanehexol. 12 substructure automorphisms. The
        # multi-mapping branch must find a permutation that scores all
        # 6 sites as `match`.
        expected = "O[C@H]1[C@H](O)[C@H](O)[C@H](O)[C@H](O)[C@H]1O"
        gate = stereo_gate(_row(expected), expected, stereo_unknown_atom_ids=[])
        self.assertIsNotNone(gate)
        # mappings_total should reflect the 12 automorphisms.
        self.assertGreaterEqual(gate["mappings_total"], 2)
        self.assertTrue(gate["pass"], gate)
        verdicts = [s["verdict"] for s in gate["per_site"]]
        self.assertTrue(all(v == "match" for v in verdicts), verdicts)

    def test_alpha_glucose_correct_candidate_with_different_write_order(self):
        # α-D-glucopyranose written two ways: canonical Haworth-from-CH2OH
        # vs ring-opened-from-anomeric. Same molecule, same stereochemistry,
        # different RDKit atom numbering. This is the exact production
        # condition the runner hit on the 174149Z run.
        expected = ALPHA_D_GLUCOSE_TRUE
        candidate = "[C@H]1(O)O[C@@H]([C@@H](O)[C@H](O)[C@H]1O)CO"
        from rdkit import Chem
        self.assertEqual(
            Chem.MolToSmiles(Chem.MolFromSmiles(expected)),
            Chem.MolToSmiles(Chem.MolFromSmiles(candidate)),
        )
        gate = stereo_gate(_row(expected), candidate, stereo_unknown_atom_ids=[])
        self.assertIsNotNone(gate)
        self.assertTrue(gate["pass"], gate)


class ChemistryGateModeTests(unittest.TestCase):
    """Table-driven coverage of every grading mode the gate dispatches on.
    Each case asserts (pass, mode) for a happy-path input and a wrong
    input."""

    def _row_with(self, grading: str, **extras):
        base = {
            "id": "T",
            "grading": grading,
            "expected_canonical_smiles": "c1ccccc1",
            "acceptable_canonical_smiles": ["c1ccccc1"],
        }
        base.update(extras)
        return base

    def test_canonical_smiles_pass_and_fail(self):
        row = self._row_with("canonical_smiles")
        ok = chemistry_gate(row, "c1ccccc1", "", trace_labels=[])
        self.assertTrue(ok["pass"])
        bad = chemistry_gate(row, "c1ccncc1", "", trace_labels=[])
        self.assertFalse(bad["pass"])

    def test_canonical_isomeric_smiles_distinguishes_enantiomers(self):
        row = self._row_with(
            "canonical_isomeric_smiles",
            expected_canonical_smiles=L_ALANINE,
            acceptable_canonical_smiles=[L_ALANINE],
        )
        good = chemistry_gate(row, L_ALANINE, "", trace_labels=[])
        self.assertTrue(good["pass"])
        wrong = chemistry_gate(row, D_ALANINE, "", trace_labels=[])
        self.assertFalse(wrong["pass"])

    def test_image_roundtrip_evaluator_flat_vs_iso(self):
        row = self._row_with(
            "image_roundtrip_evaluator",
            expected_canonical_smiles=L_ALANINE,
            acceptable_canonical_smiles=[L_ALANINE],
        )
        # Connectivity-only candidate is diagnosed (flat_match True), but the
        # simplified image contract requires an isomeric canonical match.
        flat_only = chemistry_gate(row, ALANINE_NO_STEREO, "", trace_labels=[])
        self.assertFalse(flat_only["pass"])
        self.assertTrue(flat_only["flat_match"])
        self.assertFalse(flat_only["iso_match"])
        # Full iso match.
        full = chemistry_gate(row, L_ALANINE, "", trace_labels=[])
        self.assertTrue(full["pass"])
        self.assertTrue(full["iso_match"])

    # ---- Task 5D Guard 4: image-truth / anti-tautomer-swap ----
    #
    # MUST-PRESERVE INVARIANT (do not relax in the Task 5E grader rewrite):
    # an image-rebuild candidate that is a DIFFERENT DRAWN FORM than the
    # expected structure (tautomer / protomer / drawn-H placement / drawn
    # C=N vs C=O / multi-fragment salt) must NOT be credited on
    # canonical-equivalence alone. The grader enforces this two ways, both
    # pinned below:
    #   (1) RDKit canonicalization (the grader's normalizer) preserves the
    #       drawn difference, so a swapped tautomer fails BOTH the isomeric
    #       and the flat (connectivity-only) channel of chemistry_gate →
    #       deterministic `pass=False`. (Note: this is RDKit canonical, NOT
    #       InChI — InChI WOULD erase the lactam/lactim difference, which is
    #       exactly why the grader must never switch to an InChI compare.)
    #   (2) For features RDKit DOES erase (e.g. stereo dropped → flat_match
    #       but not iso_match), the image row is never `certified` and its
    #       verdict is owned by the evaluator subagent (vision compare),
    #       pinned in MainCompositionTests below.
    def test_anti_tautomer_swap_rejected_by_grader(self):
        # Expected: 2-pyridone (drawn N-H lactam). Candidate: 2-hydroxy-
        # pyridine (drawn O-H lactim). The swap must fail — NOT be credited
        # as the "same molecule".
        row = self._row_with(
            "image_roundtrip_evaluator",
            expected_canonical_smiles=PYRIDONE_LACTAM,
            acceptable_canonical_smiles=[PYRIDONE_LACTAM],
        )
        verdict = chemistry_gate(row, PYRIDINOL_LACTIM, "", trace_labels=[])
        self.assertFalse(
            verdict["pass"],
            "tautomer-swapped candidate must not pass the image-truth gate",
        )
        # Confirm the rejection is on BOTH channels — the drawn-form
        # difference survives RDKit canonicalization (it is NOT an
        # InChI-normalized equivalence).
        self.assertFalse(verdict["flat_match"])
        self.assertFalse(verdict["iso_match"])
        # Sanity: the matching drawn form (lactam == lactam) DOES pass.
        ok = chemistry_gate(row, PYRIDONE_LACTAM, "", trace_labels=[])
        self.assertTrue(ok["pass"])
        self.assertTrue(ok["iso_match"])

    def test_anti_tautomer_swap_rejected_via_forbidden_canonical(self):
        # Belt-and-braces: a manifest may also pin the wrong tautomer as a
        # forbidden canonical. The lactim must be rejected with the
        # matched_forbidden_canonical reason even before the accept check.
        row = self._row_with(
            "image_roundtrip_evaluator",
            expected_canonical_smiles=PYRIDONE_LACTAM,
            acceptable_canonical_smiles=[PYRIDONE_LACTAM],
            forbidden_canonical_smiles=[PYRIDINOL_LACTIM],
        )
        verdict = chemistry_gate(row, PYRIDINOL_LACTIM, "", trace_labels=[])
        self.assertFalse(verdict["pass"])
        self.assertEqual(verdict["reason"], "matched_forbidden_canonical")

    def test_canonical_isomeric_smiles_plus_radical_count(self):
        # Methyl radical [CH3] vs methane.
        row = self._row_with(
            "canonical_isomeric_smiles_plus_radical_count",
            expected_canonical_smiles="[CH3]",
            acceptable_canonical_smiles=["[CH3]"],
        )
        ok = chemistry_gate(row, "[CH3]", "", trace_labels=[])
        self.assertTrue(ok["pass"])
        wrong = chemistry_gate(row, "C", "", trace_labels=[])
        self.assertFalse(wrong["pass"])

    def test_canonical_smiles_plus_isomer_specificity_rejects_forbidden(self):
        row = self._row_with(
            "canonical_smiles_plus_isomer_specificity",
            expected_canonical_smiles="Cc1ccc(O)cc1",
            acceptable_canonical_smiles=["Cc1ccc(O)cc1"],
            forbidden_canonical_smiles=["Cc1ccccc1O"],
        )
        good = chemistry_gate(row, "Cc1ccc(O)cc1", "", trace_labels=[])
        self.assertTrue(good["pass"])
        forbidden = chemistry_gate(row, "Cc1ccccc1O", "", trace_labels=[])
        self.assertFalse(forbidden["pass"])
        self.assertEqual(forbidden["reason"], "matched_forbidden_canonical")

    # ---- image_refusal_evaluator (image-rebuild v3 phase 5) ----

    def _refusal_row(self, expected_reason: str = "reaction_input") -> dict:
        return {
            "id": "I-RFG-TEST",
            "grading": "image_refusal_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_smiles": "FAIL_EXPECTED",
            "expected_canonical_smiles": "FAIL_EXPECTED",
            "acceptable_canonical_smiles": [],
            "expected_refusal_reason": expected_reason,
        }

    def test_image_refusal_evaluator_passes_when_refuse_observed_no_smiles(self):
        verdict = chemistry_gate(
            self._refusal_row(), None, "", trace_labels=["refuse"]
        )
        self.assertTrue(verdict["pass"])
        self.assertEqual(verdict["mode"], "image_refusal_evaluator")
        self.assertTrue(verdict["refusal_observed"])

    def test_image_refusal_evaluator_fails_without_refuse_event(self):
        verdict = chemistry_gate(
            self._refusal_row(),
            None,
            "I cannot do this.",
            trace_labels=["validate_graph"],
        )
        self.assertFalse(verdict["pass"])
        self.assertEqual(verdict["reason"], "refusal_expected_but_not_observed")

    def test_image_refusal_evaluator_fails_when_smiles_line_authored(self):
        # If the agent authored a `SMILES:` terminal line, the row was not
        # a refusal — the refusal-positive fixture has no expected SMILES,
        # so this is a hard fail.
        verdict = chemistry_gate(
            self._refusal_row(),
            "c1ccccc1",
            "SMILES: c1ccccc1",
            trace_labels=["refuse", "export_smiles"],
        )
        self.assertFalse(verdict["pass"])
        self.assertEqual(verdict["reason"], "refusal_expected_but_not_observed")

    def test_image_refusal_evaluator_tolerates_smiles_y_token_in_prose(self):
        # Prose like "I cannot transcribe it" contains "transcribe" / "it"
        # which the generic extract_final_smiles fallback grabs as a
        # SMILES candidate. The refusal mode must NOT credit that — only
        # an explicit `SMILES:` terminal line counts as SMILES authorship.
        verdict = chemistry_gate(
            self._refusal_row(),
            "transcribe",  # what extract_final_smiles returns from prose
            "I cannot transcribe this image. Refused.",
            trace_labels=["refuse"],
        )
        self.assertTrue(verdict["pass"])
        self.assertTrue(verdict["refusal_observed"])


class IntegrityGateTests(unittest.TestCase):
    """Image-rebuild rows must NOT call load_smiles / load_canonical —
    those shortcuts bypass the reconstruction-capability test the suite
    exists to measure."""

    def _image_row(self):
        return {
            "id": "I_TEST",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": "c1ccccc1",
        }

    def test_image_row_with_load_smiles_event_fails(self):
        gate = integrity_gate(self._image_row(), ["load_smiles", "render_canvas"])
        self.assertIsNotNone(gate)
        self.assertFalse(gate["pass"])
        self.assertIn("load_smiles", gate["forbidden_observed"])

    def test_image_row_with_load_canonical_event_fails(self):
        gate = integrity_gate(self._image_row(), ["load_canonical", "export_smiles"])
        self.assertIsNotNone(gate)
        self.assertFalse(gate["pass"])
        self.assertIn("load_canonical", gate["forbidden_observed"])

    def test_image_row_clean_passes(self):
        gate = integrity_gate(
            self._image_row(),
            ["add_fragment", "set_atom_charge", "render_canvas", "export_smiles"],
        )
        self.assertIsNotNone(gate)
        self.assertTrue(gate["pass"])

    def test_non_image_row_skips_gate(self):
        non_image_row = {
            "id": "C001",
            "grading": "canonical_smiles",
            "expected_canonical_smiles": "c1ccccc1",
        }
        gate = integrity_gate(non_image_row, ["load_smiles", "export_smiles"])
        self.assertIsNone(gate)


class ExportProvenanceGateTests(unittest.TestCase):
    """Image-row SMILES must be the exact value Ketcher exported."""

    @staticmethod
    def _image_row() -> dict:
        return {
            "id": "I_EXPORT",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": "c1ccccc1",
            "expected_failure": False,
        }

    def test_matching_trace_export_passes(self):
        gate = export_provenance_gate(
            self._image_row(),
            {"events": [_export_event("c1ccccc1")]},
            "c1ccccc1",
        )
        assert gate is not None
        self.assertTrue(gate["pass"])
        self.assertEqual(gate["matched_source"], "trace")

    def test_label_only_export_fails(self):
        gate = export_provenance_gate(
            self._image_row(),
            {"events": [{"label": "export_smiles"}]},
            "c1ccccc1",
        )
        assert gate is not None
        self.assertFalse(gate["pass"])
        self.assertEqual(gate["reason"], "export_smiles_missing_result")

    def test_exported_smiles_mismatch_fails(self):
        gate = export_provenance_gate(
            self._image_row(),
            {"events": [_export_event("c1ccncc1")]},
            "c1ccccc1",
        )
        assert gate is not None
        self.assertFalse(gate["pass"])
        self.assertEqual(gate["reason"], "exported_smiles_mismatch")

    def test_row_scoped_session_trace_export_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            rowdir = Path(tmp)
            trace_path = rowdir / "trace.json"
            trace_path.write_text(json.dumps({"events": []}))
            (rowdir / "_session_trace.json").write_text(json.dumps([
                {
                    "tool": "export_smiles",
                    "rowId": "I_EXPORT",
                    "result": {"ok": True, "smiles": "c1ccccc1"},
                }
            ]))
            gate = export_provenance_gate(
                self._image_row(), {"events": []}, "c1ccccc1", str(trace_path)
            )
        assert gate is not None
        self.assertTrue(gate["pass"])
        self.assertEqual(gate["matched_source"], "session_trace")


class ExecutionGateMultisetTests(unittest.TestCase):
    """The gate consumes each required event exactly once (multiset pop),
    so a row that requires the same op twice MUST see the op twice in the
    trace — once is not enough."""

    def test_required_event_twice_only_seen_once_fails(self):
        row = {
            "id": "RT001",
            "required_trace_events": ["set_bond_order", "set_bond_order", "export_smiles"],
        }
        labels = ["set_bond_order", "export_smiles"]
        result = execution_gate(row, labels)
        self.assertFalse(result["pass"])
        self.assertIn("set_bond_order", result["missing_events"])

    def test_required_event_twice_seen_twice_passes(self):
        row = {
            "id": "RT001",
            "required_trace_events": ["set_bond_order", "set_bond_order", "export_smiles"],
        }
        labels = ["set_bond_order", "set_bond_order", "export_smiles"]
        result = execution_gate(row, labels)
        self.assertTrue(result["pass"])

    def test_extra_labels_in_trace_are_ignored(self):
        row = {
            "id": "C001",
            "required_trace_events": ["load_smiles", "export_smiles"],
        }
        labels = ["load_smiles", "get_state", "render_canvas", "export_smiles"]
        self.assertTrue(execution_gate(row, labels)["pass"])

    def test_build_from_graph_satisfies_construct_alias(self):
        row = {
            "id": "A004",
            "required_trace_events": [
                "load_or_construct_in_ketcher",
                "render_canvas",
                "export_smiles",
            ],
        }
        labels = ["clear_canvas", "build_from_graph", "render_canvas", "export_smiles"]
        result = execution_gate(row, labels)
        self.assertTrue(result["pass"])
        self.assertIn("load_or_construct_in_ketcher", result["actual_labels"])

    def test_expands_export_smiles_aliases(self):
        labels = expand_execution_labels(["export_smiles"])
        self.assertIn("getSmiles", labels)
        self.assertIn("getSmiles_or_product_export", labels)

    def test_swept_image_row_shape_passes_execution_gate(self):
        # The post-sweep production label list (Phase 2 of the
        # image-harness-grading-correctness plan): the legacy
        # `vision_consistency_verified` ingest-era sentinel is gone, leaving
        # exactly the three events the image-rebuild contract + orchestrator
        # trace synthesis actually produce. A swept row's required events
        # must pass the gate against a real build trace.
        row = {
            "id": "I015",
            "required_trace_events": [
                "load_or_construct_in_ketcher",
                "render_canvas",
                "export_smiles",
            ],
        }
        labels = ["clear_canvas", "build_from_graph", "render_canvas", "export_smiles"]
        self.assertTrue(execution_gate(row, labels)["pass"])

    def test_no_manifest_row_requires_vision_consistency_verified(self):
        # The orchestrator's trace synthesis has no branch that emits
        # `vision_consistency_verified` (it is an ingest-era readback
        # sentinel the current image-rebuild SKILL never instructs), so any
        # image row that still lists it in `required_trace_events` is
        # structurally unsatisfiable -> execution_gate false-fails it. After
        # the Phase 2 sweep, NO row may carry the token.
        manifest = (
            REPO_ROOT / "tests" / "ketcher" / "image-to-smiles" / "manifest.jsonl"
        )
        offenders: list[str] = []
        for line in manifest.read_text(encoding="utf8").splitlines():
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            required = row.get("required_trace_events") or []
            if "vision_consistency_verified" in required:
                offenders.append(str(row.get("id")))
        self.assertEqual(
            offenders,
            [],
            f"{len(offenders)} rows still carry the legacy "
            f"vision_consistency_verified token: {offenders}",
        )


class RefusalExecutionAliasTests(unittest.TestCase):
    """Negative-control / refusal rows terminate via the `refuse` MCP tool,
    so the production / agent-orch trace carries a `refuse` event but NOT the
    synthetic `handle_recognition_failure_without_invention` host label that
    trace_capture.ts pushes (the synthesize helper maps refuse -> ['refuse']
    only). The grader's execution_gate must alias refuse -> that label when
    the agent invented nothing (no export event AND no candidate SMILES), and
    must NOT credit it when a SMILES / export is present (a real failure).
    """

    REQUIRED = ["handle_recognition_failure_without_invention"]

    def test_refuse_no_export_no_smiles_credits_required_event(self):
        row = {"id": "N001", "required_trace_events": self.REQUIRED}
        labels = ["Read", "vision_identify_structure", "refuse", "refuse"]
        result = execution_gate(row, labels, final_smiles=None)
        self.assertTrue(result["pass"])
        self.assertTrue(result["refusal_alias_applied"])
        self.assertIn(
            "handle_recognition_failure_without_invention",
            result["matched_events"],
        )

    def test_no_credit_when_export_present(self):
        # An export happened -> this is NOT a clean refusal; never credit.
        row = {"id": "N001", "required_trace_events": self.REQUIRED}
        labels = ["refuse", "export_smiles"]
        result = execution_gate(row, labels, final_smiles=None)
        self.assertFalse(result["pass"])
        self.assertFalse(result["refusal_alias_applied"])

    def test_no_credit_when_candidate_smiles_emitted(self):
        # A SMILES was emitted -> the agent invented; never credit.
        row = {"id": "N001", "required_trace_events": self.REQUIRED}
        labels = ["refuse"]
        result = execution_gate(row, labels, final_smiles="c1ccccc1")
        self.assertFalse(result["pass"])
        self.assertFalse(result["refusal_alias_applied"])

    def test_no_credit_without_refuse_event(self):
        # No refuse event at all -> nothing to alias from.
        row = {"id": "N001", "required_trace_events": self.REQUIRED}
        labels = ["Read", "vision_identify_structure"]
        result = execution_gate(row, labels, final_smiles=None)
        self.assertFalse(result["pass"])
        self.assertFalse(result["refusal_alias_applied"])

    def test_explicit_null_candidate_smiles_not_scraped_from_prose(self):
        # The agent-orch candidate.json sets candidate_smiles: null on a
        # refusal row; extract_final_smiles must honor that rather than
        # scrape the last SMILES-y token ("refuse") out of subagent_summary.
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "candidate.json"
            p.write_text(json.dumps({
                "id": "N001",
                "candidate_smiles": None,
                "subagent_summary": (
                    "Recognition failed; I refused via the `refuse` MCP "
                    "tool. No SMILES invented.\n\nTRACE: refuse\n"
                ),
            }))
            self.assertIsNone(extract_final_smiles(str(p)))

    def test_explicit_present_candidate_smiles_still_used(self):
        # A real candidate_smiles must still be returned (no regression).
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "candidate.json"
            p.write_text(json.dumps({
                "id": "C001",
                "candidate_smiles": "c1ccccc1",
                "subagent_summary": "SMILES: c1ccccc1",
            }))
            self.assertEqual(extract_final_smiles(str(p)), "c1ccccc1")


GRADER_PATH = Path(__file__).resolve().parent / "grader.py"


def _run_grader(row: dict, trace: dict, transcript: dict) -> dict:
    """Invoke the grader subprocess on disk artifacts; return parsed output."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        trace_path = tmp_path / "trace.json"
        transcript_path = tmp_path / "candidate.json"
        out_path = tmp_path / "grade.json"
        trace_path.write_text(json.dumps(trace))
        transcript_path.write_text(json.dumps(transcript))
        env = {**os.environ}
        result = subprocess.run(
            [
                sys.executable,
                str(GRADER_PATH),
                "--row",
                json.dumps(row),
                "--trace",
                str(trace_path),
                "--transcript",
                str(transcript_path),
                "--out",
                str(out_path),
            ],
            capture_output=True,
            text=True,
            env=env,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"grader exit {result.returncode}\nstderr: {result.stderr}"
            )
        return json.loads(out_path.read_text())


def _export_event(smiles: str, **extra: object) -> dict:
    return {
        "label": "export_smiles",
        "result": {"ok": True, "data": {"smiles": smiles, "canonical": False}},
        **extra,
    }


class RefusalEndToEndTests(unittest.TestCase):
    """End-to-end grade of an N001-shaped negative-control row whose RAW
    trace carries `refuse` only (no injected host label). Proves the full
    grader pipeline now returns deterministic_pass on a clean refusal.
    """

    ROW = {
        "id": "N001",
        "suite": "image_negative_controls",
        "grading": "safe_failure_plus_no_invented_smiles",
        "expected_smiles": "FAIL_EXPECTED",
        "expected_canonical_smiles": "FAIL_EXPECTED",
        "expected_failure": True,
        "required_trace_events": [
            "handle_recognition_failure_without_invention"
        ],
        "forbidden_canonical_smiles": [],
    }

    # Raw refuse-only trace — exactly the synthesized shape MINUS the
    # hand-injected host label.
    TRACE = {
        "events": [
            {"raw_tool": "Read", "label": "Read", "ts_index": 0},
            {"raw_tool": "Read", "label": "vision_identify_structure", "ts_index": 0},
            {"raw_tool": "refuse", "label": "refuse", "ts_index": 1},
            {
                "raw_tool": "refuse",
                "label": "refuse",
                "ts_index": 2,
                "result": {"ok": True, "data": {"ok": True, "classification": "non_structure"}},
            },
        ],
        "final_assistant_text": (
            "Recognition failed; I refused via the `refuse` MCP tool. "
            "No SMILES invented.\n\nTRACE: refuse\n"
        ),
    }

    TRANSCRIPT = {
        "id": "N001",
        "candidate_smiles": None,
        "subagent_summary": (
            "Recognition failed; I refused via the `refuse` MCP tool with "
            "pixel-grounded evidence. No SMILES invented.\n\nTRACE: refuse\n"
        ),
    }

    def test_clean_refusal_passes_from_raw_refuse_only_trace(self):
        grade = _run_grader(self.ROW, self.TRACE, self.TRANSCRIPT)
        self.assertTrue(
            grade["deterministic_pass"],
            f"expected deterministic_pass, got reason={grade.get('reason')}",
        )
        self.assertEqual(grade.get("reason"), "deterministic_pass")

    def test_invented_smiles_refusal_row_still_fails(self):
        # Same negative-control row, but the agent emitted a SMILES (and
        # exported it). This is a TRUE failure — must NOT be credited.
        trace = json.loads(json.dumps(self.TRACE))
        trace["events"].append(_export_event("c1ccccc1"))
        trace["final_assistant_text"] = "SMILES: c1ccccc1"
        transcript = {"id": "N001", "candidate_smiles": "c1ccccc1"}
        grade = _run_grader(self.ROW, trace, transcript)
        self.assertFalse(grade["deterministic_pass"])


class LockGateTests(unittest.TestCase):
    """LOCK enforcement gate unit tests (2026-05-26 refactor)."""

    @staticmethod
    def _image_row(expected: dict | None = None) -> dict:
        return {
            "id": "TEST",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_features": expected or {},
        }

    def test_refusal_evidence_accepts_success_with_smiles(self):
        # Row terminated with a SMILES line → refusal not expected, gate
        # passes regardless of trace.
        trace = {"events": [{"label": "export_smiles"}]}
        result = refusal_evidence_gate(
            self._image_row(), trace, "SMILES: c1ccccc1"
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertTrue(result["pass"])

    def test_refusal_evidence_requires_refuse_tool_call_when_no_smiles(self):
        # No SMILES line + no refuse event → fail.
        trace = {"events": [{"label": "validate_graph"}]}
        result = refusal_evidence_gate(
            self._image_row(), trace, "I cannot transcribe this image."
        )
        assert result is not None
        self.assertFalse(result["pass"])
        self.assertIn("refuse_tool_not_called", result["failures"])

    def test_refusal_evidence_accepts_known_classification(self):
        trace = {
            "events": [
                {
                    "label": "refuse",
                    "result": {"backend_classification": "non_structure"},
                }
            ]
        }
        result = refusal_evidence_gate(
            self._image_row(), trace, "could not transcribe; refused."
        )
        assert result is not None
        self.assertTrue(result["pass"])
        self.assertEqual(result["classification"], "non_structure")

    def test_refusal_evidence_rejects_unknown_classification(self):
        trace = {
            "events": [
                {
                    "label": "refuse",
                    "result": {"backend_classification": "made_up_reason"},
                }
            ]
        }
        result = refusal_evidence_gate(
            self._image_row(), trace, "could not transcribe; refused."
        )
        assert result is not None
        self.assertFalse(result["pass"])
        self.assertIn("refuse_classification_unknown", result["failures"])

    def test_refusal_evidence_passes_when_classification_absent_from_trace(self):
        # Phase 4 trace_capture pairing has not yet landed in the row's
        # trace; refuse event has no `result.backend_classification`.
        # Gate is lenient — refusal happened, classification will be
        # paired in by Phase 4.
        trace = {"events": [{"label": "refuse"}]}
        result = refusal_evidence_gate(
            self._image_row(), trace, "refused"
        )
        assert result is not None
        self.assertTrue(result["pass"])
        self.assertEqual(result["refuse_event_count"], 1)

    def test_refusal_evidence_passes_when_expected_reason_matches(self):
        # Image-rebuild v3 phase 5: refusal-positive fixtures carry an
        # `expected_refusal_reason`; gate must require classification to
        # match.
        row = self._image_row()
        row["expected_refusal_reason"] = "reaction_input"
        trace = {
            "events": [
                {
                    "label": "refuse",
                    "result": {"backend_classification": "reaction_input"},
                }
            ]
        }
        result = refusal_evidence_gate(row, trace, "refused")
        assert result is not None
        self.assertTrue(result["pass"])
        self.assertEqual(result["classification"], "reaction_input")

    def test_refusal_evidence_fails_when_expected_reason_mismatches(self):
        row = self._image_row()
        row["expected_refusal_reason"] = "reaction_input"
        trace = {
            "events": [
                {
                    "label": "refuse",
                    "result": {"backend_classification": "markush_or_rgroup"},
                }
            ]
        }
        result = refusal_evidence_gate(row, trace, "refused")
        assert result is not None
        self.assertFalse(result["pass"])
        self.assertTrue(
            any(
                f.startswith("refuse_classification_mismatch")
                for f in result["failures"]
            )
        )

    # ── Fabricated session-cap refusal (Phase 4) ──────────────────────
    #
    # Verdict-HONESTY fix, NOT a new pass/fail requirement. Fires ONLY on a
    # NON-exporting row that CLAIMS a runtime cap WITHOUT the runtime
    # `_session_trace.json` `session_terminated` artifact backing it. It must
    # NEVER scrutinize exported (successful) work for cap prose — doing so
    # re-creates the `stereo_false_green` false-fail-on-correct-work mode.

    @staticmethod
    def _write_trace_with_session_sidecar(
        tmpdir: str, session_events: list | None
    ) -> str:
        """Write a dummy trace.json + (optional) sibling _session_trace.json.

        Returns the trace.json path (what `args.trace` / `trace_path` carries).
        The grader reads `_session_trace.json` from `Path(trace_path).parent`.
        """
        d = Path(tmpdir)
        trace_path = d / "trace.json"
        trace_path.write_text(json.dumps({"events": []}))
        if session_events is not None:
            (d / "_session_trace.json").write_text(json.dumps(session_events))
        return str(trace_path)

    def test_fabricated_session_cap_fails_non_exporting_row_without_artifact(self):
        # (a) POSITIVE: non-exporting row whose final_text claims the 50-call
        # cap / "used 53" with NO _session_trace.json session_terminated event
        # → FAIL bucket fabricated_session_cap.
        with tempfile.TemporaryDirectory() as tmp:
            trace_path = self._write_trace_with_session_sidecar(tmp, None)
            trace = {"events": [{"label": "refuse"}]}
            final_text = (
                "I hit the 50-call cap after exhausting my turns "
                "(used 53). I have to stop here."
            )
            result = refusal_evidence_gate(
                self._image_row(), trace, final_text, trace_path=trace_path
            )
            assert result is not None
            self.assertFalse(result["pass"])
            self.assertIn("fabricated_session_cap", result["failures"])

    def test_genuine_session_cap_is_honored_with_terminated_artifact(self):
        # (b) GENUINE cap: a bare-list _session_trace.json carrying an element
        # whose result.error_code == 'session_terminated' → cap refusal is
        # honored (NOT bucketed fabricated).
        session_events = [
            {"tool": "validate_graph", "result": {"ok": True}},
            {
                "tool": "validate_graph",
                "result": {"ok": False, "error_code": "session_terminated"},
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            trace_path = self._write_trace_with_session_sidecar(
                tmp, session_events
            )
            trace = {"events": [{"label": "refuse"}]}
            final_text = "I hit the 50-call cap and used 53 calls; refusing."
            result = refusal_evidence_gate(
                self._image_row(), trace, final_text, trace_path=trace_path
            )
            assert result is not None
            self.assertNotIn(
                "fabricated_session_cap", result.get("failures", [])
            )

    def test_fabricated_cap_detector_does_not_fire_on_honest_budget_prose(self):
        # (c) FP-NEGATIVE (load-bearing): honest crop/atom-budget prose must
        # NOT trip the detector. Reproduces the exact false-positive the loose
        # `used\\s*:?\\s*\\d+` / bare `budget` regex would cause.
        honest_prose = [
            "I stayed within the crop budget and used 4 of 6 allowed crops.",
            "I worked within the 50-atom budget for this molecule.",
            "Used 4 of 6 allowed crops; well within budget.",
        ]
        for final_text in honest_prose:
            with self.subTest(final_text=final_text):
                with tempfile.TemporaryDirectory() as tmp:
                    trace_path = self._write_trace_with_session_sidecar(
                        tmp, None
                    )
                    trace = {"events": [{"label": "refuse"}]}
                    result = refusal_evidence_gate(
                        self._image_row(),
                        trace,
                        final_text,
                        trace_path=trace_path,
                    )
                    assert result is not None
                    self.assertNotIn(
                        "fabricated_session_cap",
                        result.get("failures", []),
                        f"detector fired on honest prose: {final_text!r}",
                    )

    def test_fabricated_cap_detector_skips_exported_rows(self):
        # (d) Exported row with cap prose → the cap detector does NOT run at
        # all (the row already passes/fails on its export via execution_gate).
        # Detector keys on the export EVENT, not has_smiles_line: even with NO
        # SMILES line in final_text, a clean export_smiles event must exonerate
        # the row from cap scrutiny.
        with tempfile.TemporaryDirectory() as tmp:
            trace_path = self._write_trace_with_session_sidecar(tmp, None)
            trace = {"events": [{"label": "export_smiles"}]}
            final_text = (
                "I hit the 50-call cap and used 53; but here is the result."
            )
            result = refusal_evidence_gate(
                self._image_row(), trace, final_text, trace_path=trace_path
            )
            assert result is not None
            self.assertNotIn(
                "fabricated_session_cap", result.get("failures", [])
            )
            # An export EVENT exonerates from cap scrutiny regardless of the
            # absent SMILES line; the gate's export branch passes the row.
            self.assertTrue(result["pass"])

    def test_refusal_gate_back_compat_three_positional_args(self):
        # Back-compat: existing 3-arg call sites (no trace_path) must keep
        # working without a TypeError. A bare refuse with no cap prose passes
        # exactly as before (the new trace_path param defaults to None).
        trace = {"events": [{"label": "refuse"}]}
        result = refusal_evidence_gate(self._image_row(), trace, "refused")
        assert result is not None
        self.assertTrue(result["pass"])
        self.assertNotIn("fabricated_session_cap", result.get("failures", []))

    def test_fabricated_cap_fires_when_trace_path_absent_and_cap_claimed(self):
        # When the cap is CLAIMED but no trace_path is available to confirm the
        # `session_terminated` artifact, the claim is unbacked → fabricated.
        # (Mirrors the positive case: a cap claim with no resolvable artifact
        # is the fabrication; this is also the shape `main()` would never hit
        # since it always threads args.trace, but the contract is explicit.)
        trace = {"events": [{"label": "refuse"}]}
        result = refusal_evidence_gate(
            self._image_row(), trace, "I hit the 50-call cap; used 53."
        )
        assert result is not None
        self.assertFalse(result["pass"])
        self.assertIn("fabricated_session_cap", result["failures"])

    def test_crop_after_validate_passes_when_validate_precedes_crop(self):
        trace = {
            "events": [
                {"label": "validate_graph"},
                {"label": "crop_source_image"},
                {"label": "validate_graph"},
                {"label": "crop_source_image"},
            ]
        }
        result = crop_after_validate_gate(self._image_row(), trace)
        assert result is not None
        self.assertTrue(result["pass"])

    def test_crop_after_validate_fails_when_crop_precedes_validate(self):
        trace = {
            "events": [
                {"label": "crop_source_image"},
                {"label": "validate_graph"},
            ]
        }
        result = crop_after_validate_gate(self._image_row(), trace)
        assert result is not None
        self.assertFalse(result["pass"])
        self.assertIn("crop_before_validate", result["failures"])

    def test_crop_after_validate_inert_on_non_image_row(self):
        row = {"id": "R001", "grading": "reaction_smiles_pass"}
        result = crop_after_validate_gate(row, {"events": []})
        self.assertIsNone(result)

    def test_filename_inference_passes_when_filename_has_no_scaffold(self):
        row = self._image_row()
        row["image_path"] = "/fixtures/I001/molecule.png"
        trace = {
            "final_assistant_text": "transcribed glyphs and built. SMILES: c"
        }
        result = filename_inference_gate(row, trace)
        assert result is not None
        self.assertTrue(result["pass"])

    def test_filename_inference_passes_when_prose_omits_scaffold(self):
        row = self._image_row()
        row["image_path"] = "/fixtures/I004/paclitaxel.png"
        trace = {
            "final_assistant_text": (
                "decagon-shaped polycyclic with multiple wedges; "
                "transcribed pixel features."
            )
        }
        result = filename_inference_gate(row, trace)
        assert result is not None
        self.assertTrue(result["pass"])

    def test_filename_inference_fails_when_prose_echoes_filename_scaffold(self):
        row = self._image_row()
        row["image_path"] = "/fixtures/I004/paclitaxel.png"
        trace = {
            "final_assistant_text": (
                "This is the paclitaxel core; transcribing from memory."
            )
        }
        result = filename_inference_gate(row, trace)
        assert result is not None
        self.assertFalse(result["pass"])
        self.assertTrue(
            any(
                f.startswith("filename_scaffold_inferred:paclitaxel")
                for f in result["failures"]
            ),
            result["failures"],
        )

    def test_filename_inference_uses_assistant_message_blocks_when_present(self):
        row = self._image_row()
        row["image_path"] = "/fixtures/I009/vinblastine.png"
        trace = {
            "assistant_message_blocks": [
                "looking at the image",
                "this is the vinblastine bisindole alkaloid",
            ],
            "final_assistant_text": "SMILES: c",
        }
        result = filename_inference_gate(row, trace)
        assert result is not None
        self.assertFalse(result["pass"])
        self.assertIn(
            "filename_scaffold_inferred:vinblastine",
            result["failures"],
        )

    def test_iteration_budget_caps_validate_graph_at_3(self):
        trace = {
            "events": [
                {"label": "validate_graph"},
                {"label": "validate_graph"},
                {"label": "validate_graph"},
                {"label": "validate_graph"},  # 4th — over cap
            ]
        }
        result = iteration_budget_gate(self._image_row(), trace)
        assert result is not None
        self.assertFalse(result["pass"])

    def test_iteration_budget_caps_crops_at_6(self):
        trace = {"events": [{"label": "crop_source_image"} for _ in range(7)]}
        result = iteration_budget_gate(self._image_row(), trace)
        assert result is not None
        self.assertFalse(result["pass"])

    def test_tile_budget_caps_cumulative_at_50(self):
        # 3× N=800 crops = 3 × 16 = 48 tiles → pass; 4× N=800 = 64 → fail.
        ok_trace = {
            "events": [
                {"label": "crop_source_image", "args": {"w": 800, "h": 800}}
                for _ in range(3)
            ]
        }
        ok = tile_budget_gate(self._image_row(), ok_trace)
        assert ok is not None
        self.assertTrue(ok["pass"])
        self.assertEqual(ok["total_tiles"], 48)

        bad_trace = {
            "events": [
                {"label": "crop_source_image", "args": {"w": 800, "h": 800}}
                for _ in range(4)
            ]
        }
        bad = tile_budget_gate(self._image_row(), bad_trace)
        assert bad is not None
        self.assertFalse(bad["pass"])
        self.assertEqual(bad["total_tiles"], 64)
        self.assertIn("tile_budget_exceeded:64>50", bad["failures"])

    def test_tile_budget_returns_none_on_non_image_row(self):
        # Reaction row → not image — gate inert.
        row = {"id": "R001", "grading": "reaction_smiles_pass"}
        result = tile_budget_gate(row, {"events": []})
        self.assertIsNone(result)

    def test_tile_budget_under_counts_when_args_missing(self):
        # Defensive: malformed events count as 1 tile (lower bound), gate
        # still passes when cumulative ≤ 50.
        trace = {
            "events": [{"label": "crop_source_image"} for _ in range(5)]
        }
        result = tile_budget_gate(self._image_row(), trace)
        assert result is not None
        self.assertTrue(result["pass"])
        self.assertEqual(result["total_tiles"], 5)

    def test_stereo_escape_hatch_passes_with_no_unknowns(self):
        # No stereo_label: 'unknown' submitted — gate inert (pass).
        trace = {
            "events": [
                {
                    "label": "build_from_graph",
                    "args": {
                        "graph": {
                            "stereoTransfer": [
                                {"center": 1, "stereo_label": "R"},
                                {"center": 2, "stereo_label": "S"},
                            ],
                            "unresolved": [],
                        }
                    },
                }
            ]
        }
        result = stereo_escape_hatch_gate(self._image_row(), trace)
        assert result is not None
        self.assertTrue(result["pass"])

    def test_stereo_escape_hatch_rejects_unknown_without_zoom_evidence(self):
        # Agent submits 2 unknowns + 0 wedge_orientation unresolved → fail.
        trace = {
            "events": [
                {
                    "label": "build_from_graph",
                    "args": {
                        "graph": {
                            "stereoTransfer": [
                                {"center": 1, "stereo_label": "unknown"},
                                {"center": 2, "stereo_label": "unknown"},
                            ],
                            "unresolved": [],
                        }
                    },
                }
            ]
        }
        result = stereo_escape_hatch_gate(self._image_row(), trace)
        assert result is not None
        self.assertFalse(result["pass"])
        self.assertIn(
            "stereo_label_unknown_without_zoom_trigger:"
            "unknown=2_zoom_evidence=0",
            result["failures"],
        )

    def test_stereo_escape_hatch_accepts_unknown_with_matching_zoom_evidence(
        self,
    ):
        # 2 unknowns + 2 wedge_orientation unresolved → pass.
        trace = {
            "events": [
                {
                    "label": "build_from_graph",
                    "args": {
                        "graph": {
                            "stereoTransfer": [
                                {"center": 1, "stereo_label": "unknown"},
                                {"center": 2, "stereo_label": "unknown"},
                            ],
                            "unresolved": [
                                {
                                    "field": "wedge_orientation",
                                    "record_id": "bond:17",
                                    "note": "saddle",
                                    "state": "source_limited",
                                },
                                {
                                    "field": "wedge_orientation",
                                    "record_id": "bond:23",
                                    "note": "crossed bond",
                                    "state": "source_limited",
                                },
                            ],
                        }
                    },
                }
            ]
        }
        result = stereo_escape_hatch_gate(self._image_row(), trace)
        assert result is not None
        self.assertTrue(result["pass"])

    def test_stereo_escape_hatch_exempts_beyond_protocol(self):
        # stereo_label: 'beyond_protocol' has its own enforcement
        # (beyond_protocol_gate) — this gate should not flag it.
        trace = {
            "events": [
                {
                    "label": "build_from_graph",
                    "args": {
                        "graph": {
                            "stereoTransfer": [
                                {
                                    "center": 1,
                                    "stereo_label": "beyond_protocol",
                                    "beyond_protocol_reason": "axial_chirality",
                                },
                            ],
                            "unresolved": [],
                        }
                    },
                }
            ]
        }
        result = stereo_escape_hatch_gate(self._image_row(), trace)
        assert result is not None
        self.assertTrue(result["pass"])

    def test_transcript_image_input_requires_read_before_build(self):
        # Build with no Read at all → fail.
        bad_trace = {
            "events": [
                {"label": "build_from_graph"},
                {"label": "render_canvas"},
            ]
        }
        bad = transcript_image_input_gate(self._image_row(), bad_trace)
        assert bad is not None
        self.assertFalse(bad["pass"])
        self.assertIn("image_not_read_before_build", bad["failures"])
        # Read before build → pass.
        good_trace = {
            "events": [
                {"label": "Read", "path": "/abs/source.png"},
                {"label": "build_from_graph"},
            ]
        }
        good = transcript_image_input_gate(self._image_row(), good_trace)
        assert good is not None
        self.assertTrue(good["pass"])

    def test_transcript_image_input_does_not_flag_crop_before_full_image(self):
        # T1 (KETCHER_CROP_AFTER_VALIDATE) structurally prevents this
        # sequence; the trace-side audit lives in
        # crop_after_validate_gate now. Confirm the old crop-before-
        # full-image bucket no longer fires here.
        trace = {
            "events": [
                {"label": "Read", "path": "/abs/crops/100_200_300_300.png"},
                {"label": "Read", "path": "/abs/source.png"},
                {"label": "build_from_graph"},
            ]
        }
        result = transcript_image_input_gate(self._image_row(), trace)
        assert result is not None
        self.assertTrue(result["pass"])

    def test_crop_rationale_requires_one_per_crop(self):
        trace = {"events": [{"label": "crop_source_image"}, {"label": "crop_source_image"}]}
        # 2 crops, 0 rationale lines → fail.
        result = crop_rationale_gate(self._image_row(), trace, "SMILES: c")
        assert result is not None
        self.assertFalse(result["pass"])
        # 2 crops + 2 rationale lines with pixel cues → pass.
        text = (
            "CROP_RATIONALE: /abs/crops/a.png resolved atom:5:element=N from printed glyph reads 'N'\n"
            "CROP_RATIONALE: /abs/crops/b.png resolved bond:7:wedge_orientation=solid from wide-end visible at upper-left\n"
            "SMILES: c"
        )
        good = crop_rationale_gate(self._image_row(), trace, text)
        assert good is not None
        self.assertTrue(good["pass"])

    def test_crop_rationale_rejects_scaffold_name(self):
        trace = {"events": [{"label": "crop_source_image"}]}
        text = (
            "CROP_RATIONALE: /abs/crops/a.png resolved atom:5:element=N from this is the paclitaxel core\n"
            "SMILES: c"
        )
        result = crop_rationale_gate(self._image_row(), trace, text)
        assert result is not None
        self.assertFalse(result["pass"])
        self.assertIn("crop_rationale_chemistry_leak", result["failures"])

    def test_mirror_check_required_when_warning_emitted(self):
        text_no_warn = "SMILES: c1ccccc1"
        result_no_warn = mirror_check_gate(
            self._image_row(), {"events": []}, text_no_warn
        )
        assert result_no_warn is not None
        self.assertTrue(result_no_warn["pass"])
        text_warn = "chirality_mirror_warning fired\nSMILES: c1ccccc1"
        bad = mirror_check_gate(self._image_row(), {"events": []}, text_warn)
        assert bad is not None
        self.assertFalse(bad["pass"])
        text_affirm = (
            "chirality_mirror_warning fired\nMIRROR_CHECK: ok visible wedge on right\nSMILES: c1ccccc1"
        )
        good = mirror_check_gate(
            self._image_row(), {"events": []}, text_affirm
        )
        assert good is not None
        self.assertTrue(good["pass"])

    def test_mirror_check_accepts_refuse_with_mirror_suspect_classification(self):
        text_warn = "chirality_mirror_warning fired; refused"
        trace = {
            "events": [
                {
                    "label": "refuse",
                    "result": {"backend_classification": "mirror_suspect"},
                }
            ]
        }
        result = mirror_check_gate(self._image_row(), trace, text_warn)
        assert result is not None
        self.assertTrue(result["pass"])


class MainCompositionTests(unittest.TestCase):
    """End-to-end checks: spawn the grader as a subprocess, give it
    realistic on-disk artifacts, and assert the W1 schema fields land in
    the output with the expected values."""

    def test_non_image_row_emits_grader_verdict_owner(self):
        row = {
            "id": "C001",
            "grading": "canonical_smiles",
            "expected_canonical_smiles": "c1ccccc1",
            "acceptable_canonical_smiles": ["c1ccccc1"],
            "required_trace_events": ["load_smiles", "export_smiles"],
        }
        trace = {
            "events": [
                {"label": "load_smiles"},
                _export_event("c1ccccc1"),
            ],
        }
        transcript = {
            "id": "C001",
            "candidate_smiles": "c1ccccc1",
            "subagent_summary": "loaded benzene; exported. SMILES: c1ccccc1",
        }
        grade = _run_grader(row, trace, transcript)
        self.assertEqual(grade["verdict_owner"], "grader")
        self.assertTrue(grade["deterministic_pass"])
        self.assertFalse(grade["certified"])  # non-image rows are not certified
        self.assertNotIn("evaluator_gate", grade)
        self.assertEqual(grade["reason"], "deterministic_pass")

    def test_image_row_emits_evaluator_verdict_owner_and_certified(self):
        row = {
            "id": "I001",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": "c1ccccc1",
            "acceptable_canonical_smiles": ["c1ccccc1"],
            "required_trace_events": ["add_fragment", "render_canvas", "export_smiles"],
        }
        trace = {
            "events": [
                # Read of source image before first build.
                {"label": "Read", "path": "tests/scientific/images/iconic/benzene.png"},
                {"label": "add_fragment"},
                {"label": "render_canvas"},
                _export_event("c1ccccc1"),
            ],
        }
        transcript = {
            "id": "I001",
            "candidate_smiles": "c1ccccc1",
            "subagent_summary": "rebuilt benzene from image.\nSMILES: c1ccccc1",
        }
        grade = _run_grader(row, trace, transcript)
        self.assertEqual(grade["verdict_owner"], "evaluator")
        self.assertTrue(grade["deterministic_pass"])
        self.assertTrue(
            grade["certified"],
            f"iso_match {grade['chemistry_gate'].get('iso_match')}; "
            f"integrity {grade.get('integrity_gate')}",
        )

    def test_image_row_with_load_smiles_event_loses_integrity_and_certified(self):
        row = {
            "id": "I002",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": "c1ccccc1",
            "acceptable_canonical_smiles": ["c1ccccc1"],
            "required_trace_events": [],
        }
        trace = {
            "events": [
                {"label": "load_smiles"},
                {"label": "render_canvas"},
                {"label": "export_smiles"},
            ],
        }
        transcript = {
            "id": "I002",
            "candidate_smiles": "c1ccccc1",
            "subagent_summary": "loaded benzene direct. SMILES: c1ccccc1",
        }
        grade = _run_grader(row, trace, transcript)
        self.assertEqual(grade["verdict_owner"], "evaluator")
        self.assertFalse(grade["deterministic_pass"])
        self.assertFalse(grade["certified"])
        self.assertFalse(grade["integrity_gate"]["pass"])
        self.assertEqual(grade["reason"], "integrity_gate_failed")

    def test_image_row_canonical_match_without_export_evidence_fails(self):
        row = {
            "id": "I-NOEXPORT",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": "c1ccccc1",
            "acceptable_canonical_smiles": ["c1ccccc1"],
            "required_trace_events": [],
        }
        trace = {"events": [{"label": "build_from_graph"}, {"label": "export_smiles"}]}
        transcript = {
            "id": "I-NOEXPORT",
            "candidate_smiles": "c1ccccc1",
            "subagent_summary": "SMILES: c1ccccc1",
        }
        grade = _run_grader(row, trace, transcript)
        self.assertFalse(grade["deterministic_pass"])
        self.assertEqual(grade["reason"], "export_provenance_gate_failed")
        self.assertEqual(
            grade["export_provenance_gate"]["reason"],
            "export_smiles_missing_result",
        )

    def test_image_row_export_smiles_mismatch_fails(self):
        row = {
            "id": "I-EXPORT-MISMATCH",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": "c1ccccc1",
            "acceptable_canonical_smiles": ["c1ccccc1"],
            "required_trace_events": [],
        }
        trace = {"events": [_export_event("c1ccncc1")]}
        transcript = {
            "id": "I-EXPORT-MISMATCH",
            "candidate_smiles": "c1ccccc1",
            "subagent_summary": "SMILES: c1ccccc1",
        }
        grade = _run_grader(row, trace, transcript)
        self.assertFalse(grade["deterministic_pass"])
        self.assertEqual(grade["reason"], "export_provenance_gate_failed")
        self.assertEqual(
            grade["export_provenance_gate"]["reason"],
            "exported_smiles_mismatch",
        )

    def test_image_row_wrong_canonical_fails_even_with_export(self):
        row = {
            "id": "I-WRONG-CANON",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": "c1ccccc1",
            "acceptable_canonical_smiles": ["c1ccccc1"],
            "required_trace_events": [],
        }
        trace = {"events": [_export_event("c1ccncc1")]}
        transcript = {
            "id": "I-WRONG-CANON",
            "candidate_smiles": "c1ccncc1",
            "subagent_summary": "SMILES: c1ccncc1",
        }
        grade = _run_grader(row, trace, transcript)
        self.assertFalse(grade["deterministic_pass"])
        self.assertEqual(grade["reason"], "chemistry_gate_failed")

    def test_image_row_missing_render_is_advisory_when_export_matches(self):
        row = {
            "id": "I-NORENDER",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": "c1ccccc1",
            "acceptable_canonical_smiles": ["c1ccccc1"],
            "required_trace_events": ["render_canvas", "export_smiles"],
        }
        trace = {"events": [_export_event("c1ccccc1")]}
        transcript = {
            "id": "I-NORENDER",
            "candidate_smiles": "c1ccccc1",
            "subagent_summary": "SMILES: c1ccccc1",
        }
        grade = _run_grader(row, trace, transcript)
        self.assertTrue(grade["deterministic_pass"])
        self.assertFalse(grade["execution_gate"]["pass"])
        self.assertTrue(grade["execution_gate"]["advisory"])
        self.assertFalse(grade["execution_gate"]["hard_fail"])

    def test_no_evaluator_arg_accepted(self):
        # The old --evaluator flag is gone. Confirm grader handles absence
        # of evaluator artifacts cleanly (no eval_gate emitted).
        row = {
            "id": "I003",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": "c1ccccc1",
            "acceptable_canonical_smiles": ["c1ccccc1"],
            "required_trace_events": [],
        }
        trace = {
            "events": [
                {"label": "add_fragment"},
                {"label": "render_canvas"},
                {"label": "export_smiles"},
            ],
        }
        transcript = {
            "id": "I003",
            "candidate_smiles": "c1ccccc1",
            "subagent_summary": "SMILES: c1ccccc1",
        }
        grade = _run_grader(row, trace, transcript)
        self.assertNotIn("evaluator_gate", grade)

    def test_vision_check_failure_does_not_flip_deterministic_pass(self):
        # Row carries expected_features → vision_fingerprint_gate fires.
        # If the block is missing, the gate fails — but that failure is
        # ADVISORY: deterministic_pass must remain True when
        # chem/exec/integrity/lock-gates all pass.
        row = {
            "id": "I004",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": "c1ccccc1",
            "acceptable_canonical_smiles": ["c1ccccc1"],
            "required_trace_events": [],
            "expected_features": {
                "heavy": 6,
                "rings": [{"size": 6, "aromatic": True}],
                "drawn_H_count": 0,
                "wedges": 0,
                "cis_trans_bonds": 0,
                "charges": 0,
            },
        }
        trace = {
            "events": [
                {"label": "Read", "path": "tests/scientific/images/iconic/benzene.png"},
                {"label": "add_fragment"},
                {"label": "render_canvas"},
                _export_event("c1ccccc1"),
            ],
        }
        transcript = {
            "id": "I004",
            "candidate_smiles": "c1ccccc1",
            # No VISION_CHECK block → vision gate fails as advisory.
            "subagent_summary": "rebuilt benzene.\nSMILES: c1ccccc1",
        }
        grade = _run_grader(row, trace, transcript)
        self.assertTrue(grade["deterministic_pass"])
        self.assertTrue(grade["vision_fingerprint_gate"]["advisory"])
        self.assertFalse(grade["vision_fingerprint_gate"]["pass"])
        # Failure surfaces in evaluator_notes, NOT in reason.
        self.assertIn("evaluator_notes", grade)
        self.assertTrue(
            any("vision_advisory" in n for n in grade["evaluator_notes"]),
            grade["evaluator_notes"],
        )

    def test_dense_vision_check_failure_does_not_raise_nameerror(self):
        # §5.6 regression lock. `_vision_failure_is_hard` referenced an
        # UNDEFINED `TOPOLOGY_VISION_FAILURE_RE` on the dense-row branch, so a
        # row that (a) carries an `expected_features.ring_connectivity`
        # (dense_visual_expected=True) and (b) emits a populated VISION_CHECK
        # whose failure is NOT `vision_verdict_inconsistent` reached the dead
        # `TOPOLOGY_VISION_FAILURE_RE.search(...)` call -> NameError, crashing
        # the grader subprocess (RuntimeError out of _run_grader). The block
        # below OMITS the required `ring_connectivity:` line -> the single
        # failure `missing_line_ring_connectivity`; VERDICT is deliberately
        # NOT `VISION_OK` so `vision_verdict_inconsistent` is never appended
        # and the regex branch is the one exercised. The grade must complete
        # cleanly (no NameError, no crash).
        row = {
            "id": "D-NAMEERROR",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": "c1ccc2ccccc2c1",
            "acceptable_canonical_smiles": ["c1ccc2ccccc2c1"],
            "required_trace_events": [],
            "expected_features": {
                "heavy": 10,
                "rings": [
                    {"size": 6, "aromatic": True},
                    {"size": 6, "aromatic": True},
                ],
                "drawn_H_count": 0,
                "wedges": 0,
                "cis_trans_bonds": 0,
                "charges": 0,
                "ring_connectivity": "fused:r0-r1",
            },
        }
        trace = {
            "events": [
                {"label": "Read", "path": "tests/scientific/images/iconic/x.png"},
                {"label": "build_from_graph"},
                {"label": "render_canvas"},
                {"label": "export_smiles"},
            ],
        }
        # Populated VISION_CHECK that omits the ring_connectivity sub-row and
        # does NOT declare VISION_OK.
        vision_block = (
            "===VISION_CHECK_BEGIN===\n"
            "VISION_CHECK:\n"
            "  heavy:           source=10             candidate=10\n"
            "  rings:           source=[(6,True),(6,True)] candidate=[(6,True),(6,True)]\n"
            "  drawn_H_atoms:   source=0              candidate=[]\n"
            "  wedges:          source=0              candidate=[]\n"
            "  cis_trans_bonds: source=0              candidate=[]\n"
            "  charges:         source=0              candidate=[]\n"
            "  arene_substitution_pattern: source=[] candidate=[]\n"
            "  ring_heteroatom_positions:  source=[] candidate=[]\n"
            "VERDICT: VISION_MISMATCH\n"
            "===VISION_CHECK_END==="
        )
        transcript = {
            "id": "D-NAMEERROR",
            "candidate_smiles": "c1ccc2ccccc2c1",
            "subagent_summary": "rebuilt naphthalene.\n" + vision_block
            + "\nSMILES: c1ccc2ccccc2c1",
        }
        # Pre-fix: this raises RuntimeError carrying the NameError from the
        # crashed subprocess. Post-fix: it returns a grade dict.
        grade = _run_grader(row, trace, transcript)
        # The dense connectivity-line miss is surfaced by the advisory vision
        # gate; it must NOT have been promoted to a hard fail via the deleted
        # regex branch.
        self.assertFalse(grade["vision_fingerprint_gate"]["pass"])
        self.assertIn(
            "missing_line_ring_connectivity",
            grade["vision_fingerprint_gate"]["failures"],
        )

    # ---- Task 5D Guard 3 (RE-SCOPED in Phase 1 — escape-hatch is now
    # ADVISORY-first): stereo_escape_hatch_gate is still WIRED into the
    # composed grade (sub-object emitted, failure surfaced in evaluator_notes),
    # but its un-blinding (on-disk dump resolution) is a polarity-risk
    # tightening, so it NO LONGER feeds `deterministic_pass` as a hard fail
    # until a full-corpus run confirms zero new failures. This pins the
    # advisory-first contract so a future grader rewrite can't silently drop
    # the gate AND can't silently re-promote it to hard without updating here.
    # (Uses an ACHIRAL expected so stereo_false_green is N/A and the
    # escape-hatch is the only stereo gate in play.)
    def test_stereo_escape_hatch_failure_is_advisory_not_hard(self):
        # All-unknown-stereo cheat: 1 stereo_label:'unknown' center with ZERO
        # matching wedge_orientation unresolved entries. The gate FAILS and is
        # surfaced, but it stays advisory and does NOT deny deterministic_pass.
        row = {
            "id": "I-SEH",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": "c1ccccc1",
            "acceptable_canonical_smiles": ["c1ccccc1"],
            "required_trace_events": [],
        }
        trace = {
            "events": [
                {"label": "Read", "path": "tests/scientific/images/iconic/x.png"},
                {
                    "label": "build_from_graph",
                    "args": {
                        "graph": {
                            "stereoTransfer": [
                                {"center": 1, "stereo_label": "unknown"},
                            ],
                            "unresolved": [],
                        }
                    },
                },
                {"label": "render_canvas"},
                _export_event("c1ccccc1"),
            ],
        }
        transcript = {
            "id": "I-SEH",
            "candidate_smiles": "c1ccccc1",
            "subagent_summary": "rebuilt benzene.\nSMILES: c1ccccc1",
        }
        grade = _run_grader(row, trace, transcript)
        # Gate sub-object is emitted, fails, but is tagged ADVISORY (not hard).
        self.assertIn("stereo_escape_hatch_gate", grade)
        self.assertFalse(grade["stereo_escape_hatch_gate"]["pass"])
        self.assertTrue(grade["stereo_escape_hatch_gate"]["advisory"])
        self.assertFalse(grade["stereo_escape_hatch_gate"]["hard_fail"])
        # It does NOT move the row verdict (advisory-first).
        self.assertTrue(grade["deterministic_pass"])
        # The failure is surfaced for the evaluator instead.
        self.assertTrue(
            any("stereo_escape_hatch_advisory" in n
                for n in grade.get("evaluator_notes", [])),
            grade.get("evaluator_notes"),
        )

    def test_stereo_escape_hatch_with_zoom_evidence_does_not_block(self):
        # 2 unknowns + 2 matching wedge_orientation unresolved entries →
        # the gate passes and does NOT block deterministic_pass.
        row = {
            "id": "I-SEH-OK",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": "c1ccccc1",
            "acceptable_canonical_smiles": ["c1ccccc1"],
            "required_trace_events": [],
        }
        trace = {
            "events": [
                {"label": "Read", "path": "tests/scientific/images/iconic/benzene.png"},
                {
                    "label": "build_from_graph",
                    "args": {
                        "graph": {
                            "stereoTransfer": [
                                {"center": 1, "stereo_label": "unknown"},
                                {"center": 2, "stereo_label": "unknown"},
                            ],
                            "unresolved": [
                                {
                                    "field": "wedge_orientation",
                                    "record_id": "bond:5",
                                    "note": "crowded wedge cluster",
                                    "state": "source_limited",
                                },
                                {
                                    "field": "wedge_orientation",
                                    "record_id": "bond:9",
                                    "note": "overlapping hash",
                                    "state": "source_limited",
                                },
                            ],
                        }
                    },
                },
                {"label": "render_canvas"},
                _export_event("c1ccccc1"),
            ],
        }
        transcript = {
            "id": "I-SEH-OK",
            "candidate_smiles": "c1ccccc1",
            "subagent_summary": "rebuilt benzene.\nSMILES: c1ccccc1",
        }
        grade = _run_grader(row, trace, transcript)
        self.assertTrue(grade["stereo_escape_hatch_gate"]["pass"])
        self.assertFalse(grade["stereo_escape_hatch_gate"]["hard_fail"])
        self.assertTrue(grade["deterministic_pass"])

    # ---- Task 5D Guard 4: image-truth via the composed grade. A drawn-form
    # difference that RDKit canonicalization erases on the connectivity
    # channel (here: dropped stereo → flat_match True but iso_match False)
    # must NOT be `certified` and MUST be routed to the evaluator subagent,
    # which owns the image-truth verdict (it has vision; the grader does
    # not). Pins the deterministic floor's deference to the evaluator so a
    # Task 5E rewrite can't auto-certify image rows on flat match alone.
    def test_image_row_flat_match_only_is_not_certified_and_evaluator_owned(self):
        row = {
            "id": "I-IMGTRUTH",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": L_ALANINE,
            "acceptable_canonical_smiles": [L_ALANINE],
            "required_trace_events": [],
        }
        trace = {
            "events": [
                {"label": "Read", "path": "tests/scientific/images/iconic/ala.png"},
                {"label": "add_fragment"},
                {"label": "render_canvas"},
                {"label": "export_smiles"},
            ],
        }
        transcript = {
            "id": "I-IMGTRUTH",
            # Candidate dropped the stereocenter — connectivity matches, but
            # the drawn wedge config does not. Deterministic pass is allowed
            # (flat match), but it must NOT certify and the verdict belongs
            # to the evaluator.
            "candidate_smiles": ALANINE_NO_STEREO,
            "subagent_summary": "rebuilt alanine.\nSMILES: " + ALANINE_NO_STEREO,
        }
        grade = _run_grader(row, trace, transcript)
        self.assertEqual(grade["verdict_owner"], "evaluator")
        self.assertTrue(grade["chemistry_gate"]["flat_match"])
        self.assertFalse(grade["chemistry_gate"]["iso_match"])
        self.assertFalse(
            grade["certified"],
            "flat-only image match must not auto-certify; evaluator owns it",
        )


class StereoFalseGreenGateTests(unittest.TestCase):
    """Task 6E — stereo false-green guard.

    A stereo-bearing IMAGE row may pass AS VISION only with a genuine
    vision-stereo read: an image/crop Read before the build, stereo as a
    WEDGE PRIMITIVE (not a seeded stereo_label literal), AND a stereo
    descriptor in the Indigo-perceived export. These pins fail→pass the gate
    on each axis, plus the two headline cases the task names (seeded-literal
    rejected; genuine wedge-primitive + image-Read + Indigo credited), at both
    the unit and composed-grade level.
    """

    @staticmethod
    def _image_row(expected: str = L_ALANINE) -> dict:
        return {
            "id": "I-6E",
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": expected,
            "acceptable_canonical_smiles": [expected],
            "required_trace_events": [],
        }

    @staticmethod
    def _wedge_primitive_build_event() -> dict:
        # Per-bond wedge primitive on the alanine Cα (id 2): wedge solid from
        # the chiral center to N (id 1). This is the genuine vision form.
        return {
            "label": "build_from_graph",
            "args": {
                "graph": {
                    "atoms": [
                        {"id": 1, "element": "N"},
                        {"id": 2, "element": "C", "stereo": "declared"},
                        {"id": 3, "element": "C"},
                    ],
                    "bonds": [
                        {"a": 1, "b": 2, "order": 1, "wedge": "solid", "wedge_from": 2},
                    ],
                }
            },
        }

    @staticmethod
    def _seeded_label_build_event() -> dict:
        # Hardcoded R/S literal — the agent authoring CIP directly (forbidden).
        return {
            "label": "build_from_graph",
            "args": {
                "graph": {
                    "atoms": [{"id": 2, "element": "C"}],
                    "bonds": [],
                    "stereoTransfer": [{"center": 2, "stereo_label": "S"}],
                }
            },
        }

    # ---- Applicability: skipped for the rows it must not touch. ----
    def test_skips_non_image_rows(self):
        row = {"id": "X", "grading": "canonical_isomeric_smiles",
               "expected_canonical_smiles": L_ALANINE}
        trace = {"events": [self._seeded_label_build_event()]}
        self.assertIsNone(stereo_false_green_gate(row, trace, L_ALANINE))

    def test_skips_achiral_image_rows(self):
        # Benzene image row — no stereocenter claimed → gate not applicable.
        row = self._image_row(expected="c1ccccc1")
        trace = {"events": [{"label": "Read", "path": "x.png"},
                            {"label": "build_from_graph", "args": {"graph": {}}}]}
        self.assertIsNone(stereo_false_green_gate(row, trace, "c1ccccc1"))

    # ---- (a) image-Read-before-build axis. ----
    def test_fails_when_no_image_read_before_build(self):
        # Wedge primitive + stereo export, but the build precedes any Read.
        trace = {"events": [
            self._wedge_primitive_build_event(),
            {"label": "Read", "path": "x.png"},  # read AFTER the build
            _export_event(L_ALANINE),
        ]}
        result = stereo_false_green_gate(self._image_row(), trace, L_ALANINE)
        assert result is not None
        self.assertFalse(result["pass"])
        self.assertIn("no_image_read_before_build", result["failures"])

    # ---- (b) seeded-literal axis (the headline reject case). ----
    def test_rejects_seeded_stereo_label_literal(self):
        # Image Read + Indigo stereo in export, BUT stereo came as a seeded
        # stereo_label:'S' literal — denied. This is the 6E headline case.
        trace = {"events": [
            {"label": "Read", "path": "tests/scientific/images/iconic/ala.png"},
            self._seeded_label_build_event(),
            {"label": "export_smiles"},
        ]}
        result = stereo_false_green_gate(self._image_row(), trace, L_ALANINE)
        assert result is not None
        self.assertFalse(result["pass"])
        self.assertTrue(
            any(f.startswith("seeded_stereo_label_literal") for f in result["failures"]),
            result["failures"],
        )

    def test_unknown_label_is_not_a_seeded_literal(self):
        # stereo_label:'unknown' is an explicit skip (policed by
        # stereo_escape_hatch_gate), NOT an R|S claim — it must not trip the
        # seeded-literal failure. (It still needs a wedge primitive OR will
        # fail on the no-wedge axis; here we add a wedge primitive so only the
        # seeded-literal axis is under test.)
        ev = self._wedge_primitive_build_event()
        ev["args"]["graph"]["stereoTransfer"] = [{"center": 2, "stereo_label": "unknown"}]
        trace = {"events": [
            {"label": "Read", "path": "x.png"}, ev, {"label": "export_smiles"}]}
        result = stereo_false_green_gate(self._image_row(), trace, L_ALANINE)
        assert result is not None
        self.assertEqual(result["seeded_label_centers"], [])
        self.assertTrue(result["pass"], result["failures"])

    # ---- (c) Indigo-reachability proxy axis. ----
    def test_fails_when_export_has_no_stereo_descriptor(self):
        # Genuine wedge primitive + image Read, but the export dropped stereo
        # (the no-Indigo signature: a stereo target built with Indigo down
        # cannot perceive CIP). Denied.
        trace = {"events": [
            {"label": "Read", "path": "x.png"},
            self._wedge_primitive_build_event(),
            {"label": "export_smiles"},
        ]}
        result = stereo_false_green_gate(
            self._image_row(), trace, ALANINE_NO_STEREO
        )
        assert result is not None
        self.assertFalse(result["pass"])
        self.assertIn("no_indigo_stereo_in_export", result["failures"])

    # ---- The headline credit case: genuine wedge + Read + Indigo. ----
    def test_credits_genuine_wedge_primitive_with_read_and_indigo(self):
        trace = {"events": [
            {"label": "Read", "path": "tests/scientific/images/iconic/ala.png"},
            self._wedge_primitive_build_event(),
            {"label": "render_canvas"},
            {"label": "export_smiles"},
        ]}
        result = stereo_false_green_gate(self._image_row(), trace, L_ALANINE)
        assert result is not None
        self.assertTrue(result["pass"], result["failures"])
        self.assertTrue(result["saw_wedge_primitive"])
        self.assertTrue(result["read_before_build"])
        self.assertTrue(result["indigo_perceived_stereo"])

    def test_credits_implicit_h_wedge_primitive(self):
        # wedge_to_implicit_h is also a genuine wedge primitive.
        ev = {
            "label": "build_from_graph",
            "args": {"graph": {
                "atoms": [{"id": 2, "element": "C", "wedge_to_implicit_h": "solid"}],
                "bonds": [],
            }},
        }
        trace = {"events": [
            {"label": "crop_source_image", "args": {"w": 200}},  # crop counts as a read
            ev, {"label": "export_smiles"}]}
        result = stereo_false_green_gate(self._image_row(), trace, L_ALANINE)
        assert result is not None
        self.assertTrue(result["pass"], result["failures"])
        self.assertTrue(result["saw_wedge_primitive"])

    # ---- Composed-grade pins (the gate is diagnostic, not acceptance). ----
    def test_seeded_literal_flips_deterministic_pass(self):
        # The 6E headline reject case, end to end: a seeded-literal stereo row
        # is surfaced even though the hard image contract passes.
        row = self._image_row()
        trace = {"events": [
            {"label": "Read", "path": "tests/scientific/images/iconic/ala.png"},
            self._seeded_label_build_event(),
            {"label": "render_canvas"},
            _export_event(L_ALANINE),
        ]}
        transcript = {"id": "I-6E", "candidate_smiles": L_ALANINE,
                      "subagent_summary": "rebuilt.\nSMILES: " + L_ALANINE}
        grade = _run_grader(row, trace, transcript)
        self.assertIn("stereo_false_green_gate", grade)
        self.assertFalse(grade["stereo_false_green_gate"]["pass"])
        self.assertTrue(grade["stereo_false_green_gate"]["advisory"])
        self.assertFalse(grade["stereo_false_green_gate"]["hard_fail"])
        self.assertTrue(grade["deterministic_pass"])
        self.assertEqual(grade["reason"], "deterministic_pass")
        self.assertTrue(
            any("diagnostic_advisory:stereo_false_green" in n
                for n in grade.get("evaluator_notes", [])),
            grade.get("evaluator_notes"),
        )

    def test_genuine_wedge_primitive_row_is_credited_end_to_end(self):
        # The 6E headline credit case, end to end: wedge primitive + image Read
        # + Indigo stereo in export → the gate passes and does NOT block.
        row = self._image_row()
        trace = {"events": [
            {"label": "Read", "path": "tests/scientific/images/iconic/ala.png"},
            self._wedge_primitive_build_event(),
            {"label": "render_canvas"},
            {"label": "export_smiles"},
        ]}
        transcript = {"id": "I-6E", "candidate_smiles": L_ALANINE,
                      "subagent_summary": "rebuilt.\nSMILES: " + L_ALANINE}
        grade = _run_grader(row, trace, transcript)
        self.assertIn("stereo_false_green_gate", grade)
        self.assertTrue(grade["stereo_false_green_gate"]["pass"])
        self.assertFalse(grade["stereo_false_green_gate"]["hard_fail"])
        # The stereo false-green gate does not, by itself, block this row.
        self.assertNotIn(
            "stereo_false_green",
            " ".join(grade.get("evaluator_notes", [])),
        )

    def test_composes_with_escape_hatch_gate_independently(self):
        # Pure stereo_label:'unknown' skip with matching zoom evidence: the
        # escape-hatch gate passes; the false-green gate must NOT fire because
        # an all-`unknown` row makes NO R|S claim (no seeded literal) — but it
        # WILL flag no_wedge_primitive + no_indigo on the export. We assert the
        # two gates are independent: escape-hatch passes, and the false-green
        # gate's seeded-literal axis stays clean (centers == []).
        row = self._image_row(expected="c1ccccc1")  # achiral → gate skipped entirely
        trace = {"events": [
            {"label": "Read", "path": "x.png"},
            {"label": "build_from_graph", "args": {"graph": {
                "stereoTransfer": [{"center": 1, "stereo_label": "unknown"}],
                "unresolved": [{"field": "wedge_orientation", "record_id": "b:5",
                                "note": "n", "state": "source_limited"}],
            }}},
            {"label": "export_smiles"},
        ]}
        # Achiral expected → false-green gate is not applicable (None), proving
        # it does not double-police the escape-hatch's domain.
        self.assertIsNone(stereo_false_green_gate(row, trace, "c1ccccc1"))
        # And the escape-hatch gate still owns the unknown-skip policing.
        seh = stereo_escape_hatch_gate(row, trace)
        assert seh is not None
        self.assertTrue(seh["pass"])


def _run_grader_in_dir(
    tmp_path: Path, row: dict, trace: dict, transcript: dict
) -> dict:
    """Like _run_grader, but writes artifacts into a CALLER-OWNED dir so the
    caller can also drop a sibling `<rowId>.graph.json` dump (the production
    on-disk GraphIntent) next to trace.json before invoking. This drives the
    real production shape end-to-end: label-only build event + on-disk dump
    resolved via `Path(trace_path).parent / f"{row_id}.graph.json"`."""
    trace_path = tmp_path / "trace.json"
    transcript_path = tmp_path / "candidate.json"
    out_path = tmp_path / "grade.json"
    trace_path.write_text(json.dumps(trace))
    transcript_path.write_text(json.dumps(transcript))
    result = subprocess.run(
        [
            sys.executable,
            str(GRADER_PATH),
            "--row",
            json.dumps(row),
            "--trace",
            str(trace_path),
            "--transcript",
            str(transcript_path),
            "--out",
            str(out_path),
        ],
        capture_output=True,
        text=True,
        env={**os.environ},
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"grader exit {result.returncode}\nstderr: {result.stderr}"
        )
    return json.loads(out_path.read_text())


class StereoGateOnDiskResolverTests(unittest.TestCase):
    """Phase 1 — un-blind the two stereo gates via the on-disk GraphIntent
    resolver.

    The production agent-orch trace carries label-only `build_from_graph`
    events with NO inline `args.graph` — the wedge sits in the per-row
    `<rowDir>/<rowId>.graph.json` dump. These tests drive that EXACT shape
    (anti-green-wash: at least one positive test per gate uses the on-disk
    dump, not a hand-built inline `args.graph`) and pin the §2 fundamental
    invariant: a MISSING dump must fail open (no penalty), never become a
    new false-fail.
    """

    @staticmethod
    def _image_row(row_id: str = "A011", expected: str = L_ALANINE) -> dict:
        return {
            "id": row_id,
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": expected,
            "acceptable_canonical_smiles": [expected],
            "required_trace_events": [],
        }

    @staticmethod
    def _label_only_build_event(path_key: str | None = None,
                                path_val: str | None = None) -> dict:
        # The production shape: a build_from_graph event with NO inline
        # args.graph. Optionally carry an args.graph_intent_path pointer.
        ev: dict = {"raw_tool": "build_from_graph",
                    "label": "build_from_graph", "ts_index": 14}
        if path_key and path_val:
            ev["args"] = {path_key: path_val}
        return ev

    @staticmethod
    def _wedge_graph() -> dict:
        # Flat GraphIntent (NOT nested under .graph) carrying a per-bond
        # wedge primitive on the alanine Cα (id 2).
        return {
            "atoms": [
                {"id": 1, "element": "N"},
                {"id": 2, "element": "C", "stereo": "declared"},
                {"id": 3, "element": "C"},
            ],
            "bonds": [
                {"a": 1, "b": 2, "order": 1, "wedge": "solid", "wedge_from": 2},
            ],
        }

    @staticmethod
    def _rowdir(tmp_path: Path, row_id: str) -> Path:
        """Production layout: trace lives at <rowDir>/trace.json where rowDir
        is named after the row id, so the per-row dump fallback resolves
        <rowDir>/<rowId>.graph.json via Path(trace_path).parent.name."""
        d = tmp_path / row_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    # ---- stereo_false_green: on-disk dump via fallback path (the I015-shape
    # recovery: dump exists at <rowDir>/<rowId>.graph.json, event is label-only,
    # NO args.graph_intent_path pointer — pure trace_path.parent resolution). ----
    def test_false_green_reads_wedge_from_ondisk_dump_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            rowdir = self._rowdir(Path(tmp), "A011")
            (rowdir / "A011.graph.json").write_text(json.dumps(self._wedge_graph()))
            trace_path = rowdir / "trace.json"
            trace = {"events": [
                {"raw_tool": "Read", "label": "Read", "ts_index": 0,
                 "path": "tests/scientific/images/iconic/ala.png"},
                self._label_only_build_event(),
                {"raw_tool": "render_canvas", "label": "render_canvas"},
                _export_event("c1ccccc1", raw_tool="export_smiles"),
            ]}
            trace_path.write_text(json.dumps(trace))
            result = stereo_false_green_gate(
                self._image_row("A011"), trace, L_ALANINE, trace_path=str(trace_path)
            )
            assert result is not None
            self.assertTrue(result["saw_wedge_primitive"],
                            f"on-disk wedge not read: {result}")
            self.assertTrue(result["graph_resolved"], result)
            self.assertTrue(result["pass"], result["failures"])

    # ---- stereo_false_green: on-disk dump via args.graph_intent_path pointer. ----
    def test_false_green_reads_wedge_from_graph_intent_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            dump = tmp_path / "A011.graph.json"
            dump.write_text(json.dumps(self._wedge_graph()))
            trace_path = tmp_path / "trace.json"
            trace = {"events": [
                {"raw_tool": "Read", "label": "Read", "ts_index": 0,
                 "path": "tests/scientific/images/iconic/ala.png"},
                self._label_only_build_event("graph_intent_path", str(dump)),
                {"raw_tool": "render_canvas", "label": "render_canvas"},
                _export_event("c1ccccc1", raw_tool="export_smiles"),
            ]}
            trace_path.write_text(json.dumps(trace))
            result = stereo_false_green_gate(
                self._image_row("A011"), trace, L_ALANINE, trace_path=str(trace_path)
            )
            assert result is not None
            self.assertTrue(result["saw_wedge_primitive"], result)
            self.assertTrue(result["pass"], result["failures"])

    # ---- stereo_false_green: nested build-dump shape ({"graph": {...}}) on disk. ----
    def test_false_green_unwraps_nested_build_dump_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            rowdir = self._rowdir(Path(tmp), "A011")
            (rowdir / "A011.graph.json").write_text(
                json.dumps({"graph": self._wedge_graph(), "outcome": "ok"})
            )
            trace_path = rowdir / "trace.json"
            trace = {"events": [
                {"raw_tool": "Read", "label": "Read", "ts_index": 0,
                 "path": "x.png"},
                self._label_only_build_event(),
                {"raw_tool": "export_smiles", "label": "export_smiles"},
            ]}
            trace_path.write_text(json.dumps(trace))
            result = stereo_false_green_gate(
                self._image_row("A011"), trace, L_ALANINE, trace_path=str(trace_path)
            )
            assert result is not None
            self.assertTrue(result["saw_wedge_primitive"], result)
            self.assertTrue(result["pass"], result["failures"])

    # ---- §2 INVARIANT: a MISSING dump fails open (the I015 case). The gate
    # must NOT append no_wedge_primitive_stereo_read when no graph resolves. ----
    def test_false_green_missing_dump_fails_open_no_penalty(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            # NO <rowId>.graph.json on disk, NO inline args, NO path key.
            trace_path = tmp_path / "trace.json"
            trace = {"events": [
                {"raw_tool": "Read", "label": "Read", "ts_index": 0,
                 "path": "tests/scientific/images/iconic/ala.png"},
                self._label_only_build_event(),
                {"raw_tool": "export_smiles", "label": "export_smiles"},
            ]}
            trace_path.write_text(json.dumps(trace))
            result = stereo_false_green_gate(
                self._image_row("I015"), trace, L_ALANINE, trace_path=str(trace_path)
            )
            assert result is not None
            self.assertNotIn("no_wedge_primitive_stereo_read", result["failures"])
            self.assertFalse(result["saw_wedge_primitive"])

    def test_false_green_unreadable_dump_fails_open_no_penalty(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            (tmp_path / "I015.graph.json").write_text("{ this is not json")
            trace_path = tmp_path / "trace.json"
            trace = {"events": [
                {"raw_tool": "Read", "label": "Read", "ts_index": 0, "path": "x.png"},
                self._label_only_build_event(),
                {"raw_tool": "export_smiles", "label": "export_smiles"},
            ]}
            trace_path.write_text(json.dumps(trace))
            result = stereo_false_green_gate(
                self._image_row("I015"), trace, L_ALANINE, trace_path=str(trace_path)
            )
            assert result is not None
            self.assertNotIn("no_wedge_primitive_stereo_read", result["failures"])

    # ---- End-to-end through main(): the production shape credits the row.
    # The trace lives at <rowDir>/trace.json and the dump at
    # <rowDir>/A011.graph.json — the real on-disk fallback resolution. ----
    def test_false_green_ondisk_dump_credits_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            rowdir = self._rowdir(Path(tmp), "A011")
            (rowdir / "A011.graph.json").write_text(json.dumps(self._wedge_graph()))
            trace = {"events": [
                {"raw_tool": "Read", "label": "Read", "ts_index": 0,
                 "path": "tests/scientific/images/iconic/ala.png"},
                self._label_only_build_event(),
                {"raw_tool": "render_canvas", "label": "render_canvas"},
                _export_event("c1ccccc1", raw_tool="export_smiles"),
            ]}
            transcript = {"id": "A011", "candidate_smiles": L_ALANINE,
                          "subagent_summary": "rebuilt.\nSMILES: " + L_ALANINE}
            grade = _run_grader_in_dir(
                rowdir, self._image_row("A011"), trace, transcript)
            self.assertIn("stereo_false_green_gate", grade)
            self.assertTrue(
                grade["stereo_false_green_gate"]["saw_wedge_primitive"],
                grade["stereo_false_green_gate"],
            )
            self.assertTrue(grade["stereo_false_green_gate"]["pass"],
                            grade["stereo_false_green_gate"]["failures"])

    # ---- stereo_escape_hatch polarity: a stereo_label:'unknown' center WITH
    # matching zoom evidence on disk is still honored (escape not newly failed).
    def test_escape_hatch_unknown_on_disk_is_still_honored(self):
        graph = {
            "atoms": [{"id": 1, "element": "C"}, {"id": 2, "element": "C"}],
            "bonds": [],
            "stereoTransfer": [{"center": 1, "stereo_label": "unknown"}],
            "unresolved": [
                {"field": "wedge_orientation", "record_id": "bond:5",
                 "note": "crowded wedge cluster", "state": "source_limited"},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            rowdir = self._rowdir(Path(tmp), "A011")
            (rowdir / "A011.graph.json").write_text(json.dumps(graph))
            trace_path = rowdir / "trace.json"
            trace = {"events": [
                {"raw_tool": "Read", "label": "Read", "ts_index": 0, "path": "x.png"},
                self._label_only_build_event(),
                {"raw_tool": "export_smiles", "label": "export_smiles"},
            ]}
            trace_path.write_text(json.dumps(trace))
            result = stereo_escape_hatch_gate(
                self._image_row("A011", expected="c1ccccc1"), trace,
                trace_path=str(trace_path),
            )
            assert result is not None
            self.assertEqual(result["unknown_centers"], [1])
            self.assertTrue(result["pass"], result["failures"])

    # ---- stereo_escape_hatch polarity tightening: unknown center on disk with
    # NO matching zoom evidence DOES surface a failure (the un-blinding). It
    # stays ADVISORY-first (does not deny deterministic_pass) in this task. ----
    def test_escape_hatch_unknown_on_disk_without_zoom_surfaces_advisory(self):
        graph = {
            "atoms": [{"id": 1, "element": "C"}],
            "bonds": [],
            "stereoTransfer": [{"center": 1, "stereo_label": "unknown"}],
            "unresolved": [],
        }
        with tempfile.TemporaryDirectory() as tmp:
            rowdir = self._rowdir(Path(tmp), "A011")
            (rowdir / "A011.graph.json").write_text(json.dumps(graph))
            trace_path = rowdir / "trace.json"
            trace = {"events": [
                {"raw_tool": "Read", "label": "Read", "ts_index": 0, "path": "x.png"},
                self._label_only_build_event(),
                {"raw_tool": "export_smiles", "label": "export_smiles"},
            ]}
            trace_path.write_text(json.dumps(trace))
            result = stereo_escape_hatch_gate(
                self._image_row("A011", expected="c1ccccc1"), trace,
                trace_path=str(trace_path),
            )
            assert result is not None
            self.assertEqual(result["unknown_centers"], [1])
            self.assertFalse(result["pass"], "un-blinded gate should see the unknown")

    # ---- §2 INVARIANT for escape-hatch: missing dump fails open (still passes). ----
    def test_escape_hatch_missing_dump_fails_open(self):
        with tempfile.TemporaryDirectory() as tmp:
            rowdir = self._rowdir(Path(tmp), "I015")  # rowdir exists, NO dump in it
            trace_path = rowdir / "trace.json"
            trace = {"events": [
                {"raw_tool": "Read", "label": "Read", "ts_index": 0, "path": "x.png"},
                self._label_only_build_event(),
                {"raw_tool": "export_smiles", "label": "export_smiles"},
            ]}
            trace_path.write_text(json.dumps(trace))
            result = stereo_escape_hatch_gate(
                self._image_row("I015", expected="c1ccccc1"), trace,
                trace_path=str(trace_path),
            )
            assert result is not None
            self.assertEqual(result["unknown_centers"], [])
            self.assertTrue(result["pass"])

    # ---- ADVISORY-first wiring: the un-blinded escape-hatch must NOT deny
    # deterministic_pass in this task (polarity-risk gate is gated on a full
    # corpus run we cannot do here). ----
    def test_escape_hatch_advisory_first_does_not_deny_deterministic_pass(self):
        graph = {
            "atoms": [{"id": 1, "element": "C"}],
            "bonds": [],
            "stereoTransfer": [{"center": 1, "stereo_label": "unknown"}],
            "unresolved": [],
        }
        with tempfile.TemporaryDirectory() as tmp:
            rowdir = self._rowdir(Path(tmp), "I-ESC-ADV")
            (rowdir / "I-ESC-ADV.graph.json").write_text(json.dumps(graph))
            # Achiral expected so stereo_false_green does not also fire; the
            # escape-hatch un-blinding is the only thing that could deny pass.
            row = self._image_row("I-ESC-ADV", expected="c1ccccc1")
            row["required_trace_events"] = [
                "load_or_construct_in_ketcher", "render_canvas", "export_smiles"]
            trace = {"events": [
                {"raw_tool": "Read", "label": "Read", "ts_index": 0, "path": "x.png"},
                {"raw_tool": "build_from_graph",
                 "label": "load_or_construct_in_ketcher", "ts_index": 14},
                self._label_only_build_event(),
                {"raw_tool": "render_canvas", "label": "render_canvas"},
                _export_event("c1ccccc1", raw_tool="export_smiles"),
            ]}
            transcript = {"id": "I-ESC-ADV", "candidate_smiles": "c1ccccc1",
                          "subagent_summary": "rebuilt.\nSMILES: c1ccccc1"}
            grade = _run_grader_in_dir(rowdir, row, trace, transcript)
            # The gate surfaces the unknown (un-blinded)...
            self.assertFalse(grade["stereo_escape_hatch_gate"]["pass"])
            # ...but ADVISORY-first: it does NOT deny the deterministic pass.
            self.assertTrue(grade["stereo_escape_hatch_gate"]["advisory"])
            self.assertFalse(grade["stereo_escape_hatch_gate"]["hard_fail"])
            self.assertTrue(
                grade["deterministic_pass"],
                f"escape-hatch must stay advisory-first: {grade.get('reason')}",
            )


class NoArgsSyntheticTraceCrossGateTests(unittest.TestCase):
    """Phase 1B Step 1 — the cross-gate regression guard (also guards Phases
    1-4). Asserts that NO `deterministic_pass`-feeding gate hard-fails a real
    no-args synthesized trace — the shape the orchestrator actually emits.

    Two fixtures are REQUIRED:
      (a) a simple single-early-`Read` row, and
      (b) a multi-crop (≥4) dense-shape row modeled on A004H's real trace
          (crop_count=11, single `Read` at idx0). Without (b) the test
          green-washes past `image_freshness_gate` / `crop_rationale_gate`
          via their `<4`-crop early-exit.

    The §2 fundamental invariant: a hard-fail gate may fire only on positive
    evidence of a violation, never on a surface the synthesized trace cannot
    carry (a Claude-Code `Read` the runner can't see; per-crop
    `CROP_RATIONALE:` prose the one-line summary lacks).
    """

    @staticmethod
    def _simple_trace() -> dict:
        # One early Read, a single build, render, export — the easy fast path.
        return {"events": [
            {"raw_tool": "Read", "label": "Read", "ts_index": 0,
             "path": "tests/scientific/images/iconic/benzene.png"},
            {"raw_tool": "validate_graph", "label": "validate_graph", "ts_index": 1},
            {"raw_tool": "build_from_graph", "label": "build_from_graph", "ts_index": 2},
            {"raw_tool": "build_from_graph",
             "label": "load_or_construct_in_ketcher", "ts_index": 2},
            {"raw_tool": "render_canvas", "label": "render_canvas", "ts_index": 3},
            _export_event("c1ccccc1", raw_tool="export_smiles", ts_index=4),
        ]}

    @staticmethod
    def _dense_trace() -> dict:
        # A004H's real production shape: single Read at idx0,
        # vision_identify_structure at idx0, 11 crop_source_image, a
        # validate_graph, then the build (+ label aliases), render — PLUS an
        # export_smiles so the row is otherwise passable and the two blind
        # ≥4-crop gates are the ONLY thing that could deny pass. NO fresh
        # full-image Read within 2 turns of the build (the runner can't
        # synthesize one) → image_freshness fires pre-1B; the one-line
        # summary carries NO per-crop CROP_RATIONALE → crop_rationale fires
        # pre-1B.
        events = [
            {"raw_tool": "Read", "label": "Read", "ts_index": 0,
             "path": "tests/scientific/images/academic-hires/A004H_hires.png"},
            {"raw_tool": "Read", "label": "vision_identify_structure",
             "ts_index": 0,
             "path": "tests/scientific/images/academic-hires/A004H_hires.png"},
            {"raw_tool": "validate_graph", "label": "validate_graph", "ts_index": 1},
        ]
        for i in range(11):  # 11 crops — well over the ≥4 trigger.
            events.append({"raw_tool": "crop_source_image",
                           "label": "crop_source_image", "ts_index": 2 + i})
        events.extend([
            {"raw_tool": "validate_graph", "label": "validate_graph", "ts_index": 13},
            {"raw_tool": "build_from_graph", "label": "build_from_graph", "ts_index": 14},
            {"raw_tool": "build_from_graph", "label": "buildFromGraph", "ts_index": 14},
            {"raw_tool": "build_from_graph",
             "label": "load_or_construct_in_ketcher", "ts_index": 14},
            {"raw_tool": "render_canvas", "label": "render_canvas", "ts_index": 15},
            _export_event("c1ccccc1", raw_tool="export_smiles", ts_index=16),
        ])
        return {"events": events}

    def _row(self, row_id: str) -> dict:
        # Achiral expected so the stereo gates are N/A — the only thing that
        # could deny pass is the gate under test.
        return {
            "id": row_id,
            "grading": "image_roundtrip_evaluator",
            "skill": "ketcher-image-rebuild",
            "expected_canonical_smiles": "c1ccccc1",
            "acceptable_canonical_smiles": ["c1ccccc1"],
            "required_trace_events": [
                "load_or_construct_in_ketcher", "render_canvas", "export_smiles"],
        }

    def test_no_deterministic_gate_hard_fails_synthetic_trace(self):
        # The one-line summary the orchestrator synthesizes — no per-crop
        # CROP_RATIONALE prose, just a terminal SMILES line.
        summary = ("Rebuilt the structure from pixels via the MCP "
                   "placeholder/zoom loop.\nSMILES: c1ccccc1")
        for name, trace in (
            ("simple_single_read", self._simple_trace()),
            ("dense_11_crops", self._dense_trace()),
        ):
            with self.subTest(fixture=name):
                row = self._row(f"I-XG-{name}")
                transcript = {"id": row["id"], "candidate_smiles": "c1ccccc1",
                              "subagent_summary": summary}
                grade = _run_grader(row, trace, transcript)
                # The two blind ≥4-crop gates must NOT deny the deterministic
                # pass on the no-args synthesized trace.
                self.assertTrue(
                    grade["image_freshness_gate"]["advisory"],
                    f"[{name}] image_freshness must be advisory: "
                    f"{grade['image_freshness_gate']}",
                )
                self.assertFalse(grade["image_freshness_gate"]["hard_fail"],
                                 f"[{name}] {grade['image_freshness_gate']}")
                self.assertTrue(
                    grade["crop_rationale_gate"]["advisory"],
                    f"[{name}] crop_rationale must be advisory: "
                    f"{grade['crop_rationale_gate']}",
                )
                self.assertFalse(grade["crop_rationale_gate"]["hard_fail"],
                                 f"[{name}] {grade['crop_rationale_gate']}")
                # No lock_failure headline from either softened gate.
                self.assertNotIn("image_freshness", grade["reason"])
                self.assertNotIn("crop_rationale", grade["reason"])
                # And the row passes the deterministic floor end to end.
                self.assertTrue(
                    grade["deterministic_pass"],
                    f"[{name}] deterministic_pass denied: reason={grade['reason']}",
                )

    def test_dense_fixture_actually_triggers_the_4crop_branch(self):
        # Guard the guard: prove the dense fixture is in the ≥4-crop regime so
        # the test is not green-washing past the gates' <4-crop early-exit.
        trace = self._dense_trace()
        crop_count = sum(1 for e in trace["events"]
                         if e.get("label") == "crop_source_image")
        self.assertGreaterEqual(crop_count, 4)
        self.assertEqual(crop_count, 11)


if __name__ == "__main__":
    unittest.main()
