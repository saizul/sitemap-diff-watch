import { SitemapWatchError } from '../errors.js';
import type { CrawlResult } from '../fetch/crawler.js';
import { computeStats, type Snapshot } from '../snapshot/snapshot.js';
import { parseHttpUrl } from '../util/url.js';

/**
 * URL scope for a site. A URL is kept when it matches at least one `include` pattern (or
 * `include` is empty) and no `exclude` pattern.
 *
 * Pattern forms:
 * - `/blog/**` - glob against the path and query (`/blog/post?page=2`)
 * - `https://shop.example.com/p/*` - glob against the whole URL (anything with `://`)
 * - `*.example.com/news/**` - glob against host, path and query
 * - `re:^https://[^/]+/\d{4}/` - JavaScript regular expression, searched in the whole URL
 *
 * In globs `*` matches anything but `/`, `**` matches anything, and a trailing `/**` also
 * matches the directory itself. Everything else is literal and the whole string must match.
 * Hosts are compared lower-cased; paths are case-sensitive.
 */
export interface UrlFilterSpec {
  include?: string[];
  exclude?: string[];
}

export interface UrlFilter {
  /** `true` when the URL is in scope. */
  test(url: string): boolean;
  /** `false` when the spec has no patterns, so every URL passes. */
  active: boolean;
  include: string[];
  exclude: string[];
}

/** Recorded in `stats.filter` so later runs can tell when the scope changed. */
export interface SnapshotFilterInfo {
  include: string[];
  exclude: string[];
  /** Distinct URLs dropped by the filter. */
  excludedUrls: number;
}

export class FilterError extends SitemapWatchError {
  constructor(message: string) {
    super(message);
    this.name = 'FilterError';
  }
}

/** Longest pattern accepted; protects against pathological input from config files. */
const MAX_PATTERN_LENGTH = 1000;

function globToRegExp(glob: string): RegExp {
  let source = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      source += '(?:/.*)?';
      i += 3;
    } else if (glob.startsWith('**', i)) {
      source += '.*';
      i += 2;
      while (glob[i] === '*') i++;
    } else if (glob[i] === '*') {
      source += '[^/]*';
      i++;
    } else {
      source += glob[i]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${source}$`);
}

/** Lower-case the host part of a host-relative or absolute glob, leaving the path alone. */
function lowerHost(glob: string, hostStart: number): string {
  const slash = glob.indexOf('/', hostStart);
  const end = slash === -1 ? glob.length : slash;
  return glob.slice(0, hostStart) + glob.slice(hostStart, end).toLowerCase() + glob.slice(end);
}

/** Compile one pattern into a predicate over absolute URLs. Throws `FilterError` on bad input. */
export function compileUrlPattern(pattern: string): (url: string) => boolean {
  if (typeof pattern !== 'string' || !pattern.trim()) throw new FilterError('URL pattern must be a non-empty string');
  if (pattern.length > MAX_PATTERN_LENGTH) throw new FilterError(`URL pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
  if (pattern.startsWith('re:')) {
    let re: RegExp;
    try {
      re = new RegExp(pattern.slice(3));
    } catch (error) {
      throw new FilterError(`invalid regular expression in "${pattern}": ${(error as Error).message}`);
    }
    return (url) => re.test(url);
  }
  const scheme = pattern.indexOf('://');
  if (scheme !== -1) {
    const re = globToRegExp(lowerHost(pattern.slice(0, scheme).toLowerCase() + pattern.slice(scheme), scheme + 3));
    return (url) => {
      const u = parseHttpUrl(url);
      return re.test(u ? u.href.replace(/#.*$/, '') : url);
    };
  }
  if (pattern.startsWith('/')) {
    const re = globToRegExp(pattern);
    return (url) => {
      const u = parseHttpUrl(url);
      return u !== undefined && re.test(u.pathname + u.search);
    };
  }
  const re = globToRegExp(lowerHost(pattern, 0));
  return (url) => {
    const u = parseHttpUrl(url);
    return u !== undefined && re.test(u.host + u.pathname + u.search);
  };
}

function patternList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((p) => typeof p !== 'string')) throw new FilterError(`${name} must be a list of strings`);
  return value as string[];
}

/** Compile an include/exclude spec. Throws `FilterError` naming the bad pattern. */
export function compileUrlFilter(spec: UrlFilterSpec = {}): UrlFilter {
  const include = patternList(spec.include, 'include');
  const exclude = patternList(spec.exclude, 'exclude');
  const compile = (list: string[], name: string): Array<(url: string) => boolean> =>
    list.map((p, i) => {
      try {
        return compileUrlPattern(p);
      } catch (error) {
        throw new FilterError(`${name}[${i}]: ${(error as Error).message}`);
      }
    });
  const inc = compile(include, 'include');
  const exc = compile(exclude, 'exclude');
  return {
    include,
    exclude,
    active: inc.length > 0 || exc.length > 0,
    test: (url) => (inc.length === 0 || inc.some((m) => m(url))) && !exc.some((m) => m(url)),
  };
}

/** Stable key of a filter's patterns; equal keys mean the same scope. */
export function filterKey(info: Pick<SnapshotFilterInfo, 'include' | 'exclude'> | undefined): string {
  if (!info || (!info.include.length && !info.exclude.length)) return '';
  return JSON.stringify([[...info.include].sort(), [...info.exclude].sort()]);
}

/** Drop out-of-scope URL entries from a crawl. Returns the crawl unchanged when the filter is inactive. */
export function filterCrawl(crawl: CrawlResult, filter: UrlFilter): { crawl: CrawlResult; excludedUrls: number } {
  if (!filter.active) return { crawl, excludedUrls: 0 };
  const excluded = new Set<string>();
  const cache = new Map<string, boolean>();
  const urls = crawl.urls.filter((u) => {
    let keep = cache.get(u.loc);
    if (keep === undefined) {
      keep = filter.test(u.loc);
      cache.set(u.loc, keep);
    }
    if (!keep) excluded.add(u.loc);
    return keep;
  });
  return { crawl: { ...crawl, urls }, excludedUrls: excluded.size };
}

/**
 * Apply a filter to a stored snapshot (stats recomputed, `stats.filter` set). Used to bring
 * an older snapshot into the current scope before diffing, so a config change does not show
 * up as a mass removal.
 */
export function filterSnapshot(snapshot: Snapshot, filter: UrlFilter): Snapshot {
  if (!filter.active) return snapshot;
  const before = new Set(snapshot.urls.map((u) => u.loc));
  const urls = snapshot.urls.filter((u) => filter.test(u.loc));
  const after = new Set(urls.map((u) => u.loc));
  const previous = snapshot.stats.filter?.excludedUrls ?? 0;
  const stats = {
    ...computeStats(urls, snapshot.sitemaps),
    filter: { include: filter.include, exclude: filter.exclude, excludedUrls: previous + before.size - after.size },
  };
  return { ...snapshot, urls, stats };
}
