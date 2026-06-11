import { describe, expect, it } from 'vitest';
import {
  CanvasMultiplex,
  DEFAULT_CANVAS_KEY,
  resolveCanvasRouting,
} from '../../src/mcp/canvas-multiplex';

describe('CanvasMultiplex', () => {
  it('first explicit bind is a switch from null with no evict key', () => {
    const m = new CanvasMultiplex();
    const d = m.next('A', true, false);
    expect(d).toEqual({ kind: 'switch', key: 'A', evictKey: null });
  });

  it('re-binding the current key is a noop', () => {
    const m = new CanvasMultiplex();
    m.commit('A');
    expect(m.next('A', true, false)).toEqual({ kind: 'noop' });
  });

  it('switching keys reports the outgoing key as evictKey', () => {
    const m = new CanvasMultiplex();
    m.commit('A');
    expect(m.next('B', true, false)).toEqual({
      kind: 'switch',
      key: 'B',
      evictKey: 'A',
    });
  });

  it('anchorless bind inherits the current key when not strict', () => {
    const m = new CanvasMultiplex();
    m.commit('A');
    // requestedKey null, explicit false, strict false -> inherit 'A' -> noop
    expect(m.next(null, false, false)).toEqual({ kind: 'noop' });
  });

  it('anchorless bind with no current key uses the default key', () => {
    const m = new CanvasMultiplex();
    expect(m.next(null, false, false)).toEqual({
      kind: 'switch',
      key: DEFAULT_CANVAS_KEY,
      evictKey: null,
    });
  });

  it('strict mode rejects an anchorless canvas bind', () => {
    const m = new CanvasMultiplex();
    m.commit('A');
    expect(m.next(null, false, true)).toEqual({
      kind: 'reject',
      key: 'A',
    });
  });

  it('strict mode allows explicitly-anchored binds', () => {
    const m = new CanvasMultiplex();
    m.commit('A');
    expect(m.next('B', true, true)).toEqual({
      kind: 'switch',
      key: 'B',
      evictKey: 'A',
    });
  });

  it('commit updates currentKey', () => {
    const m = new CanvasMultiplex();
    expect(m.currentKey).toBeNull();
    m.commit('A');
    expect(m.currentKey).toBe('A');
  });
});

describe('resolveCanvasRouting', () => {
  it('routes a canvas-free tool with no bind', () => {
    expect(
      resolveCanvasRouting('validate_graph', { rowId: 'R' }, false),
    ).toEqual({ isCanvasFree: true });
  });

  it('routes crop, refuse, and list_canonical as canvas-free', () => {
    for (const name of ['crop_source_image', 'refuse', 'list_canonical']) {
      expect(resolveCanvasRouting(name, {}, false).isCanvasFree).toBe(true);
    }
  });

  it('routes a canvas tool with an explicit rowId', () => {
    expect(
      resolveCanvasRouting('build_from_graph', { rowId: 'R' }, false),
    ).toEqual({
      isCanvasFree: false,
      bind: { requestedKey: 'R', explicit: true, strict: false },
    });
  });

  it('routes an anchorless canvas tool as non-explicit', () => {
    expect(resolveCanvasRouting('export_smiles', {}, false)).toEqual({
      isCanvasFree: false,
      bind: { requestedKey: null, explicit: false, strict: false },
    });
  });

  it('treats an empty-string rowId as anchorless', () => {
    expect(
      resolveCanvasRouting('render_canvas', { rowId: '' }, false),
    ).toEqual({
      isCanvasFree: false,
      bind: { requestedKey: null, explicit: false, strict: false },
    });
  });

  it('threads strict into the bind params', () => {
    expect(
      resolveCanvasRouting('build_from_graph', { rowId: 'R' }, true),
    ).toEqual({
      isCanvasFree: false,
      bind: { requestedKey: 'R', explicit: true, strict: true },
    });
  });

  it('load_canonical is NOT canvas-free (it mutates the canvas)', () => {
    expect(
      resolveCanvasRouting('load_canonical', { name: 'aspirin' }, false)
        .isCanvasFree,
    ).toBe(false);
  });
});
