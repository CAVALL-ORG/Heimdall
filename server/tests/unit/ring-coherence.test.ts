/**
 * TDD tests for checkRingCoherence (ring-coherence.ts).
 *
 * Checks C1 (Euler scalar) and C3 (fusion continuity, >=2 inter-ring bonds).
 * C2/V12 already exists in validator.ts; not reimplemented here.
 *
 * FP=0 invariant: no correct committed fixture may produce any finding.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { checkRingCoherence } from '../../src/adapter/graph-intent/ring-coherence';

// ── Helpers ──────────────────────────────────────────────────────────────────

function atom(id: number) {
  return { id };
}

function bond(a: number, b: number) {
  return { a, b };
}

function ring(id: string, atoms: number[]) {
  return { id, atoms };
}

// ── C1: Euler scalar (ring under-declaration) ─────────────────────────────

describe('C1 — Euler scalar (ring_underdeclared)', () => {
  it('fires when rings.length < bondCyclomatic', () => {
    // Triangle (A-B-C) + square (A-B-D-E) sharing edge A-B:
    // V=5, E=6, comps=1 -> cyclomatic=2; declared 1 ring -> 1 < 2 fires
    const atoms = [atom(1), atom(2), atom(3), atom(4), atom(5)];
    const bonds = [
      bond(1, 2), bond(2, 3), bond(3, 1), // triangle: ring 1-2-3
      bond(1, 4), bond(4, 5), bond(5, 2), // second ring 1-4-5-2 (shares 1-2)
    ];
    const rings = [ring('r1', [1, 2, 3])]; // only 1 declared, cyclomatic=2
    const findings = checkRingCoherence({ atoms, bonds, rings });
    expect(findings.some((f) => f.kind === 'ring_underdeclared')).toBe(true);
  });

  it('is silent when rings.length === bondCyclomatic', () => {
    // Single benzene-like 6-ring: V=6, E=6, comps=1 -> cyclomatic=1; declared 1 -> equal
    const atoms = [atom(1), atom(2), atom(3), atom(4), atom(5), atom(6)];
    const bonds = [
      bond(1, 2), bond(2, 3), bond(3, 4), bond(4, 5), bond(5, 6), bond(6, 1),
    ];
    const rings = [ring('r1', [1, 2, 3, 4, 5, 6])];
    const findings = checkRingCoherence({ atoms, bonds, rings });
    expect(findings.filter((f) => f.kind === 'ring_underdeclared')).toHaveLength(0);
  });

  it('is silent when rings.length > bondCyclomatic (cage/over-declared)', () => {
    // Cubane-like: V=8 E=12 comps=1 -> cyclomatic=5; declare 6 rings -> 6 > 5 -> SILENT
    // Use a simple cube-topology: 8 vertices, 12 edges
    const atoms = [1, 2, 3, 4, 5, 6, 7, 8].map(atom);
    const bonds = [
      bond(1, 2), bond(2, 3), bond(3, 4), bond(4, 1), // bottom square
      bond(5, 6), bond(6, 7), bond(7, 8), bond(8, 5), // top square
      bond(1, 5), bond(2, 6), bond(3, 7), bond(4, 8), // verticals
    ];
    // Declare 6 faces (cube has 6 faces); Euler cyclomatic = 12-8+1=5
    const rings = [
      ring('bottom', [1, 2, 3, 4]),
      ring('top', [5, 6, 7, 8]),
      ring('front', [1, 2, 6, 5]),
      ring('back', [3, 4, 8, 7]),
      ring('left', [1, 4, 8, 5]),
      ring('right', [2, 3, 7, 6]),
    ];
    const findings = checkRingCoherence({ atoms, bonds, rings });
    expect(findings.filter((f) => f.kind === 'ring_underdeclared')).toHaveLength(0);
  });

  it('counts components correctly for a 2-fragment graph', () => {
    // Two isolated triangles: V=6 E=6 comps=2 -> cyclomatic=6-6+2=2; declared 2 -> equal
    const atoms = [atom(1), atom(2), atom(3), atom(10), atom(11), atom(12)];
    const bonds = [
      bond(1, 2), bond(2, 3), bond(3, 1),    // fragment 1
      bond(10, 11), bond(11, 12), bond(12, 10), // fragment 2
    ];
    const rings = [ring('r1', [1, 2, 3]), ring('r2', [10, 11, 12])];
    const findings = checkRingCoherence({ atoms, bonds, rings });
    expect(findings.filter((f) => f.kind === 'ring_underdeclared')).toHaveLength(0);

    // Now under-declare (1 ring, cyclomatic=2) -> fires
    const findings2 = checkRingCoherence({
      atoms,
      bonds,
      rings: [ring('r1', [1, 2, 3])], // missing r2
    });
    expect(findings2.some((f) => f.kind === 'ring_underdeclared')).toBe(true);
  });
});

// ── C3: fusion continuity (ring_fusion_unrepresented) ────────────────────

describe('C3 — fusion continuity (ring_fusion_unrepresented, >=2 threshold)', () => {
  it('fires when shared < 2 AND inter-ring bonds >= 2', () => {
    // Ring A: [1,2,3,4]; Ring B: [3,5,6,7] — shared={3} (count=1)
    // Extra inter-ring bonds: 4-5 (4 in A only, 5 in B only) and 2-7 (2 in A only, 7 in B only)
    const atoms = [1, 2, 3, 4, 5, 6, 7].map(atom);
    const bonds = [
      bond(1, 2), bond(2, 3), bond(3, 4), bond(4, 1), // ring A
      bond(3, 5), bond(5, 6), bond(6, 7), bond(7, 3), // ring B (shares atom 3)
      bond(4, 5), // inter bond 1
      bond(2, 7), // inter bond 2
    ];
    const rings = [ring('rA', [1, 2, 3, 4]), ring('rB', [3, 5, 6, 7])];
    const findings = checkRingCoherence({ atoms, bonds, rings });
    expect(findings.some((f) => f.kind === 'ring_fusion_unrepresented')).toBe(true);
  });

  it('SILENT on biphenyl — two 6-rings joined by exactly 1 bond [FP GUARD]', () => {
    // Ring r1: atoms [1..6], Ring r2: atoms [7..12]
    // Single linker bond 1-7; shared=0 inter=1 -> NO finding
    const atoms = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(atom);
    const bonds = [
      bond(1, 2), bond(2, 3), bond(3, 4), bond(4, 5), bond(5, 6), bond(6, 1),
      bond(7, 8), bond(8, 9), bond(9, 10), bond(10, 11), bond(11, 12), bond(12, 7),
      bond(1, 7), // the single linker
    ];
    const rings = [ring('r1', [1, 2, 3, 4, 5, 6]), ring('r2', [7, 8, 9, 10, 11, 12])];
    const findings = checkRingCoherence({ atoms, bonds, rings });
    expect(findings.filter((f) => f.kind === 'ring_fusion_unrepresented')).toHaveLength(0);
  });

  it('SILENT on spiro — two rings sharing exactly 1 atom, 0 inter-ring bonds', () => {
    // Ring A: [1,2,3,4] sharing atom 4 with Ring B: [4,5,6,7]; 0 cross bonds
    const atoms = [1, 2, 3, 4, 5, 6, 7].map(atom);
    const bonds = [
      bond(1, 2), bond(2, 3), bond(3, 4), bond(4, 1), // ring A
      bond(4, 5), bond(5, 6), bond(6, 7), bond(7, 4), // ring B
    ];
    const rings = [ring('rA', [1, 2, 3, 4]), ring('rB', [4, 5, 6, 7])];
    const findings = checkRingCoherence({ atoms, bonds, rings });
    expect(findings.filter((f) => f.kind === 'ring_fusion_unrepresented')).toHaveLength(0);
  });

  it('SILENT on ortho-fused — two rings sharing 2 atoms (shared>=2 skip)', () => {
    // Ring A (benzene): [1,2,3,4,5,6]; Ring B: [1,7,8,9,6] shares atoms 1 and 6
    const atoms = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(atom);
    const bonds = [
      bond(1, 2), bond(2, 3), bond(3, 4), bond(4, 5), bond(5, 6), bond(6, 1),
      bond(1, 7), bond(7, 8), bond(8, 9), bond(9, 6),
    ];
    const rings = [ring('rA', [1, 2, 3, 4, 5, 6]), ring('rB', [1, 7, 8, 9, 6])];
    const findings = checkRingCoherence({ atoms, bonds, rings });
    expect(findings.filter((f) => f.kind === 'ring_fusion_unrepresented')).toHaveLength(0);
  });
});

// ── FP=0 sweep — all committed fixtures must return [] ────────────────────

describe('FP=0 sweep — committed fixtures', () => {
  const fixtureFiles = [
    'tests/fixtures/ez/A011H.graph.json',
    'tests/fixtures/relayout/A004pass.graph.json',
    'tests/fixtures/relayout/coord-cw-A004H.graph.json',
    'tests/fixtures/relayout/sparse-wedge-alanine.graph.json',
  ];

  for (const relPath of fixtureFiles) {
    it(`returns [] for ${relPath}`, () => {
      const raw = JSON.parse(
        readFileSync(
          new URL(`../../${relPath}`, import.meta.url).pathname,
          'utf8',
        ),
      );
      const findings = checkRingCoherence({
        atoms: (raw.atoms ?? []).map((a: { id: number }) => ({ id: a.id })),
        bonds: (raw.bonds ?? []).map((b: { a: number; b: number }) => ({
          a: b.a,
          b: b.b,
        })),
        rings: (raw.rings ?? []).map((r: { id: string; atoms: number[] }) => ({
          id: r.id,
          atoms: r.atoms,
        })),
      });
      expect(findings).toHaveLength(0);
    });
  }
});
