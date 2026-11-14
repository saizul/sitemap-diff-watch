import type { CrawledUrl, CrawlResult } from '../../src/fetch/crawler.js';
import { createSnapshot, type Snapshot } from '../../src/snapshot/snapshot.js';

export const SITEMAP = 'https://www.example.com/sitemap.xml';

/** Build a snapshot directly from URL entries, as if crawled at `time`. */
export function snap(site: string, time: string, urls: Array<string | Partial<CrawledUrl> & { loc: string }>, sitemap = SITEMAP): Snapshot {
  const entries: CrawledUrl[] = urls.map((u) => (typeof u === 'string' ? { loc: u, sitemap } : { sitemap, ...u }));
  const crawl: CrawlResult = {
    roots: [sitemap],
    startedAt: time,
    finishedAt: time,
    sitemaps: [{ url: sitemap, depth: 0, status: 'ok', kind: 'urlset', urlCount: entries.length, sitemapCount: 0, bytes: 1000, compressedBytes: 1000, gzip: false, durationMs: 1 }],
    urls: entries,
    warnings: [],
  };
  return createSnapshot(site, crawl);
}
