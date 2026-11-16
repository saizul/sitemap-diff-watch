import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCli, type CliIo } from '../src/cli-run.js';
import { validateConfig, type LoadedConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { compileUrlFilter, compileUrlPattern, filterKey, filterSnapshot, FilterError } from '../src/filter/url-filter.js';
import { renderMarkdown } from '../src/report/markdown.js';
import { buildReport } from '../src/report/model.js';
import { JsonSnapshotStore, SqliteSnapshotStore, sqliteAvailable } from '../src/snapshot/index.js';
import { runWatch, type Logger } from '../src/watch.js';
import { sitemapIndex, tempDir, urlset } from './helpers/fixtures.js';
import { MockFetch, noSleep } from './helpers/mock-fetch.js';
import { snap } from './helpers/snapshots.js';

const O = 'https://www.example.com';

describe('compileUrlPattern', () => {
  it('matches path globs against path and query', () => {
    const blog = compileUrlPattern('/blog/*');
    assert.equal(blog(`${O}/blog/post`), true);
    assert.equal(blog(`${O}/blog/post?page=2`), true);
    assert.equal(blog(`${O}/blog/2026/post`), false, '* does not cross /');
    assert.equal(blog(`${O}/blog`), false);
    assert.equal(blog('not a url'), false);

    const deep = compileUrlPattern('/blog/**');
    assert.equal(deep(`${O}/blog`), true, 'a trailing /** matches the directory itself');
    assert.equal(deep(`${O}/blog/`), true);
    assert.equal(deep(`${O}/blog/2026/11/post`), true);
    assert.equal(deep(`${O}/blogger`), false);

    assert.equal(compileUrlPattern('/**/amp')(`${O}/news/a/amp`), true);
    assert.equal(compileUrlPattern('/p/*.html')(`${O}/p/x.html`), true);
    assert.equal(compileUrlPattern('/p/*.html')(`${O}/p/xhtml`), false, 'dots are literal');
    assert.equal(compileUrlPattern('/search?q=*')(`${O}/search?q=shoes`), true, '? is literal');
    assert.equal(compileUrlPattern('/search?q=*')(`${O}/searchXq=shoes`), false);
    assert.equal(compileUrlPattern('/Blog/**')(`${O}/blog/a`), false, 'paths are case-sensitive');
  });

  it('matches full URL and host globs, with hosts compared lower-cased', () => {
    const url = compileUrlPattern('HTTPS://WWW.Example.com/p/*');
    assert.equal(url(`${O}/p/shoe`), true);
    assert.equal(url('http://www.example.com/p/shoe'), false, 'the scheme is part of the URL');
    assert.equal(url(`${O}/p/shoe#reviews`), true, 'fragments are ignored');

    const host = compileUrlPattern('*.Example.com/news/**');
    assert.equal(host('https://shop.example.com/news/a'), true);
    assert.equal(host('https://example.com/news/a'), false);
    assert.equal(host('https://a.b.example.com/news/a'), true, '* may span dots in the host');
    assert.equal(host('https://shop.example.com/x/news/a'), false);
  });

  it('supports regular expressions and rejects bad patterns', () => {
    const re = compileUrlPattern('re:/\\d{4}/\\d{2}/');
    assert.equal(re(`${O}/news/2026/11/story`), true);
    assert.equal(re(`${O}/news/story`), false);
    assert.throws(() => compileUrlPattern('re:(unclosed'), FilterError);
    assert.throws(() => compileUrlPattern(''), /non-empty/);
    assert.throws(() => compileUrlPattern('/'.repeat(1001)), /longer than 1000/);
  });
});

describe('compileUrlFilter', () => {
  it('keeps URLs that match an include and no exclude', () => {
    const f = compileUrlFilter({ include: ['/blog/**', '/news/**'], exclude: ['/blog/tag/**', 're:[?&]utm_'] });
    assert.equal(f.active, true);
    assert.equal(f.test(`${O}/blog/a`), true);
    assert.equal(f.test(`${O}/news/a`), true);
    assert.equal(f.test(`${O}/about`), false);
    assert.equal(f.test(`${O}/blog/tag/x`), false);
    assert.equal(f.test(`${O}/blog/a?utm_source=x`), false);
  });

  it('is inactive without patterns and names the failing pattern', () => {
    const f = compileUrlFilter();
    assert.equal(f.active, false);
    assert.equal(f.test('anything'), true);
    assert.throws(() => compileUrlFilter({ exclude: ['/ok', 're:['] }), /^FilterError: exclude\[1\]: invalid regular expression/);
    assert.throws(() => compileUrlFilter({ include: 'x' as unknown as string[] }), /include must be a list of strings/);
  });

  it('computes a stable key regardless of order', () => {
    assert.equal(filterKey(undefined), '');
    assert.equal(filterKey({ include: [], exclude: [] }), '');
    assert.equal(filterKey({ include: ['/b', '/a'], exclude: [] }), filterKey({ include: ['/a', '/b'], exclude: [] }));
    assert.notEqual(filterKey({ include: ['/a'], exclude: [] }), filterKey({ include: [], exclude: ['/a'] }));
  });
});

describe('filterSnapshot', () => {
  it('drops out-of-scope URLs, recomputes stats and records the filter', () => {
    const s = snap('x', '2026-11-01T00:00:00Z', [`${O}/`, `${O}/blog/a`, `${O}/blog/b`, `${O}/shop/c`]);
    const f = filterSnapshot(s, compileUrlFilter({ include: ['/blog/**'] }));
    assert.deepEqual(f.urls.map((u) => u.loc), [`${O}/blog/a`, `${O}/blog/b`]);
    assert.equal(f.stats.uniqueUrlCount, 2);
    assert.deepEqual(f.stats.filter, { include: ['/blog/**'], exclude: [], excludedUrls: 2 });
    assert.equal(s.urls.length, 4, 'the input is not modified');
    assert.equal(filterSnapshot(s, compileUrlFilter()), s);
  });

  it('shows the scope in reports', () => {
    const before = filterSnapshot(snap('x', '2026-11-01T00:00:00Z', [`${O}/blog/a`, `${O}/shop/c`]), compileUrlFilter({ include: ['/blog/**'] }));
    const md = renderMarkdown(buildReport({ snapshot: before, now: Date.parse('2026-11-02T00:00:00Z') }));
    assert.match(md, /\| Out of scope \(filtered\) \| 1 \|/);
    assert.match(md, /URL scope: include `\/blog\/\*\*`\./);
  });
});

describe('config filters', () => {
  const base = { sites: [{ name: 'a', sitemaps: [`${O}/sitemap.xml`] }] };
  it('accepts include, exclude and excludeSitemaps', () => {
    const c = validateConfig({ sites: [{ ...base.sites[0], include: ['/blog/**'], exclude: ['re:\\?p='], excludeSitemaps: ['/product-sitemap*.xml'] }] });
    assert.deepEqual(c.sites[0]!.include, ['/blog/**']);
  });
  it('reports the bad key and pattern', () => {
    assert.throws(() => validateConfig({ sites: [{ ...base.sites[0], exclude: ['/ok', 're:('] }] }), (e: Error) => e instanceof ConfigError && /sites\[0\]\.exclude\[1\]: invalid regular expression/.test(e.message));
    assert.throws(() => validateConfig({ sites: [{ ...base.sites[0], excludeSitemaps: '/x' }] }), /sites\[0\]\.excludeSitemaps must be a list of strings/);
    assert.throws(() => validateConfig({ sites: [{ ...base.sites[0], include: [''] }] }), /sites\[0\]\.include\[0\]: URL pattern must be a non-empty string/);
  });
});

function siteMock(posts: string[]): MockFetch {
  return new MockFetch()
    .get(`${O}/sitemap_index.xml`, sitemapIndex([`${O}/post-sitemap.xml`, `${O}/product-sitemap1.xml`, `${O}/product-sitemap2.xml`]))
    .get(`${O}/post-sitemap.xml`, urlset(posts))
    .get(`${O}/product-sitemap1.xml`, urlset([`${O}/p/1`, `${O}/p/2`]))
    .get(`${O}/product-sitemap2.xml`, urlset([`${O}/p/3`]));
}

function quiet(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), error: (m) => lines.push(`error ${m}`) };
}

function watchConfig(dir: string, site: Partial<LoadedConfig['config']['sites'][number]>): LoadedConfig {
  return {
    baseDir: dir,
    missingEnv: [],
    config: { store: { type: 'json', path: 'snapshots' }, reports: { dir: 'reports', formats: ['md'] }, validate: { enabled: false }, sites: [{ name: 'shop', sitemaps: [`${O}/sitemap_index.xml`], ...site }] },
  };
}

describe('runWatch with filters', () => {
  it('skips excluded sitemaps and keeps only in-scope URLs', async () => {
    const dir = await tempDir();
    try {
      const mock = siteMock([`${O}/blog/a`, `${O}/blog/tag/x`, `${O}/about`]);
      const [r] = await runWatch(watchConfig(dir, { include: ['/blog/**', '/about'], exclude: ['/blog/tag/**'], excludeSitemaps: ['/product-sitemap*.xml'] }), { fetch: mock.fetch, sleep: noSleep, logger: quiet() });
      assert.equal(r!.ok, true, r!.error);
      assert.equal(r!.urlCount, 2);
      assert.equal(mock.callsTo(/product-sitemap/).length, 0, 'excluded child sitemaps are not downloaded');
      const stored = await new JsonSnapshotStore(join(dir, 'snapshots')).latest('shop', 1);
      assert.deepEqual(stored[0]!.stats.filter, { include: ['/blog/**', '/about'], exclude: ['/blog/tag/**'], excludedUrls: 1 });
      const md = await readFile(join(dir, 'reports', 'shop', 'report.md'), 'utf8');
      assert.match(md, /URL scope: include/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('re-filters the previous snapshot when the scope changes, so it is not a mass removal', async () => {
    const dir = await tempDir();
    try {
      let t = Date.parse('2026-11-01T00:00:00Z');
      const posts = [`${O}/blog/a`, `${O}/blog/b`, `${O}/about`, `${O}/contact`];
      await runWatch(watchConfig(dir, {}), { fetch: siteMock(posts).fetch, clock: () => t, sleep: noSleep, logger: quiet() });
      t += 86_400_000;
      const log = quiet();
      const [r] = await runWatch(watchConfig(dir, { include: ['/blog/**'] }), { fetch: siteMock([...posts, `${O}/blog/c`]).fetch, clock: () => t, sleep: noSleep, logger: log });
      assert.equal(r!.ok, true, r!.error);
      assert.deepEqual({ added: r!.diff!.added, removed: r!.diff!.removed, before: r!.diff!.before }, { added: 1, removed: 0, before: 2 });
      assert.ok(log.lines.some((l) => /warn shop: the URL filter changed since snapshot/.test(l)));

      t += 86_400_000;
      const log3 = quiet();
      const [r3] = await runWatch(watchConfig(dir, { include: ['/blog/**'] }), { fetch: siteMock([...posts, `${O}/blog/c`]).fetch, clock: () => t, sleep: noSleep, logger: log3 });
      assert.deepEqual({ added: r3!.diff!.added, removed: r3!.diff!.removed }, { added: 0, removed: 0 });
      assert.ok(!log3.lines.some((l) => /filter changed/.test(l)), 'same scope, no warning');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('sqlite store keeps the filter', async () => {
  const available = await sqliteAvailable();
  it('round-trips stats.filter', { skip: !available && 'node:sqlite is not available' }, async () => {
    const dir = await tempDir();
    try {
      const store = await SqliteSnapshotStore.open(join(dir, 's.sqlite'));
      const s = filterSnapshot(snap('x', '2026-11-01T00:00:00Z', [`${O}/blog/a`, `${O}/shop/c`]), compileUrlFilter({ exclude: ['/shop/**'] }));
      await store.save(s);
      const [back] = await store.latest('x', 1);
      await store.close();
      assert.deepEqual(back!.stats.filter, { include: [], exclude: ['/shop/**'], excludedUrls: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function io(fetch?: MockFetch): CliIo & { out: string; err: string } {
  const r = { out: '', err: '', stdout: (t: string) => void (r.out += t), stderr: (t: string) => void (r.err += t), sleep: noSleep, now: () => Date.parse('2026-11-14T12:00:00Z'), env: {}, ...(fetch ? { fetch: fetch.fetch } : {}) };
  return r;
}

describe('cli filters', () => {
  it('applies --include, --exclude and --exclude-sitemap to fetch', async () => {
    const mock = siteMock([`${O}/blog/a`, `${O}/blog/tag/x`, `${O}/about`]);
    const a = io(mock);
    const code = await runCli(['fetch', `${O}/sitemap_index.xml`, '--urls', '--include', '/blog/**', '--exclude', '/blog/tag/*', '--exclude-sitemap', 're:product-sitemap\\d'], a);
    assert.equal(code, 0, a.err);
    assert.equal(a.out, `${O}/blog/a\n`);
    assert.equal(mock.callsTo(/product-sitemap/).length, 0);

    const b = io(siteMock([`${O}/blog/a`, `${O}/about`]));
    assert.equal(await runCli(['fetch', `${O}/sitemap_index.xml`, '--exclude', '/p/**'], b), 0, b.err);
    assert.match(b.out, /Filtered: 3 URL\(s\) out of scope \(exclude \/p\/\*\*\)/);
  });

  it('filters both sides of a diff', async () => {
    const dir = await tempDir();
    try {
      const store = join(dir, 'snaps');
      for (const [i, extra] of [[0, []], [1, [`${O}/shop/new`, `${O}/blog/new`]]] as const) {
        const a = io(new MockFetch().get(`${O}/sitemap.xml`, urlset([`${O}/blog/a`, `${O}/shop/a`, ...extra])));
        a.now = () => Date.parse('2026-11-14T12:00:00Z') + i * 1000;
        assert.equal(await runCli(['snapshot', `${O}/sitemap.xml`, '--site', 's', '--store', store], a), 0, a.err);
      }
      const d = io();
      assert.equal(await runCli(['diff', '--site', 's', '--store', store, '--format', 'json', '--exclude', '/shop/**'], d), 0, d.err);
      const report = JSON.parse(d.out);
      assert.deepEqual(report.diff.added.map((u: { loc: string }) => u.loc), [`${O}/blog/new`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits with 2 on an invalid pattern', async () => {
    const a = io();
    assert.equal(await runCli(['fetch', `${O}/sitemap.xml`, '--include', '/ok', '--include', 're:('], a), 2);
    assert.match(a.err, /--include \(pattern 2\): invalid regular expression/);
    const b = io();
    assert.equal(await runCli(['fetch', `${O}/sitemap.xml`, '--exclude-sitemap', 're:['], b), 2);
    assert.match(b.err, /--exclude-sitemap \(pattern 1\)/);
  });
});
