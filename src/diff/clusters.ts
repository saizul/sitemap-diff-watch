import { parseHttpUrl, safeDecode } from '../util/url.js';

export interface UrlCluster {
  /** Pattern such as `/blog/{slug}` or `/product/{id}`; query keys appear as `?page={n}`. */
  pattern: string;
  count: number;
  examples: string[];
}

export interface ClusterOptions {
  /** Distinct values a segment needs before it is folded into `{slug}` (default 3). */
  minVariety?: number;
  /** Example URLs kept per cluster (default 3). */
  examples?: number;
  /** Return at most this many clusters (default 50). */
  limit?: number;
  /** Prefix patterns with the host: `true`, `false` or `auto` (default). */
  includeHost?: boolean | 'auto';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^(?=.*\d)(?=.*[a-f])[0-9a-f]{12,}$/i;
const YEAR = /^(19|20)\d{2}$/;
const DATE = /^(19|20)\d{2}-\d{2}(-\d{2})?$/;
const NUM = /^\d+$/;

/** Placeholder for a path segment whose shape alone says it is variable. */
export function segmentToken(segment: string): string {
  if (UUID.test(segment)) return '{uuid}';
  if (DATE.test(segment)) return '{date}';
  if (YEAR.test(segment)) return '{yyyy}';
  if (NUM.test(segment)) return '{n}';
  if (HASH.test(segment)) return '{hash}';
  // slug-123 or 123-slug: ids glued to words are still ids.
  if (/^\d+-[\p{L}\d-]+$/u.test(segment)) return '{n}-{slug}';
  if (/^[\p{L}\d-]+-\d{3,}$/u.test(segment)) return '{slug}-{n}';
  const ext = /^(.+)\.(html?|php|aspx?|jsp)$/i.exec(segment);
  if (ext) {
    const inner = segmentToken(ext[1]!);
    return inner === ext[1] ? segment : `${inner}.${ext[2]!.toLowerCase()}`;
  }
  return segment;
}

interface Item {
  loc: string;
  tokens: string[];
  query: string;
}

/**
 * Group URLs by shape. Segments that look like ids, dates or hashes become placeholders
 * straight away; then, from the last segment backwards, positions where at least
 * `minVariety` different literal values share the same surrounding pattern are folded into
 * `{slug}`. `/blog/how-to-a` and `/blog/how-to-b` and `/blog/c` become `/blog/{slug}` (3).
 */
export function clusterUrls(locs: Iterable<string>, options: ClusterOptions = {}): UrlCluster[] {
  const minVariety = Math.max(2, options.minVariety ?? 3);
  const exampleCount = options.examples ?? 3;
  const limit = options.limit ?? 50;
  const list = [...locs];
  const hosts = new Set(list.map((l) => parseHttpUrl(l)?.host ?? ''));
  const withHost = options.includeHost === 'auto' || options.includeHost === undefined ? hosts.size > 1 : options.includeHost;

  const items: Item[] = list.map((loc) => {
    const url = parseHttpUrl(loc);
    if (!url) return { loc, tokens: [loc], query: '' };
    const segments = url.pathname.split('/').filter(Boolean).map(safeDecode);
    const tokens = segments.map(segmentToken);
    if (url.pathname.endsWith('/') && segments.length) tokens[tokens.length - 1] += '/';
    if (withHost) tokens.unshift(url.host);
    const keys = [...new Set([...url.searchParams.keys()])].sort();
    const query = keys.length ? `?${keys.map((k) => `${k}={${NUM.test(url.searchParams.get(k) ?? '') ? 'n' : 'v'}}`).join('&')}` : '';
    return { loc, tokens, query };
  });

  // Fold positions from the end towards the start.
  const maxLen = items.reduce((n, it) => Math.max(n, it.tokens.length), 0);
  for (let pos = maxLen - 1; pos >= (withHost ? 1 : 0); pos--) {
    const buckets = new Map<string, Item[]>();
    for (const it of items) {
      if (it.tokens.length <= pos) continue;
      const token = it.tokens[pos]!;
      if (token.startsWith('{')) continue;
      const key = `${it.tokens.length}|${it.tokens.slice(0, pos).join('/')}|${it.tokens.slice(pos + 1).join('/')}|${it.query}|${token.endsWith('/') ? '/' : ''}`;
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = []));
      bucket.push(it);
    }
    for (const bucket of buckets.values()) {
      const distinct = new Set(bucket.map((it) => it.tokens[pos]));
      if (distinct.size < minVariety) continue;
      for (const it of bucket) it.tokens[pos] = it.tokens[pos]!.endsWith('/') ? '{slug}/' : '{slug}';
    }
  }

  const clusters = new Map<string, UrlCluster>();
  for (const it of items) {
    const head = withHost ? `${it.tokens[0]}` : '';
    const rest = withHost ? it.tokens.slice(1) : it.tokens;
    const pattern = `${head}/${rest.join('/')}${it.query}`;
    let c = clusters.get(pattern);
    if (!c) clusters.set(pattern, (c = { pattern, count: 0, examples: [] }));
    c.count++;
    if (c.examples.length < exampleCount) c.examples.push(it.loc);
  }
  return [...clusters.values()].sort((a, b) => b.count - a.count || (a.pattern < b.pattern ? -1 : 1)).slice(0, limit);
}
