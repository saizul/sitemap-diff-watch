import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clusterUrls, segmentToken } from '../src/diff/clusters.js';
import { diffSnapshots, isEmptyDiff } from '../src/diff/diff.js';
import { countSections, sectionGrowth } from '../src/diff/sections.js';
import { velocityFromHistory, velocityFromLastmod } from '../src/diff/velocity.js';
import { pathSection } from '../src/util/url.js';
import { snap } from './helpers/snapshots.js';

const O = 'https://www.example.com';

describe('diffSnapshots', () => {
  const before = snap('s', '2026-11-01T00:00:00Z', [
    { loc: `${O}/`, lastmod: '2026-10-01' },
    { loc: `${O}/blog/old-post`, lastmod: '2026-01-01' },
    { loc: `${O}/blog/kept`, lastmod: '2026-10-01T00:00:00Z', changefreq: 'weekly' },
    { loc: `${O}/same-instant`, lastmod: '2026-10-01T06:00:00+06:00' },
    { loc: `${O}/moved`, sitemap: `${O}/a.xml` },
    { loc: `${O}/img`, images: [{ loc: `${O}/1.jpg` }] },
    { loc: `${O}/dup` },
    { loc: `${O}/dup` },
  ]);
  const after = snap('s', '2026-11-08T00:00:00Z', [
    { loc: `${O}/`, lastmod: '2026-11-07' },
    { loc: `${O}/blog/kept`, lastmod: '2026-10-01T00:00:00Z', changefreq: 'daily' },
    { loc: `${O}/same-instant`, lastmod: '2026-10-01T00:00:00Z' },
    { loc: `${O}/blog/new-1` },
    { loc: `${O}/blog/new-2` },
    { loc: `${O}/blog/new-3` },
    { loc: `${O}/moved`, sitemap: `${O}/b.xml` },
    { loc: `${O}/img`, images: [{ loc: `${O}/2.jpg` }] },
    { loc: `${O}/dup` },
  ]);
  const d = diffSnapshots(before, after);

  it('finds added and removed URLs', () => {
    assert.deepEqual(d.added.map((u) => u.loc), [`${O}/blog/new-1`, `${O}/blog/new-2`, `${O}/blog/new-3`]);
    assert.deepEqual(d.removed.map((u) => u.loc), [`${O}/blog/old-post`]);
  });

  it('compares lastmod as instants, not strings', () => {
    assert.deepEqual(d.lastmodChanged, [{ loc: `${O}/`, before: '2026-10-01', after: '2026-11-07' }]);
  });

  it('finds metadata changes and moves between sitemaps', () => {
    assert.deepEqual(d.metadataChanged, [
      { loc: `${O}/blog/kept`, fields: ['changefreq'] },
      { loc: `${O}/img`, fields: ['images'] },
    ]);
    assert.deepEqual(d.moved, [{ loc: `${O}/moved`, from: `${O}/a.xml`, to: `${O}/b.xml` }]);
  });

  it('counts distinct URLs', () => {
    assert.deepEqual(d.counts, { before: 7, after: 9, added: 3, removed: 1, lastmodChanged: 1, metadataChanged: 2, moved: 1, net: 2, growthPct: 28.6 });
    assert.equal(isEmptyDiff(d), false);
    assert.equal(isEmptyDiff(diffSnapshots(after, after)), true);
  });

  it('reports section growth and patterns of added URLs', () => {
    assert.deepEqual(d.sections, [{ section: '/blog/', before: 2, after: 4, delta: 2, pct: 100 }]);
    assert.deepEqual(d.addedClusters.map((c) => [c.pattern, c.count]), [['/blog/{slug}', 3]]);
  });

  it('handles an empty previous snapshot', () => {
    const empty = snap('s', '2026-10-01T00:00:00Z', []);
    const x = diffSnapshots(empty, after);
    assert.equal(x.counts.growthPct, null);
    assert.equal(x.counts.added, 9);
  });
});

describe('sections', () => {
  it('maps URLs to directories', () => {
    assert.equal(pathSection(`${O}/blog/2026/post`), '/blog/');
    assert.equal(pathSection(`${O}/blog/2026/post`, 2), '/blog/2026/');
    assert.equal(pathSection(`${O}/about`), '/');
    assert.equal(pathSection(`${O}/blog/`), '/blog/');
    assert.equal(pathSection(`${O}/`), '/');
    assert.equal(pathSection(`${O}/%E0%A6%AC%E0%A6%BE%E0%A6%82%E0%A6%B2%E0%A6%BE/x`), '/বাংলা/');
  });

  it('prefixes hosts when several appear', () => {
    const counts = countSections([`${O}/a/1`, 'https://shop.example.com/a/1']);
    assert.deepEqual([...counts.keys()].sort(), ['shop.example.com/a/', 'www.example.com/a/']);
  });

  it('computes growth, sorted by size of change', () => {
    const g = sectionGrowth([`${O}/a/1`, `${O}/a/2`, `${O}/b/1`], [`${O}/a/1`, `${O}/b/1`, `${O}/b/2`, `${O}/b/3`, `${O}/c/1`]);
    assert.deepEqual(g.map((x) => [x.section, x.delta, x.pct]), [['/b/', 2, 200], ['/a/', -1, -50], ['/c/', 1, null]]);
  });
});

describe('clusterUrls', () => {
  it('recognises ids, dates, uuids and hashes', () => {
    assert.equal(segmentToken('12345'), '{n}');
    assert.equal(segmentToken('2026'), '{yyyy}');
    assert.equal(segmentToken('2026-11-14'), '{date}');
    assert.equal(segmentToken('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), '{uuid}');
    assert.equal(segmentToken('a3f9c0de12b4'), '{hash}');
    assert.equal(segmentToken('123-blue-shoes'), '{n}-{slug}');
    assert.equal(segmentToken('blue-shoes-98765'), '{slug}-{n}');
    assert.equal(segmentToken('987.html'), '{n}.html');
    assert.equal(segmentToken('about'), 'about');
  });

  it('folds high-variety segments into {slug} and keeps fixed ones', () => {
    const urls = [
      `${O}/blog/how-to-a`,
      `${O}/blog/how-to-b`,
      `${O}/blog/c`,
      `${O}/product/123`,
      `${O}/product/456`,
      `${O}/news/2026/11/headline-one`,
      `${O}/news/2026/11/headline-two`,
      `${O}/news/2026/10/headline-three`,
      `${O}/about`,
      `${O}/contact`,
      `${O}/search?q=shoes&page=2`,
    ];
    const clusters = clusterUrls(urls);
    const map = Object.fromEntries(clusters.map((c) => [c.pattern, c.count]));
    assert.equal(map['/blog/{slug}'], 3);
    assert.equal(map['/product/{n}'], 2);
    assert.equal(map['/news/{yyyy}/{n}/{slug}'], 3);
    assert.equal(map['/about'], 1);
    assert.equal(map['/search?page={n}&q={v}'], 1);
    assert.equal(clusters[0]!.examples.length, 3);
  });

  it('needs minVariety distinct values before folding', () => {
    const two = clusterUrls([`${O}/blog/a`, `${O}/blog/b`]);
    assert.equal(two.length, 2);
    const folded = clusterUrls([`${O}/blog/a`, `${O}/blog/b`], { minVariety: 2 });
    assert.deepEqual(folded.map((c) => c.pattern), ['/blog/{slug}']);
  });

  it('keeps trailing slashes and hosts apart', () => {
    const c = clusterUrls([`${O}/t/a/`, `${O}/t/b/`, `${O}/t/c/`, 'https://shop.example.com/t/a/']);
    assert.deepEqual(c.map((x) => x.pattern).sort(), ['shop.example.com/t/a/', 'www.example.com/t/{slug}/']);
  });

  it('limits the number of clusters', () => {
    assert.equal(clusterUrls(Array.from({ length: 30 }, (_, i) => `${O}/p${i}/x/y`), { limit: 5, minVariety: 100 }).length, 5);
  });
});

describe('velocity', () => {
  it('counts first-seen URLs per week across snapshots', () => {
    const s1 = snap('s', '2026-10-05T00:00:00Z', [`${O}/a`]);
    const s2 = snap('s', '2026-10-12T00:00:00Z', [`${O}/a`, `${O}/b`, `${O}/c`]);
    const s3 = snap('s', '2026-10-14T00:00:00Z', [`${O}/a`, `${O}/c`, `${O}/d`]);
    const s4 = snap('s', '2026-10-26T00:00:00Z', [`${O}/a`, `${O}/b`, `${O}/e`]);
    const v = velocityFromHistory([s4, s2, s1, s3], 'week');
    assert.deepEqual(v.series, [
      { period: '2026-10-12', count: 3 },
      { period: '2026-10-19', count: 0 },
      { period: '2026-10-26', count: 1 },
    ]);
    assert.equal(v.total, 4, 'b came back, it is not new');
    assert.equal(v.days, 21);
    assert.equal(v.perDay, 0.19);
    assert.equal(v.perWeek, 1.33);
    assert.equal(velocityFromHistory([s1]).total, 0);
  });

  it('counts URLs by lastmod in a window, ignoring invalid and future dates', () => {
    const now = Date.parse('2026-11-14T12:00:00Z');
    const urls = [
      { loc: `${O}/1`, lastmod: '2026-11-14' },
      { loc: `${O}/2`, lastmod: '2026-11-13T08:00:00Z' },
      { loc: `${O}/3`, lastmod: '2026-11-10' },
      { loc: `${O}/3`, lastmod: '2026-11-10' },
      { loc: `${O}/4`, lastmod: '2026-01-01' },
      { loc: `${O}/5`, lastmod: 'yesterday' },
      { loc: `${O}/6`, lastmod: '2027-01-01' },
      { loc: `${O}/7` },
    ];
    const daily = velocityFromLastmod(urls, { bucket: 'day', windowDays: 7, now });
    assert.equal(daily.total, 3);
    assert.equal(daily.series.length, 8);
    assert.deepEqual(daily.series.slice(-2), [{ period: '2026-11-13', count: 1 }, { period: '2026-11-14', count: 1 }]);
    const weekly = velocityFromLastmod(urls, { now, windowDays: 14 });
    assert.equal(weekly.bucket, 'week');
    assert.deepEqual(weekly.series.map((p) => p.period), ['2026-10-26', '2026-11-02', '2026-11-09']);
    assert.equal(weekly.series[2]!.count, 3);
    assert.equal(weekly.perWeek, 1.5);
  });
});
