import { dirname, join, basename, extname } from 'node:path';
import { JsonSnapshotStore, type JsonStoreOptions } from './json-store.js';
import { SqliteSnapshotStore, sqliteAvailable } from './sqlite-store.js';
import type { SnapshotStore } from './store.js';

export * from './snapshot.js';
export type { SnapshotStore } from './store.js';
export { JsonSnapshotStore, type JsonStoreOptions } from './json-store.js';
export { SqliteSnapshotStore, sqliteAvailable } from './sqlite-store.js';

export interface StoreConfig extends JsonStoreOptions {
  /** `json` (default) or `sqlite`. */
  type?: 'json' | 'sqlite';
  /** Directory for the JSON store, file for SQLite. Default `snapshots` / `snapshots/snapshots.sqlite`. */
  path?: string;
}

/**
 * Open a snapshot store. `sqlite` needs `node:sqlite`; when it is missing (Node.js 20, or
 * 22 before 22.13) the JSON store is used instead, in a directory next to the database
 * file, and `onFallback` is called with the reason.
 */
export async function openStore(config: StoreConfig = {}, onFallback?: (message: string) => void): Promise<SnapshotStore> {
  const type = config.type ?? 'json';
  if (type === 'sqlite') {
    const path = config.path ?? join('snapshots', 'snapshots.sqlite');
    if (await sqliteAvailable()) return SqliteSnapshotStore.open(path);
    const dir = join(dirname(path), basename(path, extname(path)));
    onFallback?.(`node:sqlite is not available in Node.js ${process.versions.node}; using the JSON store in ${dir}`);
    return new JsonSnapshotStore(dir, config);
  }
  return new JsonSnapshotStore(config.path ?? 'snapshots', config);
}
