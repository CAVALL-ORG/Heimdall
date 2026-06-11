/**
 * Task A2 — refusal-classifier branch reorder + markush regex narrowing.
 *
 * Verifies the precedence ladder ordering and regex tightening:
 *
 *   1. `unknown_shorthand` now sits ABOVE `markush_or_rgroup`, so
 *      specific protocol-diagnostic terms (shorthand, unknown glyph,
 *      abbreviation, bare element) win over generic-pattern markush
 *      matching.
 *
 *   2. The markush regex no longer includes bare `/\bR\d\b/`. Natural
 *      R-digit tokens ("R3 ring") do not classify as markush on their
 *      own. Genuine markush context — explicit "Markush" / "R-group" /
 *      paired R-digit listings ("R1, R2" / "R1/R2") / "X = Element" —
 *      still does.
 *
 *   3. `unknown_shorthand` evidenceMatch extended with
 *      `/\bbare[-\s]?element\b/i` so future bare-element wording
 *      classifies correctly.
 *
 * Closes bug 2 of Track A. Original misclassification evidence came
 * from an agent-orch run trace
 * (outputs/tests/agent-orch/<run-id>/A004/_session_trace.json:24-25).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyRefusal,
  type ClassifierInput,
  type ClassifierVerdict,
} from '../../src/adapter/refusal-classifier';

describe('refusal-classifier precedence (A2)', () => {
  const cleanups: string[] = [];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'refuse-prec-'));
    cleanups.push(dir);
  });

  afterEach(() => {
    for (const d of cleanups) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    cleanups.length = 0;
  });

  function makeInput(pixel_evidence: string): ClassifierInput {
    return { outputDir: dir, pixel_evidence };
  }

  it('shorthand wins over R-digit token (reorder)', () => {
    // Evidence contains BOTH "unknown shorthand" and "R3 ring". Under the
    // old ladder, markush_or_rgroup's bare /\bR\d\b/ matched first and
    // misclassified this row. After the reorder + narrowing, the
    // shorthand block runs first and classifies correctly.
    const verdict = classifyRefusal(
      makeInput(
        'unknown shorthand glyph attached to the R3 ring carbon could not be decoded',
      ),
    );
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted) {
      expect(verdict.classification).toBe('unknown_shorthand');
      expect(verdict.classification).not.toBe('markush_or_rgroup');
    }
  });

  it('genuine Markush context with R-digit still classifies as markush', () => {
    // "Markush variant" + "R3 ring" — the explicit Markush term anchors
    // the markush block, so even though shorthand runs first, this
    // evidence does not match the shorthand patterns.
    const verdict = classifyRefusal(
      makeInput('Markush variant scaffold with substituent on R3 ring drawn'),
    );
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted) {
      expect(verdict.classification).toBe('markush_or_rgroup');
    }
  });

  it('paired R-digit listing classifies as markush', () => {
    // "R1, R2, R3" — the new paired-R regex
    // /R\d[^A-Za-z]*[\s,;/].*R\d/i matches genuine markush listings.
    const verdict = classifyRefusal(
      makeInput('substituent positions labeled R1, R2, R3 across the scaffold'),
    );
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted) {
      expect(verdict.classification).toBe('markush_or_rgroup');
    }
  });

  it('bare R-digit alone no longer trips markush', () => {
    // "R3 ring" alone with no markush / shorthand context. Under the old
    // bare /\bR\d\b/ this would match markush_or_rgroup. After narrowing
    // the regex set, no branch claims it and the classifier returns
    // refusal_lacks_evidence at the bottom of the ladder.
    const verdict = classifyRefusal(
      makeInput('R3 ring carbon location appears ambiguous in the source image'),
    );
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) {
      expect(verdict.reason).toBe('refusal_lacks_evidence');
    }
  });

  it('X = Element wording still classifies as markush (tightened)', () => {
    // The new /\bX\s*=\s*[A-Z]/i requires an element-symbol RHS. "X = Br"
    // qualifies; bare "X =" would no longer.
    const verdict = classifyRefusal(
      makeInput('Markush note in caption reads X = Br across all variants'),
    );
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted) {
      expect(verdict.classification).toBe('markush_or_rgroup');
    }
  });

  it('"unknown abbreviation" classifies as shorthand', () => {
    const verdict = classifyRefusal(
      makeInput('unknown abbreviation attached to the meta carbon could not be decoded'),
    );
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted) {
      expect(verdict.classification).toBe('unknown_shorthand');
    }
  });

  it('"bare element" wording classifies as shorthand (new regex)', () => {
    // The new /\bbare[-\s]?element\b/i extension covers prose like
    // "bare element O" / "bare-element fallback" — the wording the
    // agent emits when the shorthand decoder rejects a single-letter
    // glyph as ambiguous.
    const verdict = classifyRefusal(
      makeInput('bare element O at this position cannot be safely decoded'),
    );
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted) {
      expect(verdict.classification).toBe('unknown_shorthand');
    }
  });

  it('"X = halide" does NOT classify as markush (i-flag bug fix verification)', () => {
    // Regression: the X-equals regex previously had the `i` flag which made
    // [A-Z] case-fold and accept lowercase words like "halide" or "something".
    // The spec said "tighten X-equals to require an element-symbol RHS" but
    // the i-flag silently subverted that. Fix: drop the i flag (or constrain
    // to element-symbol shape) so only an actual element-symbol-shaped RHS
    // classifies as markush.
    const evidence = 'caption note reads X = halide across all variants';
    const result = classifyRefusal(makeInput(evidence));
    expect(result.accepted).toBe(false);
    expect((result as Extract<ClassifierVerdict, { accepted: false }>).reason).toBe(
      'refusal_lacks_evidence',
    );
  });
});
