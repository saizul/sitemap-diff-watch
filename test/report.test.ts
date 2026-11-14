import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffSnapshots } from '../src/diff/diff.js';
import { velocityFromHistory, velocityFromLastmod } from '../src/diff/velocity.js';
import { parseSitemapXml } from '../src/parse/sitemap-parser.js';
import { renderHtml } from '../src/report/html.js';
import { renderJson } from '../src/report/json.js';
import { mdEscape, renderMarkdown } from '../src/report/markdown.js';
import { buildReport, type WatchReport } from '../src/report/model.js';
import { renderRss, rssItemsFromDiffs } from '../src/report/rss.js';
import { niceStep, renderLineChart } from '../src/report/svg-chart.js';
import { metaOf } from '../src/snapshot/snapshot.js';
import { validateEntries } from '../src/validate/validate.js';
import { XmlTokenizer } from '../src/xml/tokenizer.js';
import { snap } from './helpers/snapshots.js';

const O = 'https://www.example.com';
const NOW = Date.parse('2026-11-14T12:00:00Z');
const XSS = `${O}/blog/"><script>alert(1)</script>`;

const s1 = snap('example', '2026-11-01T00:00:00.000Z', [`${O}/`, `${O}/blog/old`, `${O}/blog/keep`]);
const s2 = snap('example', '2026-11-08T00:00:00.000Z', [
  `${O}/`,
  { loc: `${O}/blog/keep`, lastmod: '2026-11-07' },
  { loc: `${O}/blog/new-a`, lastmod: '2026-11-06' },
  { loc: `${O}/blog/new-b`, lastmod: '2030-01-01' },
  { loc: `${O}/blog/new-c` },
  { loc: `${O}/news/today`, news: { title: 'Fresh & "quoted" news', publicationDate: '2026-11-07T10:00:00Z', publicationName: 'P', language: 'en' } },
  { loc: XSS },
]);

async function report(): Promise<WatchReport> {
  const diff = diffSnapshots(s1, s2);
  const validation = await validateEntries(s2.urls, { roots: s2.roots, clock: () => NOW });
  return buildReport({
    snapshot: s2,
    previous: s1,
    diff,
    validation,
    velocity: { history: velocityFromHistory([s1, s2]), lastmod: velocityFromLastmod(s2.urls, { now: NOW }) },
    history: [metaOf(s1), metaOf(s2)],
    now: NOW,
  });
}

describe('Markdown report', async () => {
  const md = renderMarkdown(await report(), { maxItems: 3 });

  it('summarises and lists changes', () => {
    assert.match(md, /^# Sitemap report: example/);
    assert.match(md, /\*\*\+4 URLs\*\* \(\+133\.3%\): 5 added, 1 removed, 1 lastmod changes/);
    assert.match(md, /\| `\/blog\/` \| 2 \| 5 \| \+3 \(\+150%\) \|/);
    assert.match(md, /\| `\/blog\/\{slug\}` \| 3 \|/);
    assert.match(md, /### Added \(5\)/);
    assert.match(md, /- \.\.\. and 2 more/);
    assert.match(md, /<https:\/\/www\.example\.com\/blog\/keep>: 2026-11-07|none -> 2026-11-07/);
    assert.match(md, /## Velocity/);
    assert.match(md, /## Validation/);
    assert.match(md, /`future-lastmod`/);
  });

  it('never emits raw HTML from URLs', () => {
    assert.ok(!md.includes('<script>'));
    assert.equal(mdEscape('a|b*c_<d>'), 'a\\|b\\*c\\_\\<d\\>');
  });

  it('handles a first snapshot', () => {
    const first = renderMarkdown(buildReport({ snapshot: s1, now: NOW }));
    assert.match(first, /First snapshot for this site/);
  });
});

describe('HTML report', async () => {
  const html = renderHtml(await report());

  it('is a complete page with an inline SVG chart and no scripts', () => {
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.equal((html.match(/<circle /g) ?? []).length, 2);
    assert.ok(!/<script/i.test(html), 'no script element at all');
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /<meta name="robots" content="noindex">/);
  });

  it('contains the change tables and validation', () => {
    for (const s of ['Sections', 'URL patterns', 'Added', 'Removed', 'Lastmod changed', 'Velocity', 'Validation', 'Sitemaps']) assert.ok(html.includes(s), s);
  });
});

describe('JSON report', async () => {
  const r = await report();
  it('round-trips and can cap lists', () => {
    const full = JSON.parse(renderJson(r));
    assert.equal(full.diff.added.length, 5);
    const capped = JSON.parse(renderJson(r, { maxItems: 2, pretty: false }));
    assert.equal(capped.diff.added.length, 2);
    assert.equal(capped.diff.counts.added, 5);
  });
});

describe('RSS feed', () => {
  const diff = diffSnapshots(s1, s2);
  const items = rssItemsFromDiffs([diff]);

  it('dates items by lastmod or news date, but never after first sight', () => {
    const by = Object.fromEntries(items.map((i) => [i.link, i]));
    assert.equal(by[`${O}/blog/new-a`]!.date, '2026-11-06T00:00:00.000Z');
    assert.equal(by[`${O}/blog/new-b`]!.date, '2026-11-08T00:00:00.000Z', 'future lastmod ignored');
    assert.equal(by[`${O}/blog/new-c`]!.date, '2026-11-08T00:00:00.000Z');
    assert.equal(by[`${O}/news/today`]!.title, 'Fresh & "quoted" news');
    assert.equal(by[`${O}/blog/new-a`]!.title, 'new a');
  });

  it('renders well-formed RSS 2.0, newest first', () => {
    const xml = renderRss(items, { title: 'New URLs: example', link: O, selfUrl: 'https://reports.example.com/example/new-urls.xml', now: NOW, maxItems: 4 });
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<rss version="2.0"/);
    assert.match(xml, /<atom:link href="https:\/\/reports\.example\.com\/example\/new-urls\.xml" rel="self"/);
    assert.equal((xml.match(/<item>/g) ?? []).length, 4);
    assert.match(xml, /<title>Fresh &amp; &quot;quoted&quot; news<\/title>/);
    assert.match(xml, /<pubDate>Sun, 08 Nov 2026 00:00:00 GMT<\/pubDate>/);
    // Parses with our own XML tokenizer.
    const titles: string[] = [];
    let inTitle = false;
    const t = new XmlTokenizer({ open: (e) => (inTitle = e.local === 'title'), close: () => (inTitle = false), text: (x) => void (inTitle && titles.push(x)) });
    t.write(xml);
    t.end();
    assert.equal(titles[0], 'New URLs: example');
    const parsed = parseSitemapXml(xml);
    assert.equal(parsed.summary.kind, 'rss');
    assert.equal(parsed.urls.length, 4);
  });

  it('keeps the first diff an URL appeared in', () => {
    const s3 = snap('example', '2026-11-15T00:00:00.000Z', [...s2.urls.map((u) => u.loc), `${O}/blog/later`]);
    const all = rssItemsFromDiffs([diff, diffSnapshots(s2, s3)]);
    assert.equal(all.length, 6);
    assert.equal(all.find((i) => i.link === `${O}/blog/later`)!.date, '2026-11-15T00:00:00.000Z');
  });
});

describe('SVG chart', () => {
  it('picks nice axis steps', () => {
    assert.equal(niceStep(100), 20);
    assert.equal(niceStep(7), 2);
    assert.equal(niceStep(48_000), 10_000);
    assert.equal(niceStep(0), 1);
  });

  it('draws a line on a time axis', () => {
    const svg = renderLineChart([
      { time: '2026-11-01T00:00:00Z', value: 100 },
      { time: '2026-11-02T00:00:00Z', value: 120 },
      { time: '2026-11-08T00:00:00Z', value: 90 },
    ], { title: 'A <b> title' });
    assert.match(svg, /<title>A &lt;b&gt; title<\/title>/);
    assert.equal((svg.match(/<circle /g) ?? []).length, 3);
    assert.match(svg, />2026-11-01</);
    assert.match(svg, />2026-11-08</);
    const xs = [...svg.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1]));
    assert.ok(xs[1]! - xs[0]! < (xs[2]! - xs[1]!) / 3, 'spacing follows time, not index');
  });

  it('handles a single point and no data', () => {
    assert.match(renderLineChart([{ time: '2026-11-01T00:00:00Z', value: 5 }]), /<circle /);
    assert.match(renderLineChart([]), /No data yet/);
  });
});
