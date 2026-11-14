import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ParseError } from '../src/errors.js';
import { parseSitemapXml } from '../src/parse/sitemap-parser.js';
import { fixture } from './helpers/fixtures.js';

describe('parseSitemapXml: urlset', () => {
  it('reads loc, lastmod, changefreq and priority, decoding entities and CDATA', () => {
    const { summary, urls, warnings } = parseSitemapXml(fixture('urlset-basic.xml'));
    assert.equal(summary.kind, 'urlset');
    assert.equal(summary.urlCount, 5);
    assert.deepEqual(warnings, []);
    assert.deepEqual(urls[0], { loc: 'https://www.example.com/', lastmod: '2026-11-01', changefreq: 'monthly', priority: 0.8 });
    assert.equal(urls[1]!.loc, 'https://www.example.com/catalog?item=12&desc=vacation_hawaii');
    assert.equal(urls[3]!.lastmod, '2026-10-23T18:00:15+00:00');
    assert.equal(urls[4]!.loc, 'https://www.example.com/catalog?item=83&desc=vacation_usa');
  });

  it('keeps non-numeric priority as raw text', () => {
    const { urls } = parseSitemapXml('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.example/</loc><priority>high</priority></url></urlset>');
    assert.deepEqual(urls[0], { loc: 'https://a.example/', priorityRaw: 'high' });
  });
});

describe('parseSitemapXml: sitemap index', () => {
  it('lists child sitemaps with lastmod', () => {
    const { summary, sitemaps, urls } = parseSitemapXml(fixture('sitemap-index.xml'));
    assert.equal(summary.kind, 'sitemapindex');
    assert.equal(summary.sitemapCount, 2);
    assert.equal(urls.length, 0);
    assert.deepEqual(sitemaps[0], { loc: 'https://www.example.com/sitemaps/posts.xml', lastmod: '2026-11-13T04:12:00+00:00' });
  });
});

describe('parseSitemapXml: extensions', () => {
  const { summary, urls } = parseSitemapXml(fixture('extensions.xml'));

  it('counts extension entries', () => {
    assert.equal(summary.imageCount, 2);
    assert.equal(summary.videoCount, 1);
    assert.equal(summary.newsCount, 1);
    assert.equal(summary.alternateCount, 6);
  });

  it('parses image:image', () => {
    assert.deepEqual(urls[0]!.images, [
      { loc: 'https://www.example.com/image.jpg' },
      { loc: 'https://www.example.com/photo.jpg', caption: 'Old-style caption' },
    ]);
  });

  it('parses every video:video field', () => {
    const v = urls[1]!.videos![0]!;
    assert.equal(v.thumbnailLoc, 'https://www.example.com/thumbs/123.jpg');
    assert.equal(v.title, 'Grilling vegetables at home');
    assert.equal(v.contentLoc, 'http://streamserver.example.com/video123.mp4');
    assert.equal(v.playerLoc, 'https://www.example.com/videoplayer.php?video=123');
    assert.equal(v.duration, 600);
    assert.equal(v.rating, 4.2);
    assert.equal(v.viewCount, 12345);
    assert.equal(v.familyFriendly, true);
    assert.equal(v.requiresSubscription, true);
    assert.equal(v.live, false);
    assert.deepEqual(v.restriction, { relationship: 'allow', countries: ['IE', 'GB', 'US', 'CA'] });
    assert.deepEqual(v.platform, { relationship: 'allow', platforms: ['web', 'tv'] });
    assert.equal(v.uploader, 'ExampleKitchen');
    assert.equal(v.uploaderInfo, 'https://www.example.com/users/example-kitchen');
    assert.deepEqual(v.tags, ['grill', 'vegetables']);
    assert.equal(v.publicationDate, '2026-11-05T19:20:30+08:00');
  });

  it('parses news:news', () => {
    assert.deepEqual(urls[2]!.news, {
      publicationName: 'The Example Times',
      language: 'en',
      publicationDate: '2026-11-13',
      title: 'City council approves new park',
    });
  });

  it('parses xhtml:link hreflang alternates', () => {
    assert.deepEqual(urls[3]!.alternates, [
      { hreflang: 'de', href: 'https://www.example.de/deutsch/page.html' },
      { hreflang: 'de-ch', href: 'https://www.example.de/schweiz-deutsch/page.html' },
      { hreflang: 'en', href: 'https://www.example.com/english/page.html' },
    ]);
  });

  it('works with any prefix bound to the extension namespaces', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:i="http://www.google.com/schemas/sitemap-image/1.1">
      <url><loc>https://a.example/</loc><i:image><i:loc>https://a.example/x.png</i:loc></i:image></url></urlset>`;
    assert.deepEqual(parseSitemapXml(xml).urls[0]!.images, [{ loc: 'https://a.example/x.png' }]);
  });

  it('ignores elements from unknown namespaces', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:x="urn:x">
      <url><loc>https://a.example/</loc><x:loc>https://evil.example/</x:loc><x:lastmod>bad</x:lastmod></url></urlset>`;
    assert.deepEqual(parseSitemapXml(xml).urls, [{ loc: 'https://a.example/' }]);
  });
});

describe('parseSitemapXml: feeds', () => {
  it('reads RSS 2.0 items with pubDate as lastmod', () => {
    const { summary, urls } = parseSitemapXml(fixture('rss.xml'));
    assert.equal(summary.kind, 'rss');
    assert.deepEqual(urls, [
      { loc: 'https://www.example.com/blog/first-post', lastmod: '2026-11-13T09:30:00.000Z' },
      { loc: 'https://www.example.com/blog/second-post' },
    ]);
  });

  it('reads Atom entries, preferring rel="alternate" links', () => {
    const { summary, urls } = parseSitemapXml(fixture('atom.xml'));
    assert.equal(summary.kind, 'atom');
    assert.deepEqual(urls, [{ loc: 'https://www.example.com/news/atom-entry', lastmod: '2026-11-13T18:30:02Z' }]);
  });
});

describe('parseSitemapXml: problems', () => {
  it('warns about a missing namespace, undeclared prefixes and entries without loc', () => {
    const { urls, warnings } = parseSitemapXml(fixture('undeclared-prefix.xml'), { source: 'https://www.example.com/s.xml' });
    assert.equal(urls.length, 1);
    assert.deepEqual(urls[0]!.images, [{ loc: 'https://www.example.com/a.jpg' }]);
    assert.deepEqual(warnings.map((w) => w.code).sort(), ['missing-loc', 'undeclared-namespace-image', 'unexpected-namespace']);
    assert.ok(warnings.every((w) => w.sitemap === 'https://www.example.com/s.xml'));
  });

  it('warns about a non-UTF-8 declaration', () => {
    const { warnings } = parseSitemapXml('<?xml version="1.0" encoding="windows-1252"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>');
    assert.deepEqual(warnings.map((w) => w.code), ['non-utf8-encoding']);
  });

  it('warns about invalid xhtml:link and repeated news:news', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
      <url><loc>https://a.example/</loc><xhtml:link rel="canonical" href="https://a.example/"/><news:news/><news:news/></url></urlset>`;
    assert.deepEqual(parseSitemapXml(xml).warnings.map((w) => w.code), ['invalid-alternate', 'multiple-news']);
  });

  it('rejects documents that are not sitemaps', () => {
    assert.throws(() => parseSitemapXml('<html><body>Not found</body></html>'), (e: unknown) => e instanceof ParseError && /root element is <html>/.test(e.message));
  });

  it('rejects malformed XML with a position', () => {
    assert.throws(() => parseSitemapXml(fixture('malformed.xml')), (e: unknown) => e instanceof ParseError && e.line === 5);
  });

  it('warns once when a sitemap has more than 50,000 URLs', () => {
    const body = Array.from({ length: 50_001 }, (_, i) => `<url><loc>https://a.example/${i}</loc></url>`).join('');
    const { summary, warnings } = parseSitemapXml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`);
    assert.equal(summary.urlCount, 50_001);
    assert.deepEqual(warnings.map((w) => w.code), ['too-many-urls']);
  });

  it('warns when a sitemap has more than 1,000 news entries', () => {
    const body = Array.from({ length: 1001 }, (_, i) => `<url><loc>https://a.example/${i}</loc><news:news><news:title>t</news:title></news:news></url>`).join('');
    const { warnings } = parseSitemapXml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${body}</urlset>`);
    assert.deepEqual(warnings.map((w) => w.code), ['too-many-news']);
  });
});
