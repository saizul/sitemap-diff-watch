import assert from 'node:assert/strict';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { StoreError } from '../src/errors.js';
import { JsonSnapshotStore, openStore, SqliteSnapshotStore, sqliteAvailable } from '../src/snapshot/index.js';
import { assertSnapshot, snapshotId } from '../src/snapshot/snapshot.js';
import type { SnapshotStore } from '../src/snapshot/store.js';
import { tempDir } from './helpers/fixtures.js';
import { snap } from './helpers/snapshots.js';

const one = snap('example', '2026-11-01T00:00:00.000Z', [
  { loc: 'https://www.example.com/a', lastmod: '2026-10-01', images: [{ loc: 'https://www.example.com/a.jpg' }] },
  { loc: 'https://www.example.com/b', alternates: [{ hreflang: 'en', href: 'https://www.example.com/b' }] },
]);
const two = snap('example', '2026-11-08T00:00:00.000Z', ['https://www.example.com/a', 'https://www.example.com/c']);
const three = snap('example', '2026-11-15T00:00:00.000Z', ['https://www.example.com/c']);

async function contract(store: SnapshotStore): Promise<void> {
  // Saved out of order on purpose.
  await store.save(two);
  await store.save(one);
  await store.save(three);
  await store.save(snap('other site', '2026-11-02T00:00:00.000Z', ['https://other.example/']));

  const metas = await store.list('example');
  assert.deepEqual(metas.map((m) => m.id), [one.id, two.id, three.id]);
  assert.equal(metas[0]!.stats.uniqueUrlCount, 2);
  assert.deepEqual((await store.sites()).sort(), ['example', 'other site']);

  const loaded = await store.load('example', one.id);
  assert.deepEqual(loaded, one);
  const latest = await store.latest('example', 2);
  assert.deepEqual(latest.map((s) => s.id), [two.id, three.id]);
  assert.deepEqual((await store.latest('example')).map((s) => s.id), [three.id]);

  // Saving the same id again replaces it.
  await store.save(three);
  assert.equal((await store.list('example')).length, 3);

  assert.deepEqual(await store.prune('example', 2), [one.id]);
  assert.deepEqual((await store.list('example')).map((m) => m.id), [two.id, three.id]);
  await store.delete('example', two.id);
  assert.deepEqual((await store.list('example')).map((m) => m.id), [three.id]);
  await assert.rejects(store.load('example', one.id), StoreError);
  assert.deepEqual(await store.list('nobody'), []);
  await store.close();
}

describe('snapshot', () => {
  it('sorts URLs, computes stats and uses sortable ids', () => {
    const s = snap('x', '2026-11-14T10:15:30.123Z', ['https://a.example/z', 'https://a.example/a', 'https://a.example/a']);
    assert.equal(s.id, '20261114T101530123Z');
    assert.equal(snapshotId(Date.parse('2026-11-14T10:15:30.123Z')), s.id);
    assert.deepEqual(s.urls.map((u) => u.loc), ['https://a.example/a', 'https://a.example/a', 'https://a.example/z']);
    assert.equal(s.stats.urlCount, 3);
    assert.equal(s.stats.uniqueUrlCount, 2);
    assert.throws(() => assertSnapshot({ hello: 1 }), /not a sitemap-diff-watch snapshot/);
    assert.throws(() => assertSnapshot({ ...s, version: 99 }), /newer/);
  });
});

describe('JsonSnapshotStore', () => {
  it('fulfils the store contract with gzip files', async () => {
    const dir = await tempDir();
    try {
      await contract(new JsonSnapshotStore(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fulfils the store contract with plain JSON', async () => {
    const dir = await tempDir();
    try {
      await contract(new JsonSnapshotStore(dir, { compress: false }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes .json.gz files and an index, and rebuilds a lost index', async () => {
    const dir = await tempDir();
    try {
      const store = new JsonSnapshotStore(dir);
      await store.save(one);
      await store.save(two);
      const files = (await readdir(join(dir, 'example'))).sort();
      assert.deepEqual(files, [`${one.id}.json.gz`, `${two.id}.json.gz`, 'index.json']);
      const raw = await readFile(join(dir, 'example', `${one.id}.json.gz`));
      assert.equal(JSON.parse(gunzipSync(raw).toString()).id, one.id);

      await writeFile(join(dir, 'example', 'index.json'), 'garbage');
      assert.deepEqual((await new JsonSnapshotStore(dir).list('example')).map((m) => m.id), [one.id, two.id]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports damaged snapshot files', async () => {
    const dir = await tempDir();
    try {
      const store = new JsonSnapshotStore(dir, { compress: false });
      await store.save(one);
      await writeFile(join(dir, 'example', `${one.id}.json`), '{"not":"a snapshot"}');
      await assert.rejects(store.load('example', one.id), /unreadable/);
      assert.deepEqual(await new JsonSnapshotStore(join(dir, 'missing')).sites(), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SqliteSnapshotStore', async () => {
  const available = await sqliteAvailable();

  it('fulfils the store contract', { skip: !available && 'node:sqlite is not available' }, async () => {
    await contract(await SqliteSnapshotStore.open(':memory:'));
  });

  it('persists to a file and allows plain SQL', { skip: !available && 'node:sqlite is not available' }, async () => {
    const dir = await tempDir();
    try {
      const path = join(dir, 'nested', 'snaps.sqlite');
      const store = await openStore({ type: 'sqlite', path });
      assert.equal(store.kind, 'sqlite');
      await store.save(one);
      await store.close();
      const again = await SqliteSnapshotStore.open(path);
      assert.deepEqual(await again.load('example', one.id), one);
      await again.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to JSON when node:sqlite is missing', { skip: available && 'node:sqlite is available here' }, async () => {
    const messages: string[] = [];
    const store = await openStore({ type: 'sqlite', path: 'x/snaps.sqlite' }, (m) => messages.push(m));
    assert.equal(store.kind, 'json');
    assert.match(messages[0]!, /node:sqlite is not available/);
  });
});

describe('openStore', () => {
  it('defaults to the JSON store', async () => {
    const store = await openStore();
    assert.equal(store.kind, 'json');
    assert.equal((store as JsonSnapshotStore).dir, 'snapshots');
  });
});
