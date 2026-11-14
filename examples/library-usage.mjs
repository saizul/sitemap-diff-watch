// Offline tour of the library: parse sitemaps, build two snapshots, diff, validate and
// render reports. Run after `npm run build`:  node examples/library-usage.mjs
import {
  buildReport,
  createSnapshot,
  diffSnapshots,
  parseSitemapXml,
  renderMarkdown,
  renderRss,
  rssItemsFromDiffs,
  validateEntries,
  velocityFromLastmod,
} from '../dist/src/index.js';

const SITEMAP = 'https://www.example.com/sitemap.xml';

function urlset(entries) {
  const body = entries.map(([loc, lastmod]) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`;
}

// What a crawl would return; with real sites use crawlSitemaps(url) instead.
function crawlOf(xml, finishedAt) {
  const { urls, warnings } = parseSitemapXml(xml, { source: SITEMAP });
  return {
    roots: [SITEMAP],
    startedAt: finishedAt,
    finishedAt,
    sitemaps: [{ url: SITEMAP, depth: 0, status: 'ok', kind: 'urlset', urlCount: urls.length, sitemapCount: 0, bytes: xml.length, compressedBytes: xml.length, gzip: false, durationMs: 0 }],
    urls: urls.map((u) => ({ ...u, sitemap: SITEMAP })),
    warnings,
  };
}

const lastWeek = createSnapshot('example', crawlOf(urlset([
  ['https://www.example.com/', '2026-11-01'],
  ['https://www.example.com/blog/hello-world', '2026-10-20'],
  ['https://www.example.com/blog/old-news', '2026-01-05'],
]), '2026-11-07T06:00:00Z'));

const today = createSnapshot('example', crawlOf(urlset([
  ['https://www.example.com/', '2026-11-13'],
  ['https://www.example.com/blog/hello-world', '2026-10-20'],
  ['https://www.example.com/blog/sitemap-tips', '2026-11-10'],
  ['https://www.example.com/blog/hreflang-guide', '2026-11-12'],
  ['http://www.example.com/blog/insecure-link', '2026-11-12 09:00'],
]), '2026-11-14T06:00:00Z'));

const diff = diffSnapshots(lastWeek, today);
console.log(`added ${diff.counts.added}, removed ${diff.counts.removed}, lastmod changed ${diff.counts.lastmodChanged}`);
console.log('patterns of new URLs:', diff.addedClusters.map((c) => `${c.pattern} (${c.count})`).join(', '));

const validation = await validateEntries(today.urls, { roots: today.roots, clock: () => Date.parse('2026-11-14T06:00:00Z') });
for (const issue of validation.issues) console.log(`${issue.severity}: ${issue.code} ${issue.loc ?? ''} - ${issue.message}`);

const report = buildReport({
  snapshot: today,
  previous: lastWeek,
  diff,
  validation,
  velocity: { lastmod: velocityFromLastmod(today.urls, { now: Date.parse('2026-11-14T06:00:00Z') }) },
  history: [lastWeek, today].map(({ id, site, createdAt, stats }) => ({ id, site, createdAt, stats })),
});
console.log(`\n${renderMarkdown(report).split('\n').slice(0, 20).join('\n')}\n...`);
console.log(renderRss(rssItemsFromDiffs([diff]), { title: 'New URLs', link: 'https://www.example.com/' }).split('\n').length, 'lines of RSS');
