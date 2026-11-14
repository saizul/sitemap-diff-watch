import type { SnapshotDiff } from '../diff/diff.js';
import type { Velocity } from '../diff/velocity.js';
import type { SitemapInfo } from '../fetch/crawler.js';
import type { Snapshot, SnapshotMeta } from '../snapshot/snapshot.js';
import type { ValidationReport } from '../validate/validate.js';
import { VERSION } from '../version.js';

/** Everything a report shows, independent of the output format. */
export interface WatchReport {
  tool: string;
  generatedAt: string;
  site: string;
  roots: string[];
  snapshot: SnapshotMeta;
  previous?: SnapshotMeta;
  diff?: SnapshotDiff;
  validation?: ValidationReport;
  velocity?: { history?: Velocity; lastmod?: Velocity };
  /** Snapshot metadata over time, oldest first, for the URL count chart. */
  history: SnapshotMeta[];
  sitemaps: SitemapInfo[];
}

export interface BuildReportInput {
  snapshot: Snapshot;
  previous?: Snapshot | undefined;
  diff?: SnapshotDiff | undefined;
  validation?: ValidationReport | undefined;
  velocity?: { history?: Velocity; lastmod?: Velocity } | undefined;
  history?: SnapshotMeta[] | undefined;
  now?: number;
}

export function buildReport(input: BuildReportInput): WatchReport {
  const meta = (s: Snapshot): SnapshotMeta => ({ id: s.id, site: s.site, createdAt: s.createdAt, stats: s.stats });
  return {
    tool: `sitemap-diff-watch ${VERSION}`,
    generatedAt: new Date(input.now ?? Date.now()).toISOString(),
    site: input.snapshot.site,
    roots: input.snapshot.roots,
    snapshot: meta(input.snapshot),
    ...(input.previous ? { previous: meta(input.previous) } : {}),
    ...(input.diff ? { diff: input.diff } : {}),
    ...(input.validation ? { validation: input.validation } : {}),
    ...(input.velocity ? { velocity: input.velocity } : {}),
    history: input.history ?? [meta(input.snapshot)],
    sitemaps: input.snapshot.sitemaps,
  };
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function signed(n: number): string {
  return n > 0 ? `+${formatNumber(n)}` : formatNumber(n);
}

export function pct(value: number | null): string {
  if (value === null) return 'new';
  return `${value > 0 ? '+' : ''}${value}%`;
}
