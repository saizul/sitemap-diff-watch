import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StoreError, errorMessage } from '../errors.js';
import { SNAPSHOT_FORMAT, SNAPSHOT_VERSION, type Snapshot, type SnapshotMeta, type SnapshotUrl } from './snapshot.js';
import type { SnapshotStore } from './store.js';

// Minimal structural types for node:sqlite, so the package compiles and loads without it.
interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => Database;
}

async function loadSqlite(): Promise<SqliteModule | undefined> {
  try {
    // A variable specifier keeps bundlers and the CommonJS build from resolving it eagerly.
    const specifier = 'node:sqlite';
    return (await import(specifier)) as SqliteModule;
  } catch {
    return undefined;
  }
}

/** Is `node:sqlite` usable without flags (Node.js 22.13+, 23.4+, 24)? */
export async function sqliteAvailable(): Promise<boolean> {
  return (await loadSqlite()) !== undefined;
}

/**
 * Snapshots in one SQLite file through Node's built-in `node:sqlite`. URL rows live in
 * their own table, so you can query the history with plain SQL, e.g.
 * `SELECT loc FROM snapshot_urls WHERE site = ? AND snapshot_id = ?`.
 */
export class SqliteSnapshotStore implements SnapshotStore {
  readonly kind = 'sqlite' as const;

  private constructor(
    private readonly db: Database,
    readonly path: string,
  ) {}

  static async open(path: string): Promise<SqliteSnapshotStore> {
    const mod = await loadSqlite();
    if (!mod) throw new StoreError('the SQLite store needs node:sqlite (Node.js 22.13 or newer)');
    if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
    let db: Database;
    try {
      db = new mod.DatabaseSync(path);
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS snapshots (
          site TEXT NOT NULL,
          id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          stats TEXT NOT NULL,
          roots TEXT NOT NULL,
          sitemaps TEXT NOT NULL,
          warnings TEXT NOT NULL,
          version INTEGER NOT NULL,
          PRIMARY KEY (site, id)
        );
        CREATE TABLE IF NOT EXISTS snapshot_urls (
          site TEXT NOT NULL,
          snapshot_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          loc TEXT NOT NULL,
          lastmod TEXT,
          sitemap TEXT NOT NULL,
          extra TEXT,
          PRIMARY KEY (site, snapshot_id, seq)
        );
        CREATE INDEX IF NOT EXISTS snapshot_urls_loc ON snapshot_urls (site, loc);
      `);
    } catch (error) {
      throw new StoreError(`could not open SQLite database ${path}: ${errorMessage(error)}`, { cause: error });
    }
    return new SqliteSnapshotStore(db, path);
  }

  async save(snapshot: Snapshot): Promise<void> {
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      this.deleteRows(snapshot.site, snapshot.id);
      db.prepare(
        'INSERT INTO snapshots (site, id, created_at, stats, roots, sitemaps, warnings, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        snapshot.site,
        snapshot.id,
        snapshot.createdAt,
        JSON.stringify(snapshot.stats),
        JSON.stringify(snapshot.roots),
        JSON.stringify(snapshot.sitemaps),
        JSON.stringify(snapshot.warnings),
        snapshot.version,
      );
      const insert = db.prepare(
        'INSERT INTO snapshot_urls (site, snapshot_id, seq, loc, lastmod, sitemap, extra) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      snapshot.urls.forEach((u, i) => {
        const { loc, lastmod, sitemap, ...rest } = u;
        insert.run(snapshot.site, snapshot.id, i, loc, lastmod ?? null, sitemap, Object.keys(rest).length ? JSON.stringify(rest) : null);
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new StoreError(`could not save snapshot ${snapshot.id}: ${errorMessage(error)}`, { cause: error });
    }
  }

  async list(site: string): Promise<SnapshotMeta[]> {
    return this.db
      .prepare('SELECT id, created_at, stats FROM snapshots WHERE site = ? ORDER BY created_at, id')
      .all(site)
      .map((row) => ({ id: String(row['id']), site, createdAt: String(row['created_at']), stats: JSON.parse(String(row['stats'])) }));
  }

  async load(site: string, id: string): Promise<Snapshot> {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE site = ? AND id = ?').get(site, id);
    if (!row) throw new StoreError(`no snapshot ${id} for site ${site}`);
    const urls: SnapshotUrl[] = this.db
      .prepare('SELECT loc, lastmod, sitemap, extra FROM snapshot_urls WHERE site = ? AND snapshot_id = ? ORDER BY seq')
      .all(site, id)
      .map((r) => {
        const extra = r['extra'] ? (JSON.parse(String(r['extra'])) as Partial<SnapshotUrl>) : {};
        return {
          loc: String(r['loc']),
          ...(r['lastmod'] !== null && r['lastmod'] !== undefined ? { lastmod: String(r['lastmod']) } : {}),
          ...extra,
          sitemap: String(r['sitemap']),
        };
      });
    return {
      format: SNAPSHOT_FORMAT,
      version: Number(row['version'] ?? SNAPSHOT_VERSION),
      id,
      site,
      createdAt: String(row['created_at']),
      stats: JSON.parse(String(row['stats'])),
      roots: JSON.parse(String(row['roots'])),
      sitemaps: JSON.parse(String(row['sitemaps'])),
      warnings: JSON.parse(String(row['warnings'])),
      urls,
    };
  }

  async latest(site: string, count = 1): Promise<Snapshot[]> {
    const metas = (await this.list(site)).slice(-count);
    return Promise.all(metas.map((m) => this.load(site, m.id)));
  }

  async delete(site: string, id: string): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.deleteRows(site, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw new StoreError(`could not delete snapshot ${id}: ${errorMessage(error)}`, { cause: error });
    }
  }

  async prune(site: string, keep: number): Promise<string[]> {
    const metas = await this.list(site);
    const remove = metas.slice(0, Math.max(0, metas.length - Math.max(0, keep)));
    for (const m of remove) await this.delete(site, m.id);
    return remove.map((m) => m.id);
  }

  async sites(): Promise<string[]> {
    return this.db
      .prepare('SELECT DISTINCT site FROM snapshots ORDER BY site')
      .all()
      .map((r) => String(r['site']));
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private deleteRows(site: string, id: string): void {
    this.db.prepare('DELETE FROM snapshot_urls WHERE site = ? AND snapshot_id = ?').run(site, id);
    this.db.prepare('DELETE FROM snapshots WHERE site = ? AND id = ?').run(site, id);
  }
}
