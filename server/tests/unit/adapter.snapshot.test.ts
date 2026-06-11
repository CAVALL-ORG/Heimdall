import { describe, expect, it } from 'vitest';
import { SnapshotStore } from '../../src/adapter/snapshot';

describe('SnapshotStore', () => {
  it('creates stable hash and ids', () => {
    const store = new SnapshotStore();
    const first = store.create('{"root":{"nodes":[]}}');
    const second = store.create('{"root":{"nodes":[1]}}');

    expect(first.id).toBe('snap_1');
    expect(second.id).toBe('snap_2');
    expect(first.ketHash).not.toBe(second.ketHash);
    expect(store.latest()?.id).toBe('snap_2');
  });
});
