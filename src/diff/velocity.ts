import type { Snapshot } from '../snapshot/snapshot.js';
import { utcDay, utcWeekStart, w3cToTime } from '../util/w3c-datetime.js';

export type VelocityBucket = 'day' | 'week';

export interface VelocityPoint {
  /** `YYYY-MM-DD`: the day, or the Monday that starts the ISO week (UTC). */
  period: string;
  count: number;
}

export interface Velocity {
  bucket: VelocityBucket;
  /** `history`: first seen between snapshots. `lastmod`: `<lastmod>` dates in one snapshot. */
  basis: 'history' | 'lastmod';
  series: VelocityPoint[];
  total: number;
  /** Days covered by the series. */
  days: number;
  perDay: number;
  perWeek: number;
}

const DAY = 86_400_000;

function periodOf(time: number, bucket: VelocityBucket): string {
  return bucket === 'day' ? utcDay(time) : utcWeekStart(time);
}

function fill(counts: Map<string, number>, from: number, to: number, bucket: VelocityBucket): VelocityPoint[] {
  const out: VelocityPoint[] = [];
  const step = bucket === 'day' ? DAY : 7 * DAY;
  const start = Date.parse(`${periodOf(from, bucket)}T00:00:00Z`);
  const end = Date.parse(`${periodOf(to, bucket)}T00:00:00Z`);
  for (let t = start; t <= end; t += step) {
    const period = utcDay(t);
    out.push({ period, count: counts.get(period) ?? 0 });
  }
  return out;
}

function summarise(basis: Velocity['basis'], bucket: VelocityBucket, series: VelocityPoint[], spanMs: number): Velocity {
  const total = series.reduce((n, p) => n + p.count, 0);
  const days = Math.max(1, Math.round(spanMs / DAY));
  const perDay = Math.round((total / days) * 100) / 100;
  const perWeek = Math.round(((total * 7) / days) * 100) / 100;
  return { bucket, basis, series, total, days, perDay, perWeek };
}

/**
 * New URLs per day or week from snapshot history: a URL counts on the date of the first
 * snapshot that contains it. URLs already in the oldest snapshot are the baseline and do
 * not count. Snapshots must belong to one site; order does not matter.
 */
export function velocityFromHistory(snapshots: Snapshot[], bucket: VelocityBucket = 'week'): Velocity {
  const sorted = [...snapshots].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  if (sorted.length < 2) return summarise('history', bucket, [], DAY);
  const seen = new Set(sorted[0]!.urls.map((u) => u.loc));
  const counts = new Map<string, number>();
  for (const snap of sorted.slice(1)) {
    const period = periodOf(Date.parse(snap.createdAt), bucket);
    let added = 0;
    for (const u of snap.urls) {
      if (seen.has(u.loc)) continue;
      seen.add(u.loc);
      added++;
    }
    counts.set(period, (counts.get(period) ?? 0) + added);
  }
  const first = Date.parse(sorted[0]!.createdAt);
  const last = Date.parse(sorted[sorted.length - 1]!.createdAt);
  return summarise('history', bucket, fill(counts, Date.parse(sorted[1]!.createdAt), last, bucket), last - first);
}

export interface LastmodVelocityOptions {
  bucket?: VelocityBucket;
  /** Window length in days, counted back from `now` (default 28 for days, 84 for weeks). */
  windowDays?: number;
  now?: number;
}

/**
 * Publishing or updating pace of a single snapshot, from `<lastmod>`: how many URLs have a
 * lastmod in each day or week of the window. Useful for competitors whose history you have
 * not collected yet. Invalid and future lastmod values are ignored.
 */
export function velocityFromLastmod(urls: Array<{ loc: string; lastmod?: string }>, options: LastmodVelocityOptions = {}): Velocity {
  const bucket = options.bucket ?? 'week';
  const now = options.now ?? Date.now();
  const windowDays = options.windowDays ?? (bucket === 'day' ? 28 : 84);
  const from = now - windowDays * DAY;
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const u of urls) {
    if (seen.has(u.loc)) continue;
    seen.add(u.loc);
    const t = w3cToTime(u.lastmod);
    if (t === undefined || t > now || t < from) continue;
    const period = periodOf(t, bucket);
    counts.set(period, (counts.get(period) ?? 0) + 1);
  }
  return summarise('lastmod', bucket, fill(counts, from, now, bucket), now - from);
}
