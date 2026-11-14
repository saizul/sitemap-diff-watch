import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { runCli, type CliIo } from '../src/cli-run.js';
import { VERSION } from '../src/version.js';
import { fixture, fixturePath, gz, sitemapIndex, tempDir, urlset } from './helpers/fixtures.js';
import { MockFetch, noSleep } from './helpers/mock-fetch.js';

const O = 'https://www.example.com';

function io(fetch?: MockFetch, now = Date.parse('2026-11-14T12:00:00Z')): CliIo & { out: string; err: string } {
  const r = {
    out: '',
    err: '',
    stdout: (t: string) => void (r.out += t),
    stderr: (t: string) => void (r.err += t),
    sleep: noSleep,
    now: () => now,
    env: {},
    ...(fetch ? { fetch: fetch.fetch } : {}),
  };
  return r;
}

function site(extra: string[] = []): MockFetch {
  return new MockFetch()
    .get(`${O}/robots.txt`, `User-agent: *\nDisallow: /tmp/\nSitemap: ${O}/sitemap.xml\n`, { 'content-type': 'text/plain' })
    .get(`${O}/sitemap.xml`, sitemapIndex([`${O}/a.xml.gz`]))
    .get(`${O}/a.xml.gz`, gz(urlset([`${O}/`, { loc: `${O}/blog/post`, lastmod: '2026-11-10' }, ...extra])));
}

describe('cli', () => {
  it('prints help and version', async () => {
    const a = io();
    assert.equal(await runCli(['--version'], a), 0);
    assert.equal(a.out, `${VERSION}\n`);
    const b = io();
    assert.equal(await runCli(['--help'], b), 0);
    assert.match(b.out, /Usage:/);
    const c = io();
    assert.equal(await runCli([], c), 2);
  });

  it('rejects unknown commands and options', async () => {
    const a = io();
    assert.equal(await runCli(['frobnicate'], a), 2);
    assert.match(a.err, /unknown command/);
    const b = io();
    assert.equal(await runCli(['fetch', '--nope'], b), 2);
    assert.match(b.err, /Unknown option/i);
  });

  it('discover lists sitemaps from robots.txt', async () => {
    const a = io(site());
    assert.equal(await runCli(['discover', O], a), 0);
    assert.equal(a.out, `${O}/sitemap.xml\n`);
    const b = io(site());
    await runCli(['discover', O, '--json'], b);
    assert.equal(JSON.parse(b.out).source, 'robots');
  });

  it('fetch prints a summary, the URL list or JSON, and writes a snapshot file', async () => {
    const dir = await tempDir();
    try {
      const a = io(site());
      const out = join(dir, 'snap.json.gz');
      assert.equal(await runCli(['fetch', `${O}/sitemap.xml`, '--out', out], a), 0);
      assert.match(a.out, /URLs: 2 distinct, 2 entries/);
      assert.match(a.out, /\[urlset, gzip\]/);
      assert.equal(JSON.parse(gunzipSync(await readFile(out)).toString()).stats.uniqueUrlCount, 2);
      const b = io(site());
      await runCli(['fetch', `${O}/sitemap.xml`, '--urls'], b);
      assert.equal(b.out, `${O}/\n${O}/blog/post\n`);
      const c = io(site());
      await runCli(['fetch', `${O}/sitemap.xml`, '--json'], c);
      assert.equal(JSON.parse(c.out).stats.sitemapCount, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parse reads local files, gzip included', async () => {
    const a = io();
    assert.equal(await runCli(['parse', fixturePath('extensions.xml')], a), 0);
    const result = JSON.parse(a.out);
    assert.equal(result.kind, 'urlset');
    assert.equal(result.videoCount, 1);
    const dir = await tempDir();
    try {
      const file = join(dir, 'idx.xml.gz');
      await writeFile(file, gz(fixture('sitemap-index.xml')));
      const b = io();
      await runCli(['parse', file, '--urls'], b);
      assert.equal(b.out.trim().split('\n').length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('snapshot, history and diff work against a store', async () => {
    const dir = await tempDir();
    try {
      const store = join(dir, 'store');
      const a = io(site(), Date.parse('2026-11-01T00:00:00Z'));
      assert.equal(await runCli(['snapshot', `${O}/sitemap.xml`, '--site', 'ex', '--store', store], a), 0);
      assert.match(a.out, /Stored first snapshot/);

      const b = io(site([`${O}/blog/new`]), Date.parse('2026-11-08T00:00:00Z'));
      assert.equal(await runCli(['snapshot', `${O}/sitemap.xml`, '--site', 'ex', '--store', store], b), 0);
      assert.match(b.out, /1 added, 0 removed/);

      const h = io();
      await runCli(['history', '--site', 'ex', '--store', store], h);
      assert.equal(h.out.trim().split('\n').length, 3);
      const sites = io();
      await runCli(['history', '--store', store], sites);
      assert.equal(sites.out, 'ex\n');

      for (const [format, pattern] of [['md', /### Added \(1\)/], ['json', /"added": 1/], ['html', /<!DOCTYPE html>/], ['rss', /<rss version="2.0"/]] as const) {
        const d = io();
        assert.equal(await runCli(['diff', '--site', 'ex', '--store', store, '--format', format], d), 0, d.err);
        assert.match(d.out, pattern);
      }
      const bad = io();
      assert.equal(await runCli(['diff', '--site', 'ex', '--store', store, '--format', 'pdf'], bad), 2);
      const none = io();
      assert.equal(await runCli(['diff', '--site', 'nobody', '--store', store], none), 1);
      assert.match(none.err, /need two snapshots/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('diff compares two snapshot files and writes --output', async () => {
    const dir = await tempDir();
    try {
      const one = join(dir, 'one.json');
      const two = join(dir, 'two.json.gz');
      await runCli(['fetch', `${O}/sitemap.xml`, '--out', one], io(site()));
      await runCli(['fetch', `${O}/sitemap.xml`, '--out', two], io(site([`${O}/x`, `${O}/y`])));
      const out = join(dir, 'diff.md');
      assert.equal(await runCli(['diff', one, two, '-o', out], io()), 0);
      assert.match(await readFile(out, 'utf8'), /2 added/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('validate exits 1 on errors, honouring --fail-on', async () => {
    const mock = (): MockFetch => site([`${O}/tmp/blocked`, { loc: `${O}/bad`, lastmod: 'yesterday' } as never]);
    const a = io(mock());
    assert.equal(await runCli(['validate', `${O}/sitemap.xml`, '--robots'], a), 1);
    assert.match(a.out, /blocked-by-robots/);
    assert.match(a.out, /invalid-lastmod/);
    const b = io(mock());
    assert.equal(await runCli(['validate', `${O}/sitemap.xml`, '--fail-on', 'none', '--json'], b), 0);
    assert.equal(JSON.parse(b.out).counts['invalid-lastmod'], 1);
    const c = io(site());
    assert.equal(await runCli(['validate', `${O}/sitemap.xml`], c), 0);
    const d = io(site());
    assert.equal(await runCli(['validate', `${O}/sitemap.xml`, '--fail-on', 'sometimes'], d), 2);
  });

  it('validate --head checks URLs', async () => {
    const mock = site().on('HEAD', `${O}/`, { status: 200 }).on('HEAD', `${O}/blog/post`, { status: 404 });
    const a = io(mock);
    assert.equal(await runCli(['validate', `${O}/sitemap.xml`, '--head', '--head-rate', '50', '--format', 'json'], a), 1);
    assert.equal(JSON.parse(a.out).counts['http-status'], 1);
  });

  it('watch runs a config file', async () => {
    const dir = await tempDir();
    try {
      const cfg = join(dir, 'watch.json');
      await writeFile(cfg, JSON.stringify({ sites: [{ name: 'ex', sitemaps: [`${O}/sitemap.xml`] }], reports: { formats: ['md'] } }));
      const a = io(site());
      assert.equal(await runCli(['watch', '--config', cfg, '--dry-run'], a), 0, a.err);
      assert.match(a.out, /ex: 2 URLs, first snapshot/);
      const b = io(site([`${O}/n`]));
      assert.equal(await runCli(['watch', '--config', cfg, '--json'], b), 0);
      assert.equal(JSON.parse(b.out)[0].diff.added, 1);
      const c = io();
      assert.equal(await runCli(['watch'], c), 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
