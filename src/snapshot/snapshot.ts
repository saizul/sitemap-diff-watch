import type { CrawledUrl, CrawlResult, SitemapInfo } from '../fetch/crawler.js';
import type { ParseWarning } from '../types.js';
import { realClock, type ClockFn } from '../types.js';

export const SNAPSHOT_FORMAT = 'sitemap-diff-watch/snapshot';
export const SNAPSHOT_VERSION = 1;

export type SnapshotUrl = CrawledUrl;

export interface SnapshotStats {
  /** Entries, duplicates included. */
  urlCount: number;
  /** Distinct `<loc>` values. */
  uniqueUrlCount: number;
  sitemapCount: number;
  /** Sitemaps that failed to download or parse. */
  errorCount: number;
  imageCount: number;
  videoCount: number;
  newsCount: number;
  alternateCount: number;
  /** Uncompressed bytes downloaded. */
  bytes: number;
}

export interface SnapshotMeta {
  id: string;
  site: string;
  createdAt: string;
  stats: SnapshotStats;
}

export interface Snapshot extends SnapshotMeta {
  format: typeof SNAPSHOT_FORMAT;
  version: number;
  roots: string[];
  sitemaps: SitemapInfo[];
  /** Sorted by `loc`. */
  urls: SnapshotUrl[];
  warnings: ParseWarning[];
}

/** Snapshot id from a timestamp: `20261114T101530123Z`. Sorts chronologically as a string. */
export function snapshotId(time: number): string {
  return new Date(time).toISOString().replace(/[-:.]/g, '');
}

export function computeStats(urls: SnapshotUrl[], sitemaps: SitemapInfo[]): SnapshotStats {
  const unique = new Set<string>();
  let imageCount = 0;
  let videoCount = 0;
  let newsCount = 0;
  let alternateCount = 0;
  for (const u of urls) {
    unique.add(u.loc);
    imageCount += u.images?.length ?? 0;
    videoCount += u.videos?.length ?? 0;
    newsCount += u.news ? 1 : 0;
    alternateCount += u.alternates?.length ?? 0;
  }
  return {
    urlCount: urls.length,
    uniqueUrlCount: unique.size,
    sitemapCount: sitemaps.filter((s) => s.status !== 'skipped').length,
    errorCount: sitemaps.filter((s) => s.status === 'error').length,
    imageCount,
    videoCount,
    newsCount,
    alternateCount,
    bytes: sitemaps.reduce((n, s) => n + s.bytes, 0),
  };
}

/** Turn a crawl into a snapshot. URLs are sorted so stored snapshots diff cleanly in git. */
export function createSnapshot(site: string, crawl: CrawlResult, options: { clock?: ClockFn; id?: string } = {}): Snapshot {
  const time = Date.parse(crawl.finishedAt) || (options.clock ?? realClock)();
  const urls = [...crawl.urls].sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : a.sitemap < b.sitemap ? -1 : a.sitemap > b.sitemap ? 1 : 0));
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    id: options.id ?? snapshotId(time),
    site,
    createdAt: new Date(time).toISOString(),
    roots: crawl.roots,
    sitemaps: crawl.sitemaps,
    urls,
    warnings: crawl.warnings,
    stats: computeStats(urls, crawl.sitemaps),
  };
}

export function metaOf(snapshot: Snapshot): SnapshotMeta {
  return { id: snapshot.id, site: snapshot.site, createdAt: snapshot.createdAt, stats: snapshot.stats };
}

/** Basic shape check for snapshots read from disk or from another tool. */
export function assertSnapshot(value: unknown): asserts value is Snapshot {
  const v = value as Partial<Snapshot> | null;
  if (!v || typeof v !== 'object' || v.format !== SNAPSHOT_FORMAT || !Array.isArray(v.urls) || typeof v.id !== 'string') {
    throw new TypeError('not a sitemap-diff-watch snapshot');
  }
  if ((v.version ?? 0) > SNAPSHOT_VERSION) throw new TypeError(`snapshot version ${v.version} is newer than this release supports`);
}
