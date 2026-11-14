import type { Snapshot, SnapshotUrl } from '../snapshot/snapshot.js';
import { w3cToTime } from '../util/w3c-datetime.js';
import { clusterUrls, type ClusterOptions, type UrlCluster } from './clusters.js';
import { sectionGrowth, type SectionChange, type SectionOptions } from './sections.js';

export interface LastmodChange {
  loc: string;
  before?: string;
  after?: string;
}

export interface MetadataChange {
  loc: string;
  fields: Array<'changefreq' | 'priority' | 'images' | 'videos' | 'news' | 'alternates'>;
}

export interface SitemapMove {
  loc: string;
  from: string;
  to: string;
}

export interface DiffSide {
  id: string;
  createdAt: string;
  urlCount: number;
}

export interface SnapshotDiff {
  site: string;
  from: DiffSide;
  to: DiffSide;
  added: SnapshotUrl[];
  removed: SnapshotUrl[];
  lastmodChanged: LastmodChange[];
  metadataChanged: MetadataChange[];
  /** URLs that moved to a different sitemap file. */
  moved: SitemapMove[];
  sections: SectionChange[];
  addedClusters: UrlCluster[];
  removedClusters: UrlCluster[];
  counts: {
    before: number;
    after: number;
    added: number;
    removed: number;
    lastmodChanged: number;
    metadataChanged: number;
    moved: number;
    net: number;
    /** Percent change in distinct URLs; `null` when the old snapshot was empty. */
    growthPct: number | null;
  };
}

export interface DiffOptions {
  sections?: SectionOptions;
  clusters?: ClusterOptions;
}

function byLoc(urls: SnapshotUrl[]): Map<string, SnapshotUrl> {
  const map = new Map<string, SnapshotUrl>();
  for (const u of urls) if (!map.has(u.loc)) map.set(u.loc, u);
  return map;
}

function sameLastmod(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const ta = w3cToTime(a);
  const tb = w3cToTime(b);
  return ta !== undefined && ta === tb;
}

function stable(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function metadataFields(a: SnapshotUrl, b: SnapshotUrl): MetadataChange['fields'] {
  const fields: MetadataChange['fields'] = [];
  if ((a.changefreq ?? '') !== (b.changefreq ?? '')) fields.push('changefreq');
  if ((a.priority ?? a.priorityRaw) !== (b.priority ?? b.priorityRaw)) fields.push('priority');
  if (stable(a.images?.map((i) => i.loc).sort()) !== stable(b.images?.map((i) => i.loc).sort())) fields.push('images');
  if (stable(a.videos) !== stable(b.videos)) fields.push('videos');
  if (stable(a.news) !== stable(b.news)) fields.push('news');
  const alt = (u: SnapshotUrl): string[] | undefined => u.alternates?.map((x) => `${x.hreflang.toLowerCase()} ${x.href}`).sort();
  if (stable(alt(a)) !== stable(alt(b))) fields.push('alternates');
  return fields;
}

/**
 * Compare two snapshots of the same site: added and removed URLs, lastmod and metadata
 * changes, URLs that moved between sitemap files, per-directory growth and the URL
 * patterns of what was added and removed. Duplicate entries count once.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot, options: DiffOptions = {}): SnapshotDiff {
  const a = byLoc(before.urls);
  const b = byLoc(after.urls);
  const added: SnapshotUrl[] = [];
  const removed: SnapshotUrl[] = [];
  const lastmodChanged: LastmodChange[] = [];
  const metadataChanged: MetadataChange[] = [];
  const moved: SitemapMove[] = [];

  for (const [loc, u] of b) {
    const old = a.get(loc);
    if (!old) {
      added.push(u);
      continue;
    }
    if (!sameLastmod(old.lastmod, u.lastmod)) {
      lastmodChanged.push({ loc, ...(old.lastmod !== undefined ? { before: old.lastmod } : {}), ...(u.lastmod !== undefined ? { after: u.lastmod } : {}) });
    }
    const fields = metadataFields(old, u);
    if (fields.length) metadataChanged.push({ loc, fields });
    if (old.sitemap !== u.sitemap) moved.push({ loc, from: old.sitemap, to: u.sitemap });
  }
  for (const [loc, u] of a) if (!b.has(loc)) removed.push(u);

  const byLocOrder = (x: { loc: string }, y: { loc: string }): number => (x.loc < y.loc ? -1 : x.loc > y.loc ? 1 : 0);
  added.sort(byLocOrder);
  removed.sort(byLocOrder);
  lastmodChanged.sort(byLocOrder);
  metadataChanged.sort(byLocOrder);
  moved.sort(byLocOrder);

  const sections = sectionGrowth(a.keys(), b.keys(), options.sections);
  const changedSections = sections.filter((s) => s.delta !== 0);

  return {
    site: after.site,
    from: { id: before.id, createdAt: before.createdAt, urlCount: a.size },
    to: { id: after.id, createdAt: after.createdAt, urlCount: b.size },
    added,
    removed,
    lastmodChanged,
    metadataChanged,
    moved,
    sections: changedSections,
    addedClusters: clusterUrls(added.map((u) => u.loc), options.clusters),
    removedClusters: clusterUrls(removed.map((u) => u.loc), options.clusters),
    counts: {
      before: a.size,
      after: b.size,
      added: added.length,
      removed: removed.length,
      lastmodChanged: lastmodChanged.length,
      metadataChanged: metadataChanged.length,
      moved: moved.length,
      net: b.size - a.size,
      growthPct: a.size === 0 ? null : Math.round(((b.size - a.size) / a.size) * 1000) / 10,
    },
  };
}

/** True when nothing a report would mention changed. */
export function isEmptyDiff(diff: SnapshotDiff): boolean {
  const c = diff.counts;
  return c.added === 0 && c.removed === 0 && c.lastmodChanged === 0 && c.metadataChanged === 0 && c.moved === 0;
}
