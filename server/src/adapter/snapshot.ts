import { createHash } from 'node:crypto';

export type SnapshotRecord = {
  id: string;
  ket: string;
  ketHash: string;
  timestamp: string;
  label?: string;
};

export class SnapshotStore {
  private snapshots: SnapshotRecord[] = [];
  private counter = 0;

  create(ket: string, label?: string): SnapshotRecord {
    const record: SnapshotRecord = {
      id: `snap_${++this.counter}`,
      ket,
      ketHash: createHash('sha256').update(ket).digest('hex'),
      timestamp: new Date().toISOString(),
      label,
    };
    this.snapshots.push(record);
    return record;
  }

  list(limit = 20): SnapshotRecord[] {
    const safeLimit = Math.max(0, Math.min(limit, this.snapshots.length));
    return this.snapshots.slice(-safeLimit);
  }

  get(snapshotId: string): SnapshotRecord | undefined {
    return this.snapshots.find((snapshot) => snapshot.id === snapshotId);
  }

  latest(): SnapshotRecord | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }
}
