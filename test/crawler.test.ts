import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crawlSitemaps } from '../src/fetch/crawler.js';
import { discoverSitemaps } from '../src/fetch/discover.js';
import { fixture, gz, sitemapIndex, urlset } from './helpers/fixtures.js';
import { MockFetch, noSleep } from './helpers/mock-fetch.js';

const ORIGIN = 'https://www.example.com';

function site(): MockFetch {
  return new MockFetch()
    .get(`${ORIGIN}/sitemap_index.xml`, sitemapIndex([`${ORIGIN}/sitemaps/posts.xml`, `${ORIGIN}/sitemaps/pages.xml.gz`]))
    .get(`${ORIGIN}/sitemaps/posts.xml`, urlset([`${ORIGIN}/blog/a`, `${ORIGIN}/blog/b`, { loc: `${ORIGIN}/blog/c`, lastmod: '2026-11-10' }]))
    .get(`${ORIGIN}/sitemaps/pages.xml.gz`, gz(urlset([`${ORIGIN}/`, `${ORIGIN}/about`])), { 'content-type': 'application/x-gzip' });
}

describe('crawlSitemaps', () => {
  it('follows a sitemap index and reads gzip children', async () => {
    const mock = site();
    const result = await crawlSitemaps(`${ORIGIN}/sitemap_index.xml`, { http: { fetch: mock.fetch } });
    assert.equal(result.urls.length, 5);
    assert.equal(result.sitemaps.length, 3);
    const index = result.sitemaps.find((s) => s.url.endsWith('index.xml'))!;
    assert.equal(index.kind, 'sitemapindex');
    assert.equal(index.sitemapCount, 2);
    const pages = result.sitemaps.find((s) => s.url.endsWith('.gz'))!;
    assert.equal(pages.gzip, true);
    assert.equal(pages.parent, `${ORIGIN}/sitemap_index.xml`);
    assert.equal(pages.depth, 1);
    assert.equal(result.urls.find((u) => u.loc === `${ORIGIN}/blog/c`)!.sitemap, `${ORIGIN}/sitemaps/posts.xml`);
    assert.deepEqual(result.warnings, []);
    assert.match(mock.calls[0]!.headers['accept']!, /application\/xml/);
  });

  it('records failed children and keeps going', async () => {
    const mock = new MockFetch()
      .get(`${ORIGIN}/index.xml`, sitemapIndex([`${ORIGIN}/ok.xml`, `${ORIGIN}/missing.xml`, `${ORIGIN}/broken.xml`, `${ORIGIN}/html.xml`]))
      .get(`${ORIGIN}/ok.xml`, urlset([`${ORIGIN}/a`]))
      .get(`${ORIGIN}/broken.xml`, '<urlset><url><loc>x</loc></urlset>')
      .get(`${ORIGIN}/html.xml`, '<!doctype html><html><body>Soft 404</body></html>', { 'content-type': 'text/html' });
    const result = await crawlSitemaps(`${ORIGIN}/index.xml`, { http: { fetch: mock.fetch, sleep: noSleep } });
    const byUrl = Object.fromEntries(result.sitemaps.map((s) => [s.url.replace(ORIGIN, ''), s]));
    assert.equal(byUrl['/ok.xml']!.status, 'ok');
    assert.equal(byUrl['/missing.xml']!.status, 'error');
    assert.equal(byUrl['/missing.xml']!.httpStatus, 404);
    assert.match(byUrl['/broken.xml']!.error!, /mismatched closing tag/);
    assert.match(byUrl['/html.xml']!.error!, /root element is <html>/);
    assert.equal(result.urls.length, 1);
    assert.equal(result.warnings.filter((w) => w.code === 'sitemap-error').length, 3);
  });

  it('detects cycles and duplicate listings', async () => {
    const mock = new MockFetch()
      .get(`${ORIGIN}/a.xml`, sitemapIndex([`${ORIGIN}/b.xml`, `${ORIGIN}/b.xml#dup`]))
      .get(`${ORIGIN}/b.xml`, sitemapIndex([`${ORIGIN}/a.xml`]));
    const result = await crawlSitemaps(`${ORIGIN}/a.xml`, { http: { fetch: mock.fetch } });
    assert.equal(mock.calls.length, 2);
    assert.equal(result.warnings.filter((w) => w.code === 'duplicate-sitemap').length, 2);
    assert.ok(result.warnings.some((w) => w.code === 'nested-index'));
  });

  it('honours maxDepth and maxSitemaps', async () => {
    const mock = new MockFetch()
      .get(`${ORIGIN}/0.xml`, sitemapIndex([`${ORIGIN}/1.xml`]))
      .get(`${ORIGIN}/1.xml`, sitemapIndex([`${ORIGIN}/2.xml`]))
      .get(`${ORIGIN}/2.xml`, urlset([`${ORIGIN}/deep`]));
    const shallow = await crawlSitemaps(`${ORIGIN}/0.xml`, { http: { fetch: mock.fetch }, maxDepth: 1 });
    assert.equal(shallow.urls.length, 0);
    assert.equal(shallow.sitemaps.find((s) => s.url.endsWith('2.xml'))!.status, 'skipped');

    const many = new MockFetch().get(`${ORIGIN}/i.xml`, sitemapIndex(Array.from({ length: 10 }, (_, i) => `${ORIGIN}/s${i}.xml`))).on('GET', /\/s\d\.xml$/, { body: urlset([`${ORIGIN}/x`]) });
    const capped = await crawlSitemaps(`${ORIGIN}/i.xml`, { http: { fetch: many.fetch }, maxSitemaps: 4 });
    assert.equal(capped.sitemaps.length, 4);
    assert.ok(capped.warnings.some((w) => w.code === 'max-sitemaps'));
  });

  it('warns about child sitemaps on another host', async () => {
    const mock = new MockFetch()
      .get(`${ORIGIN}/index.xml`, sitemapIndex(['https://cdn.example.net/s.xml']))
      .get('https://cdn.example.net/s.xml', urlset([`${ORIGIN}/a`]));
    const result = await crawlSitemaps(`${ORIGIN}/index.xml`, { http: { fetch: mock.fetch } });
    assert.ok(result.warnings.some((w) => w.code === 'cross-host-sitemap'));
    assert.equal(result.urls.length, 1);
  });

  it('limits parallel downloads', async () => {
    let active = 0;
    let peak = 0;
    const children = Array.from({ length: 12 }, (_, i) => `${ORIGIN}/c${i}.xml`);
    const mock = new MockFetch().get(`${ORIGIN}/index.xml`, sitemapIndex(children)).on('GET', /\/c\d+\.xml$/, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { body: urlset([`${ORIGIN}/p`]) };
    });
    const result = await crawlSitemaps(`${ORIGIN}/index.xml`, { http: { fetch: mock.fetch }, concurrency: 3 });
    assert.equal(result.sitemaps.length, 13);
    assert.ok(peak <= 3, `peak ${peak}`);
    assert.ok(peak >= 2);
  });

  it('streams entries to onUrl without keeping them', async () => {
    const seen: string[] = [];
    const result = await crawlSitemaps(`${ORIGIN}/sitemap_index.xml`, { http: { fetch: site().fetch }, keepUrls: false, onUrl: (u) => seen.push(u.loc) });
    assert.equal(seen.length, 5);
    assert.equal(result.urls.length, 0);
  });

  it('can filter child sitemaps', async () => {
    const result = await crawlSitemaps(`${ORIGIN}/sitemap_index.xml`, { http: { fetch: site().fetch }, filterSitemap: (u) => u.includes('posts') });
    assert.equal(result.urls.length, 3);
  });

  it('warns about an empty root sitemap and rejects bad input', async () => {
    const mock = new MockFetch().get(`${ORIGIN}/empty.xml`, urlset([]).replace(/<url>.*<\/url>/, ''));
    const result = await crawlSitemaps(`${ORIGIN}/empty.xml`, { http: { fetch: mock.fetch } });
    assert.ok(result.warnings.some((w) => w.code === 'empty-sitemap'));
    await assert.rejects(crawlSitemaps([], {}), /at least one/);
    await assert.rejects(crawlSitemaps('ftp://x.example/s.xml', {}), /not an http/);
  });

  it('reads RSS feeds and text sitemaps listed in an index', async () => {
    const mock = new MockFetch()
      .get(`${ORIGIN}/index.xml`, sitemapIndex([`${ORIGIN}/feed.xml`, `${ORIGIN}/urls.txt`]))
      .get(`${ORIGIN}/feed.xml`, fixture('rss.xml'))
      .get(`${ORIGIN}/urls.txt`, fixture('text-sitemap.txt'), { 'content-type': 'text/plain' });
    const result = await crawlSitemaps(`${ORIGIN}/index.xml`, { http: { fetch: mock.fetch } });
    assert.equal(result.urls.length, 5);
    assert.deepEqual(result.sitemaps.map((s) => s.kind).sort(), ['rss', 'sitemapindex', 'text']);
  });
});

describe('discoverSitemaps', () => {
  it('uses the Sitemap: lines of robots.txt', async () => {
    const mock = new MockFetch().get(`${ORIGIN}/robots.txt`, fixture('robots.txt'), { 'content-type': 'text/plain' });
    const r = await discoverSitemaps(`${ORIGIN}/any/page`, { fetch: mock.fetch });
    assert.equal(r.source, 'robots');
    assert.deepEqual(r.sitemaps, [`${ORIGIN}/sitemap_index.xml`, `${ORIGIN}/news-sitemap.xml`]);
  });

  it('probes common locations when robots.txt has none, skipping HTML answers', async () => {
    const mock = new MockFetch()
      .get(`${ORIGIN}/robots.txt`, 'User-agent: *\nDisallow:\n', { 'content-type': 'text/plain' })
      .get(`${ORIGIN}/sitemap.xml`, '<html>soft 404</html>', { 'content-type': 'text/html; charset=utf-8' })
      .get(`${ORIGIN}/sitemap_index.xml`, sitemapIndex([]));
    const r = await discoverSitemaps(ORIGIN, { fetch: mock.fetch });
    assert.equal(r.source, 'probe');
    assert.deepEqual(r.sitemaps, [`${ORIGIN}/sitemap_index.xml`]);
  });

  it('reports none found', async () => {
    const mock = new MockFetch();
    const r = await discoverSitemaps(ORIGIN, { fetch: mock.fetch, sleep: noSleep });
    assert.equal(r.source, 'none');
    assert.equal(r.robots.status, 'unavailable');
    const noProbe = await discoverSitemaps(ORIGIN, { fetch: mock.fetch, probe: false });
    assert.equal(noProbe.source, 'none');
  });
});
