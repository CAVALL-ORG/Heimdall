/**
 * T2 — Deterministic refusal classifier.
 *
 * Reads the row's sidecar state (`_unresolved_targets.json`,
 * `_session_trace.json`, `_tile_budget.txt`) and the agent-supplied
 * `pixel_evidence` string, then picks one of the 12 enumerated reason
 * classes via a fixed precedence ladder.
 *
 * Two rejection modes that DO NOT classify:
 *
 *   - `refusal_after_export` — the row already emitted a successful
 *     `export_smiles`; refusal is not a valid terminal.
 *   - `refusal_evidence_unanchored` — `pixel_evidence` cites no
 *     `record_id` / `n<int>` / `s<int>` / `(x, y)` that appears in the
 *     row state. Closes the fabricated-evidence loophole.
 *
 * The 12 reason classes (locked):
 *   non_structure, source_resolution_too_low, backend_unavailable,
 *   unreadable_topology, mirror_suspect, budget_exhausted,
 *   reaction_input, markush_or_rgroup, polymer_or_oligomer,
 *   organometallic_or_coordinate, multi_molecule_panel,
 *   unknown_shorthand.
 *
 * No agent-author signal flows in; classifier is pure trace state +
 * regex over the evidence string. Cite the row state for the reasoning.
 */

import {
  readSessionTrace,
  readUnresolvedTargets,
  type SessionEvent,
  type UnresolvedTarget,
} from '../mcp/tools/row-state';

export type RefusalReason =
  | 'non_structure'
  | 'unreadable_topology'
  | 'multi_molecule_panel'
  | 'budget_exhausted'
  | 'unknown_shorthand'
  | 'mirror_suspect'
  | 'reaction_input'
  | 'markush_or_rgroup'
  | 'polymer_or_oligomer'
  | 'organometallic_or_coordinate'
  | 'source_resolution_too_low'
  | 'session_capped'
  | 'backend_unavailable';

export type ClassifierVerdict =
  | { accepted: true; classification: RefusalReason; rationale: string }
  | {
      accepted: false;
      reason:
        | 'refusal_after_export'
        | 'refusal_evidence_unanchored'
        | 'refusal_lacks_evidence';
      suggestion: string;
    };

const MIN_EVIDENCE_CHARS = 20;
const BUDGET_SOFT_THRESHOLD = 12; // pending-unresolved soft trip

// ── Evidence anchoring ───────────────────────────────────────────────

function collectAnchorTokens(targets: UnresolvedTarget[]): {
  ids: Set<string>;
  coords: Array<[number, number]>;
} {
  const ids = new Set<string>();
  const coords: Array<[number, number]> = [];
  for (const t of targets) {
    ids.add(t.record_id);
    // visual-id sub-tokens for worksheet records
    const tail = t.record_id.split(':').slice(1).join(':');
    if (tail) ids.add(tail);
    if (Number.isFinite(t.x_center) && Number.isFinite(t.y_center)) {
      coords.push([t.x_center, t.y_center]);
    }
  }
  return { ids, coords };
}

function evidenceAnchored(
  evidence: string,
  anchors: { ids: Set<string>; coords: Array<[number, number]> },
): boolean {
  for (const id of anchors.ids) {
    if (evidence.includes(id)) return true;
  }
  // Visual-id pattern from agent text: n12 / s7 / l3 / so2
  const tokenRe = /\b(?:n|s|l|so)\d+\b/g;
  for (const match of evidence.matchAll(tokenRe)) {
    const tail = match[0];
    if (anchors.ids.has(tail)) return true;
  }
  // Coord pair pattern: (x, y) within ±10 of any anchor
  const coordRe = /\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)/g;
  for (const match of evidence.matchAll(coordRe)) {
    const ex = Number.parseFloat(match[1]);
    const ey = Number.parseFloat(match[2]);
    for (const [ax, ay] of anchors.coords) {
      if (Math.hypot(ax - ex, ay - ey) <= 25) return true;
    }
  }
  return false;
}

// ── Precedence rules ─────────────────────────────────────────────────

function lastSuccessfulExport(events: SessionEvent[]): boolean {
  for (const e of events) {
    if (e.tool === 'export_smiles' && e.result?.ok === true) return true;
  }
  return false;
}

function sessionCapped(events: SessionEvent[]): boolean {
  // Inspect the most recent trace event for the watchdog's terminated
  // signal. evaluateWatchdog records this event right before returning
  // the session_terminated error.
  if (events.length === 0) return false;
  const last = events[events.length - 1];
  return last.result?.error_code === 'session_terminated';
}

function recentlyBackendErrored(events: SessionEvent[]): boolean {
  const last = events.slice(-3);
  if (last.length < 3) return false;
  return last.every(
    (e) =>
      e.result?.ok === false &&
      (e.result.error_code === 'backend_internal_error' ||
        e.result.error_code === 'tool_unavailable' ||
        e.result.error_code === 'fatal_backend'),
  );
}

function recentSourceTooSmall(events: SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.tool === 'crop_source_image') {
      return e.result?.error_code === 'source_too_small';
    }
  }
  return false;
}

function sameUnresolvedTwice(events: SessionEvent[]): boolean {
  // Strict (record_id, field) overlap between the two most recent
  // validate_graph rounds. Escalates to `unreadable_topology` only when
  // at least one specific target was unresolved in the previous round
  // AND is still unresolved in the latest round.
  //
  // Replaces the old `unresolved_count > 0 && prev_unresolved_count > 0`
  // proxy, which false-positived on any productive session that hadn't
  // yet reached zero (e.g. 10 → 5 → 2). Real progress on disjoint
  // targets no longer trips the escalation.
  //
  // Back-compat: if either round's event lacks the `unresolved_records`
  // list (legacy trace event), return false. Conservative — better to
  // miss a stuck case than false-positive a productive one.
  const validateRounds = events.filter((e) => e.tool === 'validate_graph');
  if (validateRounds.length < 2) return false;
  const last = validateRounds[validateRounds.length - 1];
  const prev = validateRounds[validateRounds.length - 2];
  const lastRecords = last.result?.unresolved_records;
  const prevRecords = prev.result?.unresolved_records;
  if (!Array.isArray(lastRecords) || !Array.isArray(prevRecords)) {
    return false;
  }
  if (lastRecords.length === 0 || prevRecords.length === 0) return false;
  const prevKeys = new Set(prevRecords.map((r) => `${r.record_id}|${r.field}`));
  for (const r of lastRecords) {
    if (prevKeys.has(`${r.record_id}|${r.field}`)) return true;
  }
  return false;
}

function topologyLooksReactionLike(targets: UnresolvedTarget[]): boolean {
  return targets.some(
    (t) => t.field === 'segment_endpoint' && t.record_id.includes('arrow'),
  );
}

function evidenceMatch(evidence: string, patterns: RegExp[]): boolean {
  for (const re of patterns) if (re.test(evidence)) return true;
  return false;
}

// ── Public entry point ──────────────────────────────────────────────

export type ClassifierInput = {
  outputDir: string;
  pixel_evidence: string;
};

export function classifyRefusal(input: ClassifierInput): ClassifierVerdict {
  const evidence = input.pixel_evidence ?? '';

  if (evidence.trim().length < MIN_EVIDENCE_CHARS) {
    return {
      accepted: false,
      reason: 'refusal_lacks_evidence',
      suggestion:
        'pixel_evidence is too short. Describe the visible region or ' +
        'record_id you cannot resolve in at least a sentence.',
    };
  }

  const trace = readSessionTrace(input.outputDir);
  const sidecar = readUnresolvedTargets(input.outputDir);
  const targets = sidecar?.targets ?? [];

  if (lastSuccessfulExport(trace)) {
    return {
      accepted: false,
      reason: 'refusal_after_export',
      suggestion:
        'The current session already exported a SMILES. Refusal is not a ' +
        'valid terminal for a successful row.',
    };
  }

  // Watchdog-terminated sessions short-circuit BEFORE evidence-anchoring.
  // When the runtime killed the session early, the agent may have no
  // unresolved-target ids to cite; the trace event is sufficient signal.
  if (sessionCapped(trace)) {
    return {
      accepted: true,
      classification: 'session_capped',
      rationale:
        'watchdog terminated the session before a clean terminal was reachable',
    };
  }

  const anchors = collectAnchorTokens(targets);
  // Only enforce the anchoring check when the row actually has targets. A
  // pre-validate refusal (e.g. obvious non_structure on first read) is
  // allowed since there are no row-state ids to cite yet.
  if (targets.length > 0 && !evidenceAnchored(evidence, anchors)) {
    return {
      accepted: false,
      reason: 'refusal_evidence_unanchored',
      suggestion:
        'pixel_evidence references no record_id, n<int>/s<int>/l<int>/so<int>, ' +
        'or (x, y) that appears in the current row state. Cite a specific ' +
        'unresolved target named by the most recent validate_graph round.',
    };
  }

  // ── Precedence ladder ──────────────────────────────────────────────

  if (
    evidenceMatch(evidence, [
      /\b(not|isn'?t)\s+a?\s*chem/i,
      /\bphoto\b|\bphotograph\b/i,
      /\bspectrum\b|\bspectra\b/i,
      /\bblank\b|\bempty\b/i,
      /\bformula\s+text\b/i,
    ]) ||
    topologyLooksReactionLike(targets)
  ) {
    return {
      accepted: true,
      classification: 'non_structure',
      rationale: 'evidence describes a non-structure image',
    };
  }

  if (recentSourceTooSmall(trace)) {
    return {
      accepted: true,
      classification: 'source_resolution_too_low',
      rationale:
        'most recent crop_source_image returned source_too_small for this row',
    };
  }

  if (recentlyBackendErrored(trace)) {
    return {
      accepted: true,
      classification: 'backend_unavailable',
      rationale: 'last three events errored at the backend',
    };
  }

  if (sameUnresolvedTwice(trace)) {
    return {
      accepted: true,
      classification: 'unreadable_topology',
      rationale:
        'two or more validate_graph rounds left unresolved targets pending',
    };
  }

  if (
    /chirality_mirror_warning/i.test(evidence) &&
    !/\b(solid|hashed|wedge|toward|away|up|down|in|out)\b/i.test(evidence)
  ) {
    return {
      accepted: true,
      classification: 'mirror_suspect',
      rationale:
        'mirror diagnostic raised; wedge orientation not described in evidence',
    };
  }

  const turnCount = trace.length;
  if (turnCount >= BUDGET_SOFT_THRESHOLD && targets.length > 0) {
    return {
      accepted: true,
      classification: 'budget_exhausted',
      rationale: 'session has run many turns with unresolved targets pending',
    };
  }

  if (
    evidenceMatch(evidence, [/\barrow\b/i, /\b(reactant|product|reagent)\b/i])
  ) {
    return {
      accepted: true,
      classification: 'reaction_input',
      rationale: 'evidence mentions reaction arrow / reactant / product',
    };
  }

  if (
    evidenceMatch(evidence, [
      /\bshorthand\b/i,
      /\bunknown\s+glyph\b/i,
      /\babbreviation\b/i,
      /\bbare[-\s]?element\b/i,
    ])
  ) {
    return {
      accepted: true,
      classification: 'unknown_shorthand',
      rationale: 'evidence mentions unknown shorthand / abbreviation',
    };
  }

  if (
    evidenceMatch(evidence, [
      /\bMarkush\b/i,
      /\bR[- ]?group\b/i,
      /R\d[^A-Za-z]*[\s,;/].*R\d/i,
      /\b[Xx]\s*=\s*[A-Z][a-z]?\b/,
    ])
  ) {
    return {
      accepted: true,
      classification: 'markush_or_rgroup',
      rationale: 'evidence mentions Markush / R-group',
    };
  }

  if (
    evidenceMatch(evidence, [/\bpolymer\b/i, /\boligomer\b/i, /\bbrackets\b/i])
  ) {
    return {
      accepted: true,
      classification: 'polymer_or_oligomer',
      rationale: 'evidence mentions polymer / oligomer brackets',
    };
  }

  if (
    evidenceMatch(evidence, [
      /\borganometallic\b/i,
      /\bcoordin(ation|ate)\b/i,
      /\bmetal\s+center\b/i,
    ])
  ) {
    return {
      accepted: true,
      classification: 'organometallic_or_coordinate',
      rationale: 'evidence mentions organometallic / coordination complex',
    };
  }

  if (
    evidenceMatch(evidence, [
      /\bmulti-?molecule\b/i,
      /\bmultiple\s+molecules\b/i,
      /\bpanel\b/i,
    ])
  ) {
    return {
      accepted: true,
      classification: 'multi_molecule_panel',
      rationale: 'evidence mentions multi-molecule panel',
    };
  }

  return {
    accepted: false,
    reason: 'refusal_lacks_evidence',
    suggestion:
      'pixel_evidence does not match any classifier rule. Either re-attempt ' +
      'the transcription loop (validate_graph → crop named regions → build) ' +
      'or rewrite the evidence to describe a concrete visible feature.',
  };
}
