import type { Snapshot, SnapshotMeta } from './snapshot.js';

/** Where snapshots live. Implementations: {@link JsonSnapshotStore}, {@link SqliteSnapshotStore}. */
export interface SnapshotStore {
  readonly kind: 'json' | 'sqlite';
  save(snapshot: Snapshot): Promise<void>;
  /** Snapshot metadata for a site, oldest first. */
  list(site: string): Promise<SnapshotMeta[]>;
  load(site: string, id: string): Promise<Snapshot>;
  /** The newest `count` snapshots (default 1), oldest first. */
  latest(site: string, count?: number): Promise<Snapshot[]>;
  delete(site: string, id: string): Promise<void>;
  /** Keep the newest `keep` snapshots of a site and delete the rest. Returns the ids removed. */
  prune(site: string, keep: number): Promise<string[]>;
  sites(): Promise<string[]>;
  close(): Promise<void>;
}
