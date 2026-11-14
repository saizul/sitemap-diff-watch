import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { StoreError, errorMessage } from '../errors.js';
import { slugify } from '../util/url.js';
import { assertSnapshot, metaOf, type Snapshot, type SnapshotMeta } from './snapshot.js';
import type { SnapshotStore } from './store.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface JsonStoreOptions {
  /** Write `.json.gz` (default) or plain `.json`. Both are read. */
  compress?: boolean;
  /** Indent plain JSON for readable git diffs (default true when not compressed). */
  pretty?: boolean;
}

interface SiteIndex {
  site: string;
  snapshots: SnapshotMeta[];
}

/**
 * Snapshots as files: `<dir>/<site-slug>/<id>.json.gz`, plus an `index.json` per site with
 * the metadata so history and charts need not read every snapshot. Writes go to a temp file
 * first and are renamed into place.
 */
export class JsonSnapshotStore implements SnapshotStore {
  readonly kind = 'json' as const;
  private readonly compress: boolean;
  private readonly pretty: boolean;

  constructor(
    readonly dir: string,
    options: JsonStoreOptions = {},
  ) {
    this.compress = options.compress ?? true;
    this.pretty = options.pretty ?? !this.compress;
  }

  private siteDir(site: string): string {
    return join(this.dir, slugify(site));
  }

  async save(snapshot: Snapshot): Promise<void> {
    const dir = this.siteDir(snapshot.site);
    await mkdir(dir, { recursive: true });
    const json = JSON.stringify(snapshot, null, this.pretty ? 1 : undefined);
    const name = `${snapshot.id}.json${this.compress ? '.gz' : ''}`;
    const data = this.compress ? await gzipAsync(json, { level: 9 }) : `${json}\n`;
    await atomicWrite(join(dir, name), data);
    const index = await this.readIndex(snapshot.site);
    index.snapshots = index.snapshots.filter((s) => s.id !== snapshot.id);
    index.snapshots.push(metaOf(snapshot));
    index.snapshots.sort(byCreated);
    await this.writeIndex(index);
  }

  async list(site: string): Promise<SnapshotMeta[]> {
    return (await this.readIndex(site)).snapshots;
  }

  async load(site: string, id: string): Promise<Snapshot> {
    const dir = this.siteDir(site);
    for (const name of [`${id}.json.gz`, `${id}.json`]) {
      let raw: Buffer;
      try {
        raw = await readFile(join(dir, name));
      } catch {
        continue;
      }
      try {
        const text = raw[0] === 0x1f && raw[1] === 0x8b ? (await gunzipAsync(raw)).toString('utf8') : raw.toString('utf8');
        const value: unknown = JSON.parse(text);
        assertSnapshot(value);
        return value;
      } catch (error) {
        throw new StoreError(`snapshot ${name} for ${site} is unreadable: ${errorMessage(error)}`, { cause: error });
      }
    }
    throw new StoreError(`no snapshot ${id} for site ${site}`);
  }

  async latest(site: string, count = 1): Promise<Snapshot[]> {
    const metas = (await this.list(site)).slice(-count);
    return Promise.all(metas.map((m) => this.load(site, m.id)));
  }

  async delete(site: string, id: string): Promise<void> {
    const dir = this.siteDir(site);
    await rm(join(dir, `${id}.json.gz`), { force: true });
    await rm(join(dir, `${id}.json`), { force: true });
    const index = await this.readIndex(site);
    index.snapshots = index.snapshots.filter((s) => s.id !== id);
    await this.writeIndex(index);
  }

  async prune(site: string, keep: number): Promise<string[]> {
    const metas = await this.list(site);
    const remove = metas.slice(0, Math.max(0, metas.length - Math.max(0, keep)));
    for (const m of remove) await this.delete(site, m.id);
    return remove.map((m) => m.id);
  }

  async sites(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const sites: string[] = [];
    for (const entry of entries.sort()) {
      try {
        const index = JSON.parse(await readFile(join(this.dir, entry, 'index.json'), 'utf8')) as SiteIndex;
        if (index.site) sites.push(index.site);
      } catch {
        // not a site directory
      }
    }
    return sites;
  }

  async close(): Promise<void> {}

  private async readIndex(site: string): Promise<SiteIndex> {
    const path = join(this.siteDir(site), 'index.json');
    try {
      const index = JSON.parse(await readFile(path, 'utf8')) as SiteIndex;
      if (Array.isArray(index.snapshots)) return { site, snapshots: index.snapshots.sort(byCreated) };
    } catch {
      // missing or damaged: rebuild below
    }
    return { site, snapshots: await this.rebuildIndex(site) };
  }

  /** Recreate the metadata index by reading every snapshot file. */
  async rebuildIndex(site: string): Promise<SnapshotMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.siteDir(site));
    } catch {
      return [];
    }
    const ids = [...new Set(names.filter((n) => /\.json(\.gz)?$/.test(n) && n !== 'index.json').map((n) => n.replace(/\.json(\.gz)?$/, '')))];
    const metas: SnapshotMeta[] = [];
    for (const id of ids) {
      try {
        metas.push(metaOf(await this.load(site, id)));
      } catch {
        // skip unreadable files
      }
    }
    return metas.sort(byCreated);
  }

  private async writeIndex(index: SiteIndex): Promise<void> {
    const dir = this.siteDir(index.site);
    await mkdir(dir, { recursive: true });
    await atomicWrite(join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  }
}

function byCreated(a: SnapshotMeta, b: SnapshotMeta): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw new StoreError(`could not write ${path}: ${errorMessage(error)}`, { cause: error });
  }
}
