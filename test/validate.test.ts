import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSitemapXml } from '../src/parse/sitemap-parser.js';
import { RobotsCache } from '../src/robots/fetch-robots.js';
import type { UrlEntry } from '../src/types.js';
import { RateLimiter } from '../src/util/concurrency.js';
import { headCheck, spreadSample } from '../src/validate/head-check.js';
import { checkHreflang } from '../src/validate/hreflang.js';
import { validateEntries, type ValidationReport } from '../src/validate/validate.js';
import { fixture } from './helpers/fixtures.js';
import { fakeTime, MockFetch, noSleep } from './helpers/mock-fetch.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const SM = 'https://www.example.com/sitemap.xml';
const clock = (): number => NOW;

function entries(xml: string, sitemap = SM): Array<UrlEntry & { sitemap: string }> {
  return parseSitemapXml(xml).urls.map((u) => ({ ...u, sitemap }));
}

function codesFor(report: ValidationReport, loc: string): string[] {
  return report.issues.filter((i) => i.loc === loc).map((i) => i.code).sort();
}

describe('validateEntries: core rules', async () => {
  const report = await validateEntries(entries(fixture('invalid-entries.xml')), { roots: [SM], clock });
  const W = 'https://www.example.com';

  it('derives the canonical host and protocol from the root sitemap', () => {
    assert.equal(report.canonicalHost, 'www.example.com');
    assert.equal(report.canonicalProtocol, 'https:');
  });

  it('flags duplicates and near-duplicates', () => {
    assert.deepEqual(codesFor(report, `${W}/ok`), ['duplicate-url']);
    assert.deepEqual(codesFor(report, `${W}/ok/`), ['near-duplicate']);
  });

  it('flags http URLs and non-canonical hosts', () => {
    assert.deepEqual(codesFor(report, 'http://www.example.com/insecure'), ['mixed-protocol', 'outside-sitemap-scope']);
    assert.deepEqual(codesFor(report, 'https://example.com/no-www'), ['non-canonical-host', 'outside-sitemap-scope']);
    assert.equal(report.counts['protocol-mix'], 1);
  });

  it('flags invalid and future lastmod, changefreq and priority', () => {
    const bad = report.issues.find((i) => i.loc === `${W}/bad-date`)!;
    assert.equal(bad.code, 'invalid-lastmod');
    assert.equal(bad.severity, 'error');
    assert.match(bad.message, /"T", not a space/);
    assert.deepEqual(codesFor(report, `${W}/future`), ['future-lastmod']);
    assert.deepEqual(codesFor(report, `${W}/bad-freq`), ['invalid-changefreq', 'invalid-priority']);
  });

  it('flags relative, unencoded and fragment URLs', () => {
    assert.deepEqual(codesFor(report, '/relative/path'), ['invalid-url']);
    assert.deepEqual(codesFor(report, `${W}/with space`), ['unencoded-url']);
    assert.deepEqual(codesFor(report, `${W}/frag#section`), ['url-has-fragment']);
  });

  it('summarises by severity', () => {
    assert.equal(report.urlCount, 11);
    assert.equal(report.bySeverity.error, report.issues.filter((i) => i.severity === 'error').length);
    assert.ok(report.bySeverity.error >= 2);
  });

  it('accepts a clean sitemap without issues', async () => {
    const clean = await validateEntries(entries(fixture('urlset-basic.xml')), { roots: [SM], clock });
    assert.deepEqual(clean.issues, []);
  });

  it('honours an explicit canonical host and the future tolerance', async () => {
    const r = await validateEntries([{ loc: 'https://www.example.com/a', lastmod: '2026-11-14T20:00:00Z', sitemap: SM }], { canonicalHost: 'example.com', clock, futureToleranceMs: 0 });
    assert.deepEqual(r.issues.map((i) => i.code).sort(), ['future-lastmod', 'non-canonical-host']);
    const tolerant = await validateEntries([{ loc: 'https://www.example.com/a', lastmod: '2026-11-14T20:00:00Z', sitemap: SM }], { clock });
    assert.deepEqual(tolerant.issues, []);
  });

  it('checks the sitemaps.org location rule', async () => {
    const r = await validateEntries(
      [
        { loc: 'https://www.example.com/catalog/a', sitemap: 'https://www.example.com/catalog/sitemap.xml' },
        { loc: 'https://www.example.com/images/b', sitemap: 'https://www.example.com/catalog/sitemap.xml' },
      ],
      { clock },
    );
    assert.deepEqual(r.issues.map((i) => [i.code, i.loc]), [['outside-sitemap-scope', 'https://www.example.com/images/b']]);
    assert.deepEqual((await validateEntries([{ loc: 'https://www.example.com/images/b', sitemap: 'https://www.example.com/catalog/sitemap.xml' }], { clock, checkScope: false })).issues, []);
  });

  it('flags URLs of 2,048 characters or more', async () => {
    const r = await validateEntries([{ loc: `https://www.example.com/${'a'.repeat(2030)}`, sitemap: SM }], { clock });
    assert.deepEqual(r.issues.map((i) => i.code), ['url-too-long']);
  });

  it('caps stored issues per code but keeps exact counts', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ loc: `http://www.example.com/${i}`, sitemap: 'http://www.example.com/s.xml' }));
    const r = await validateEntries(many, { clock, canonicalProtocol: 'https:', maxIssuesPerCode: 5 });
    assert.equal(r.counts['mixed-protocol'], 50);
    assert.equal(r.issues.filter((i) => i.code === 'mixed-protocol').length, 5);
  });

  it('turns crawl warnings into sitemap-level issues', async () => {
    const r = await validateEntries([], { clock, warnings: [{ code: 'too-many-urls', message: 'x', sitemap: SM }, { code: 'nested-index', message: 'y' }, { code: 'something-new', message: 'z' }] });
    assert.deepEqual(r.issues.map((i) => [i.code, i.severity]), [['too-many-urls', 'error'], ['nested-index', 'warning'], ['something-new', 'warning']]);
  });
});

describe('validateEntries: extensions', () => {
  it('accepts the sample image, video, news and hreflang entries', async () => {
    const r = await validateEntries(entries(fixture('extensions.xml')), { clock, checkScope: false, canonicalHost: 'www.example.com' });
    const codes = new Set(r.issues.map((i) => i.code));
    assert.ok(!codes.has('video-missing-field'));
    assert.ok(!codes.has('news-missing-field'));
    assert.ok(!codes.has('hreflang-missing-return'), 'the English and German pages link to each other');
    assert.ok(!codes.has('hreflang-missing-self'));
  });

  it('checks video rules', async () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"><url><loc>https://www.example.com/v</loc>
      <video:video><video:title>t</video:title><video:duration>0</video:duration><video:rating>7</video:rating>
      <video:description>${'d'.repeat(2049)}</video:description><video:publication_date>2026/11/01</video:publication_date>
      <video:restriction relationship="maybe">US</video:restriction>${'<video:tag>x</video:tag>'.repeat(33)}</video:video>
      <video:video><video:thumbnail_loc>/t.jpg</video:thumbnail_loc><video:title>t</video:title><video:description>d</video:description><video:content_loc>https://www.example.com/v</video:content_loc><video:duration>PT10M</video:duration></video:video></url></urlset>`;
    const r = await validateEntries(entries(xml), { clock });
    assert.deepEqual([...new Set(r.issues.map((i) => i.code))].sort(), [
      'video-description-too-long',
      'video-invalid-date',
      'video-invalid-duration',
      'video-invalid-rating',
      'video-invalid-relationship',
      'video-invalid-url',
      'video-missing-field',
      'video-too-many-tags',
    ]);
    assert.match(r.issues.find((i) => i.code === 'video-missing-field')!.message, /thumbnail_loc, content_loc or player_loc/);
  });

  it('checks news rules, including the two-day window', async () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
      <url><loc>https://www.example.com/old</loc><news:news><news:publication><news:name>P</news:name><news:language>en</news:language></news:publication><news:publication_date>2026-11-01</news:publication_date><news:title>Old</news:title></news:news></url>
      <url><loc>https://www.example.com/bad</loc><news:news><news:publication><news:language>english</news:language></news:publication><news:publication_date>14 Nov 2026</news:publication_date></news:news></url>
      <url><loc>https://www.example.com/fresh</loc><news:news><news:publication><news:name>P</news:name><news:language>zh-cn</news:language></news:publication><news:publication_date>2026-11-14T08:00:00+06:00</news:publication_date><news:title>Fresh</news:title></news:news></url></urlset>`;
    const r = await validateEntries(entries(xml), { clock });
    assert.deepEqual(codesFor(r, 'https://www.example.com/old'), ['news-too-old']);
    assert.deepEqual(codesFor(r, 'https://www.example.com/bad'), ['news-invalid-date', 'news-invalid-language', 'news-missing-field']);
    assert.deepEqual(codesFor(r, 'https://www.example.com/fresh'), []);
  });

  it('checks hreflang codes, self references, conflicts and return links', async () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
      <url><loc>https://www.example.com/en</loc>
        <xhtml:link rel="alternate" hreflang="en" href="https://www.example.com/en"/>
        <xhtml:link rel="alternate" hreflang="bn-BD" href="https://www.example.com/bn"/>
        <xhtml:link rel="alternate" hreflang="en-UK" href="https://www.example.com/uk"/>
        <xhtml:link rel="alternate" hreflang="en_US" href="/us"/>
      </url>
      <url><loc>https://www.example.com/bn</loc>
        <xhtml:link rel="alternate" hreflang="bn-BD" href="https://www.example.com/bn"/>
        <xhtml:link rel="alternate" hreflang="x-default" href="https://www.example.com/"/>
        <xhtml:link rel="alternate" hreflang="x-default" href="https://www.example.com/other"/>
      </url>
      <url><loc>https://www.example.com/fr</loc>
        <xhtml:link rel="alternate" hreflang="en" href="https://www.example.com/en"/>
      </url></urlset>`;
    const r = await validateEntries(entries(xml), { clock });
    // /en lists /bn, but /bn does not list /en back.
    assert.deepEqual(codesFor(r, 'https://www.example.com/en'), ['hreflang-invalid-code', 'hreflang-invalid-code', 'hreflang-missing-return', 'hreflang-relative-href']);
    assert.deepEqual(codesFor(r, 'https://www.example.com/bn'), ['hreflang-conflict']);
    assert.deepEqual(codesFor(r, 'https://www.example.com/fr'), ['hreflang-missing-return', 'hreflang-missing-self']);
  });

  it('validates hreflang values', () => {
    for (const ok of ['en', 'EN-gb', 'de-CH', 'zh-Hant', 'zh-Hant-TW', 'es-419', 'x-default', 'fil']) assert.ok(checkHreflang(ok).valid, ok);
    for (const bad of ['en_US', 'english', 'en-UK', 'US-', '']) assert.equal(checkHreflang(bad).valid, false, bad);
  });

  it('flags too many images and bad image URLs', async () => {
    const images = Array.from({ length: 1001 }, (_, i) => ({ loc: `https://www.example.com/${i}.jpg` }));
    images.push({ loc: 'img.jpg' });
    const r = await validateEntries([{ loc: 'https://www.example.com/g', images, sitemap: SM }], { clock });
    assert.deepEqual(r.issues.map((i) => i.code).sort(), ['invalid-image-loc', 'too-many-images']);
  });
});

describe('validateEntries: robots.txt', () => {
  it('flags URLs blocked for the chosen user agent', async () => {
    const mock = new MockFetch().get('https://www.example.com/robots.txt', fixture('robots.txt'), { 'content-type': 'text/plain' });
    const urls = ['https://www.example.com/private/a', 'https://www.example.com/search', 'https://www.example.com/ok'].map((loc) => ({ loc, sitemap: SM }));
    const google = await validateEntries(urls, { clock, robots: new RobotsCache({ fetch: mock.fetch }, 'Googlebot') });
    assert.deepEqual(google.issues.map((i) => [i.code, i.loc]), [['blocked-by-robots', 'https://www.example.com/search']]);
    assert.match(google.issues[0]!.message, /Disallow: \/search/);
    const other = await validateEntries(urls, { clock, robots: new RobotsCache({ fetch: mock.fetch }, 'OtherBot') });
    assert.deepEqual(other.issues.map((i) => i.loc), ['https://www.example.com/private/a']);
  });

  it('reports an unreachable robots.txt once', async () => {
    const mock = new MockFetch().get('https://www.example.com/robots.txt', 'err', {}, 500);
    const urls = ['https://www.example.com/a', 'https://www.example.com/b'].map((loc) => ({ loc, sitemap: SM }));
    const r = await validateEntries(urls, { clock, robots: new RobotsCache({ fetch: mock.fetch, sleep: noSleep }) });
    assert.deepEqual(r.issues.map((i) => i.code), ['robots-unreachable']);
  });
});

describe('HEAD checks', () => {
  it('reports redirects, errors, failures and noindex headers', async () => {
    const mock = new MockFetch()
      .on('HEAD', 'https://www.example.com/ok', { status: 200 })
      .on('HEAD', 'https://www.example.com/moved', { status: 301, headers: { location: '/new' } })
      .on('HEAD', 'https://www.example.com/gone', { status: 410 })
      .on('HEAD', 'https://www.example.com/down', new Error('ECONNRESET'))
      .on('HEAD', 'https://www.example.com/hidden', { status: 200, headers: { 'x-robots-tag': 'noindex, nofollow' } })
      .on('HEAD', 'https://www.example.com/nohead', { status: 405 })
      .on('GET', 'https://www.example.com/nohead', { status: 200, body: 'hello' });
    const urls = ['ok', 'moved', 'gone', 'down', 'hidden', 'nohead'].map((p) => ({ loc: `https://www.example.com/${p}`, sitemap: SM }));
    const time = fakeTime(NOW);
    const r = await validateEntries(urls, { clock: time.clock, head: { http: { fetch: mock.fetch, retries: 0 }, sleep: time.sleep, ratePerSecond: 10 } });
    const by = (code: string): string[] => r.issues.filter((i) => i.code === code).map((i) => i.loc!.replace('https://www.example.com/', ''));
    assert.deepEqual(by('http-redirect'), ['moved']);
    assert.match(r.issues.find((i) => i.code === 'http-redirect')!.message, /to https:\/\/www\.example\.com\/new/);
    assert.deepEqual(by('http-status'), ['gone']);
    assert.deepEqual(by('http-failed'), ['down']);
    assert.deepEqual(by('noindex-header'), ['hidden']);
    assert.equal(r.head!.find((h) => h.loc.endsWith('nohead'))!.method, 'GET');
    assert.ok(mock.calls.every((c) => c.method === 'HEAD' || c.url.endsWith('nohead')));
  });

  it('rate limits requests', async () => {
    const mock = new MockFetch().on('HEAD', /./, { status: 200 });
    const time = fakeTime();
    const start = time.clock();
    await headCheck(Array.from({ length: 5 }, (_, i) => `https://a.example/${i}`), { http: { fetch: mock.fetch }, ratePerSecond: 2, concurrency: 5, clock: time.clock, sleep: time.sleep });
    assert.equal(mock.calls.length, 5);
    assert.equal(time.clock() - start, 2000, '5 requests at 2/s start over 2 seconds');
  });

  it('samples long lists evenly', () => {
    assert.deepEqual(spreadSample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5), [0, 2, 4, 6, 8]);
    assert.deepEqual(spreadSample([1, 2], 5), [1, 2]);
  });

  it('RateLimiter rejects a zero rate', () => {
    assert.throws(() => new RateLimiter(0), RangeError);
  });
});
