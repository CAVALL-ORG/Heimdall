import { describe, it, expect } from 'vitest';
import { summarizeStereoLossDiagnostics, type ModeCRecord } from '../../src/adapter/graph-intent/translator';

/**
 * Phase 5 Task H — P5 stereo-loss diagnostic.
 *
 * When V2000/Indigo CIP rejects stereo for a per-center re-apply (or the
 * solver fails on a center), the translator builds modeCRecords. This pure
 * helper distills those records into per-center diagnostics so the build
 * surface can name WHICH centers lost stereo.
 *
 * Acceptance:
 *  - One rejected center → one diagnostic naming that center.
 *  - No rejections (all reapplied or both labels agree) → no diagnostic.
 *  - Multiple rejected centers → one diagnostic per center.
 */
describe('summarizeStereoLossDiagnostics (Task H, P5)', () => {
  it('emits one diagnostic per rejected center (solver_failed)', () => {
    const records: ModeCRecord[] = [
      {
        intentCenter: 5,
        canvasCenter: 12,
        intendedRS: 'R',
        perceivedRS: 'S',
        reapplied: false,
        skipReason: 'solver_failed: V2000 rejected target',
      },
    ];
    const diagnostics = summarizeStereoLossDiagnostics(records);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].centerAtomId).toBe(5);
    expect(diagnostics[0].reason).toContain('solver_failed');
  });

  it('emits no diagnostic on a clean build (every center reapplied or aligned)', () => {
    const records: ModeCRecord[] = [
      {
        intentCenter: 1,
        canvasCenter: 3,
        intendedRS: 'R',
        perceivedRS: 'R',
        reapplied: false,
        skipReason: null,
      },
      {
        intentCenter: 2,
        canvasCenter: 4,
        intendedRS: 'S',
        perceivedRS: 'R',
        reapplied: true,
        skipReason: null,
      },
    ];
    const diagnostics = summarizeStereoLossDiagnostics(records);
    expect(diagnostics).toHaveLength(0);
  });

  it('emits multiple diagnostics, one per rejected center', () => {
    const records: ModeCRecord[] = [
      {
        intentCenter: 1,
        canvasCenter: 3,
        intendedRS: 'R',
        perceivedRS: 'R',
        reapplied: false,
        skipReason: null,
      },
      {
        intentCenter: 7,
        canvasCenter: 14,
        intendedRS: 'R',
        perceivedRS: 'S',
        reapplied: false,
        skipReason: 'solver_failed: skeleton mismatch',
      },
      {
        intentCenter: 9,
        canvasCenter: 18,
        intendedRS: 'S',
        perceivedRS: 'R',
        reapplied: false,
        skipReason: 'solver_failed: Indigo unreachable mid-solve',
      },
    ];
    const diagnostics = summarizeStereoLossDiagnostics(records);
    expect(diagnostics).toHaveLength(2);
    const centers = diagnostics.map((d) => d.centerAtomId).sort((a, b) => a - b);
    expect(centers).toEqual([7, 9]);
  });

  it('treats intended-label-missing (skipReason set, not reapplied, no solver_failed) as a loss diagnostic too', () => {
    // E.g. CIP perception tied on first-shell — intended.label is null;
    // skipReason captures the reason. This is the "stereo silently
    // discarded because we could not derive intended R/S" path.
    const records: ModeCRecord[] = [
      {
        intentCenter: 4,
        canvasCenter: 8,
        intendedRS: null,
        perceivedRS: 'R',
        reapplied: false,
        skipReason: 'tie_first_shell',
      },
    ];
    const diagnostics = summarizeStereoLossDiagnostics(records);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].centerAtomId).toBe(4);
    expect(diagnostics[0].reason).toBe('tie_first_shell');
  });

  it('ignores synthetic record with intentCenter=-1 (catch-all solver failure)', () => {
    // The translator pushes a synthetic record when applyStereoLabels
    // rejects in bulk. Summarizer skips it (no specific center to name).
    const records: ModeCRecord[] = [
      {
        intentCenter: -1,
        canvasCenter: -1,
        intendedRS: null,
        perceivedRS: null,
        reapplied: false,
        skipReason: 'solver_failed: bulk apply rejected',
      },
    ];
    const diagnostics = summarizeStereoLossDiagnostics(records);
    expect(diagnostics).toHaveLength(0);
  });
});
