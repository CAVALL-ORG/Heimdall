// Track A bug 1 — bare element pass-through in decomposeShorthand.
//
// `decomposeShorthand` consults KNOWN_ELEMENT_SYMBOLS as a third
// recognizer so bare element glyphs (`O`, `N`, `S`, …) decode to a
// single-atom subgraph instead of falling through TABLE + ISOTOPE_PATTERN
// to `{ unknown: true }`. Compound TABLE entries (`OH`) and isotope
// patterns (`13C`) must remain routed through their existing branches.
import { describe, expect, it } from 'vitest';
import { decomposeShorthand } from '../../src/adapter/visual-graph/shorthand-table';

describe('decomposeShorthand bare element pass-through', () => {
  it('returns a single-atom subgraph for bare O', () => {
    const result = decomposeShorthand('O');
    expect(result).toEqual({
      unknown: false,
      atoms: [{ element: 'O' }],
      bonds: [],
      attachment_atom_offset: 0,
    });
  });

  it.each(['N', 'S', 'C', 'Cl', 'Br', 'F', 'P'])(
    'returns a single-atom subgraph for bare %s',
    (symbol) => {
      const result = decomposeShorthand(symbol);
      expect(result).toEqual({
        unknown: false,
        atoms: [{ element: symbol }],
        bonds: [],
        attachment_atom_offset: 0,
      });
    },
  );

  it('still rejects an unrecognized two-letter token (Xx)', () => {
    expect(decomposeShorthand('Xx')).toEqual({ unknown: true });
  });

  it('still rejects an unrecognized longer token (Foo)', () => {
    expect(decomposeShorthand('Foo')).toEqual({ unknown: true });
  });

  it('still routes OH through TABLE (drawn_H:1 on oxygen, not bare O)', () => {
    // OH is the compound hydroxyl glyph: TABLE encodes an oxygen
    // carrying one explicit drawn H. The bare-element branch must not
    // shadow this. The exact shape comes from the TABLE entry in
    // shorthand-table.ts: atoms=[{ element:'O', drawn_H:1 }], bonds=[].
    const result = decomposeShorthand('OH');
    expect(result).toEqual({
      unknown: false,
      atoms: [{ element: 'O', drawn_H: 1 }],
      bonds: [],
      attachment_atom_offset: 0,
    });
  });

  it('still routes 13C through ISOTOPE_PATTERN (carries isotope field)', () => {
    const result = decomposeShorthand('13C');
    expect(result).toEqual({
      unknown: false,
      atoms: [{ element: 'C', isotope: 13 }],
      bonds: [],
      attachment_atom_offset: 0,
    });
  });
});
