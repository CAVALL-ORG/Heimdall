#!/usr/bin/env python3
"""Synthesize agent-orch row artifacts from runner output.

Inputs:
  --row              JSON-encoded manifest row (or --row-file).
  --final-text-file  File containing the runner subagent's final text.
  --row-output-dir   Per-row output directory.

Outputs in --row-output-dir:
  candidate.json     {id, candidate_smiles, subagent_summary}
  trace.json         evaluator/grader trace shape.

This helper replaces ad hoc Wave-style shell snippets. It preserves TRACE
payloads, reads the image path only from the manifest row, and imports real
row-scoped MCP sidecar evidence when present. It does not invent pass evidence:
a label-only TRACE export remains label-only unless `_session_trace.json`
contains the exported SMILES.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


TOOL_TO_LABEL: dict[str, list[str]] = {
    "load_smiles": [
        "load_smiles",
        "setMolecule",
        "load_or_construct_in_ketcher",
        "set_recognized_structure",
    ],
    "load_molfile": ["load_molfile", "setMolecule", "load_or_construct_in_ketcher"],
    "add_fragment": ["add_fragment", "addFragment", "load_or_construct_in_ketcher"],
    "build_from_graph": ["build_from_graph", "buildFromGraph", "load_or_construct_in_ketcher"],
    "render_canvas": ["render_canvas"],
    "export_smiles": [
        "export_smiles",
        "getSmiles",
        "getSmiles_isomeric",
        "export_from_ketcher",
        "getSmiles_or_product_export",
    ],
    "validate_graph": ["validate_graph"],
    "crop_source_image": ["crop_source_image"],
    "refuse": ["refuse"],
}

TRACE_RE = re.compile(r"^\s*TRACE:\s*([A-Za-z_]\w*)(?:\s+(.*?))?\s*$")


def _load_row(args: argparse.Namespace) -> dict[str, Any]:
    if args.row_file:
        return json.loads(Path(args.row_file).read_text(encoding="utf8"))
    return json.loads(args.row)


def _extract_smiles(final_text: str) -> str | None:
    match = re.search(
        r"^\s*\**\s*SMILES\s*:?\**\s*[`*]?\s*([^\s`*]+)\s*[`*]?\s*$",
        final_text,
        re.MULTILINE | re.IGNORECASE,
    )
    if match:
        return match.group(1).strip("`*.,;")
    return None


def _event_result_from_session(session_event: dict[str, Any]) -> dict[str, Any] | None:
    result = session_event.get("result")
    if not isinstance(result, dict):
        return None
    tool = session_event.get("tool")
    if tool == "export_smiles" and isinstance(result.get("smiles"), str):
        return {
            "ok": result.get("ok", True),
            "data": {
                "smiles": result["smiles"],
                "canonical": bool(result.get("canonical", False)),
            },
        }
    if tool == "render_canvas" and isinstance(result.get("path"), str):
        return {
            "ok": result.get("ok", True),
            "data": {
                "path": result["path"],
                "format": result.get("format"),
                "showAtomIds": result.get("showAtomIds"),
                "bytes": result.get("bytes"),
            },
        }
    return {"ok": result.get("ok", True), "data": result}


def _graph_intent_path(row: dict[str, Any], row_dir: Path) -> str | None:
    row_id = row.get("id")
    if not isinstance(row_id, str) or not row_id:
        return None
    path = row_dir / f"{row_id}.graph.json"
    return str(path) if path.exists() else None


def _append_tool_event(
    events: list[dict[str, Any]],
    *,
    tool: str,
    ts_index: int,
    payload: str | None = None,
    args: dict[str, Any] | None = None,
    result: dict[str, Any] | None = None,
) -> None:
    labels = TOOL_TO_LABEL.get(tool, [tool])
    for label in labels:
        event: dict[str, Any] = {
            "raw_tool": tool,
            "label": label,
            "ts_index": ts_index,
        }
        if payload:
            event["payload"] = payload
            if tool == "render_canvas" and Path(payload).is_absolute():
                event["path"] = payload
        if args:
            event["args"] = args
        if result is not None:
            event["result"] = result
        events.append(event)


def synthesize(row: dict[str, Any], final_text: str, row_dir: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    row_dir.mkdir(parents=True, exist_ok=True)
    row_id = row.get("id")
    candidate = {
        "id": row_id,
        "candidate_smiles": _extract_smiles(final_text),
        "subagent_summary": final_text,
    }

    events: list[dict[str, Any]] = []
    ts = 0
    image_path = row.get("image_path")
    if isinstance(image_path, str) and image_path:
        events.append({"raw_tool": "Read", "label": "Read", "ts_index": ts, "path": image_path})
        events.append({
            "raw_tool": "Read",
            "label": "vision_identify_structure",
            "ts_index": ts,
            "path": image_path,
        })
        ts += 1

    graph_path = _graph_intent_path(row, row_dir)
    for line in final_text.splitlines():
        match = TRACE_RE.match(line)
        if not match:
            continue
        tool = match.group(1)
        payload = match.group(2).strip() if match.group(2) else None
        args: dict[str, Any] | None = None
        if tool == "build_from_graph" and graph_path:
            args = {"graph_intent_path": graph_path}
        _append_tool_event(events, tool=tool, ts_index=ts, payload=payload, args=args)
        ts += 1

    session_path = row_dir / "_session_trace.json"
    try:
        session_events = json.loads(session_path.read_text(encoding="utf8"))
    except Exception:
        session_events = []
    if not isinstance(session_events, list):
        session_events = []

    for session_event in session_events:
        if not isinstance(session_event, dict):
            continue
        tool = session_event.get("tool")
        if not isinstance(tool, str):
            continue
        args = session_event.get("args") if isinstance(session_event.get("args"), dict) else {}
        if tool == "build_from_graph" and graph_path and "graph_intent_path" not in args:
            args = {**args, "graph_intent_path": graph_path}
        _append_tool_event(
            events,
            tool=tool,
            ts_index=ts,
            args=args or None,
            result=_event_result_from_session(session_event),
        )
        ts += 1

    trace = {
        "events": events,
        "final_assistant_text": final_text,
        "final_assistant_text_blocks": [final_text] if final_text.strip() else [],
        "assistant_message_blocks": [final_text] if final_text.strip() else [],
        "num_assistant_messages": 1 if final_text.strip() else 0,
    }
    return candidate, trace


def main() -> None:
    parser = argparse.ArgumentParser()
    row_group = parser.add_mutually_exclusive_group(required=True)
    row_group.add_argument("--row")
    row_group.add_argument("--row-file")
    parser.add_argument("--final-text-file", required=True)
    parser.add_argument("--row-output-dir", required=True)
    args = parser.parse_args()

    row = _load_row(args)
    final_text = Path(args.final_text_file).read_text(encoding="utf8")
    row_dir = Path(args.row_output_dir)
    candidate, trace = synthesize(row, final_text, row_dir)
    (row_dir / "candidate.json").write_text(json.dumps(candidate, indent=2) + "\n")
    (row_dir / "trace.json").write_text(json.dumps(trace, indent=2) + "\n")


if __name__ == "__main__":
    main()
