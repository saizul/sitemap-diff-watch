import { errorMessage, FetchError } from '../errors.js';
import { parseSitemapStream, type StreamParseResult } from '../parse/stream.js';
import type { ParseWarning, UrlEntry } from '../types.js';
import { realClock, type ClockFn } from '../types.js';
import { parseHttpUrl } from '../util/url.js';
import { httpRequest, type HttpOptions } from './http.js';

export interface CrawlOptions {
  http?: HttpOptions;
  /** How deep to follow sitemap indexes (default 3; the root is depth 0). */
  maxDepth?: number;
  /** Stop after this many sitemap documents (default 1,000). */
  maxSitemaps?: number;
  /** Parallel downloads (default 4). */
  concurrency?: number;
  /** Hard cap on uncompressed bytes per document (default 100 MiB). */
  maxBytes?: number;
  /** Called for every URL entry as it is parsed. */
  onUrl?(entry: CrawledUrl): void;
  /** Keep URL entries in the result (default true). Turn off when `onUrl` does the work. */
  keepUrls?: boolean;
  /** Only follow child sitemaps whose URL passes this test. */
  filterSitemap?(url: string): boolean;
  clock?: ClockFn;
}

export interface CrawledUrl extends UrlEntry {
  /** The sitemap document the entry came from. */
  sitemap: string;
}

export interface SitemapInfo {
  url: string;
  /** The index that listed it; absent for roots. */
  parent?: string;
  depth: number;
  kind?: StreamParseResult['kind'];
  status: 'ok' | 'error' | 'skipped';
  httpStatus?: number;
  /** `<lastmod>` given for it in the parent index. */
  lastmod?: string;
  urlCount: number;
  sitemapCount: number;
  bytes: number;
  compressedBytes: number;
  gzip: boolean;
  durationMs: number;
  error?: string;
}

export interface CrawlResult {
  roots: string[];
  startedAt: string;
  finishedAt: string;
  sitemaps: SitemapInfo[];
  urls: CrawledUrl[];
  warnings: ParseWarning[];
}

interface Job {
  url: string;
  parent?: string;
  depth: number;
  lastmod?: string;
}

/** Normalised key for cycle detection: fragment removed, host lower-cased. */
function sitemapKey(url: string): string {
  const parsed = parseHttpUrl(url);
  if (!parsed) return url;
  parsed.hash = '';
  return parsed.toString();
}

/**
 * Fetch one or more sitemaps and, recursively, every sitemap listed in an index. Each
 * document is parsed as it streams in. Failures of single documents are recorded in
 * `sitemaps[].error` and as warnings; the crawl itself only throws for invalid input.
 */
export async function crawlSitemaps(roots: string | string[], options: CrawlOptions = {}): Promise<CrawlResult> {
  const list = (Array.isArray(roots) ? roots : [roots]).map((r) => r.trim()).filter(Boolean);
  if (list.length === 0) throw new TypeError('crawlSitemaps needs at least one sitemap URL');
  for (const r of list) if (!parseHttpUrl(r)) throw new TypeError(`not an http(s) URL: ${r}`);

  const clock = options.clock ?? realClock;
  const maxDepth = options.maxDepth ?? 3;
  const maxSitemaps = options.maxSitemaps ?? 1000;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const keepUrls = options.keepUrls ?? true;
  const startedAt = new Date(clock()).toISOString();

  const sitemaps: SitemapInfo[] = [];
  const urls: CrawledUrl[] = [];
  const warnings: ParseWarning[] = [];
  const seen = new Set<string>();
  const queue: Job[] = [];
  let scheduled = 0;
  let warnedMax = false;

  const enqueue = (job: Job): void => {
    const key = sitemapKey(job.url);
    if (seen.has(key)) {
      if (job.parent) warnings.push({ code: 'duplicate-sitemap', message: `${job.url} is listed more than once (or forms a cycle)`, sitemap: job.parent });
      return;
    }
    if (scheduled >= maxSitemaps) {
      if (!warnedMax) {
        warnedMax = true;
        warnings.push({ code: 'max-sitemaps', message: `stopped after ${maxSitemaps} sitemaps (maxSitemaps)` });
      }
      return;
    }
    seen.add(key);
    scheduled++;
    queue.push(job);
  };

  for (const url of list) enqueue({ url, depth: 0 });

  const processJob = async (job: Job): Promise<void> => {
    const info: SitemapInfo = {
      url: job.url,
      ...(job.parent ? { parent: job.parent } : {}),
      depth: job.depth,
      status: 'ok',
      ...(job.lastmod ? { lastmod: job.lastmod } : {}),
      urlCount: 0,
      sitemapCount: 0,
      bytes: 0,
      compressedBytes: 0,
      gzip: false,
      durationMs: 0,
    };
    sitemaps.push(info);
    const started = clock();
    const children: Job[] = [];
    const base = parseHttpUrl(job.url)!;
    try {
      const response = await httpRequest(job.url, { headers: { accept: 'application/xml, text/xml, application/gzip, text/plain;q=0.8, */*;q=0.5' } }, options.http);
      info.httpStatus = response.status;
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new FetchError(`HTTP ${response.status}`, job.url, response.status);
      }
      if (!response.body) throw new FetchError('empty response body', job.url, response.status);
      const result = await parseSitemapStream(response.body, {
        source: job.url,
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
        onWarning: (w) => warnings.push(w),
        onUrl: (entry) => {
          info.urlCount++;
          const crawled: CrawledUrl = { ...entry, sitemap: job.url };
          options.onUrl?.(crawled);
          if (keepUrls) urls.push(crawled);
        },
        onSitemap: (ref) => {
          info.sitemapCount++;
          const child = resolveChild(ref.loc, base);
          if (!child) {
            warnings.push({ code: 'invalid-sitemap-loc', message: `invalid sitemap URL "${ref.loc}"`, sitemap: job.url, loc: ref.loc });
            return;
          }
          if (child.host !== base.host || child.protocol !== base.protocol) {
            warnings.push({
              code: 'cross-host-sitemap',
              message: `the index lists a sitemap on another host or protocol (${child.origin}); sitemaps.org only allows sitemaps on the same site`,
              sitemap: job.url,
              loc: child.toString(),
            });
          }
          children.push({ url: child.toString(), parent: job.url, depth: job.depth + 1, ...(ref.lastmod ? { lastmod: ref.lastmod } : {}) });
        },
      });
      info.kind = result.kind;
      info.bytes = result.bytes;
      info.compressedBytes = result.compressedBytes;
      info.gzip = result.gzip;
      if (result.kind === 'sitemapindex' && job.depth > 0) {
        warnings.push({ code: 'nested-index', message: 'a sitemap index lists another sitemap index; Google does not support nested indexes', sitemap: job.url });
      }
      if (result.kind !== 'sitemapindex' && job.parent === undefined && info.urlCount === 0) {
        warnings.push({ code: 'empty-sitemap', message: 'the sitemap contains no URLs', sitemap: job.url });
      }
    } catch (error) {
      info.status = 'error';
      info.error = errorMessage(error);
      warnings.push({ code: 'sitemap-error', message: `${job.url}: ${info.error}`, sitemap: job.url });
    } finally {
      info.durationMs = clock() - started;
    }
    for (const child of children) {
      if (child.depth > maxDepth) {
        sitemaps.push({
          url: child.url,
          parent: child.parent!,
          depth: child.depth,
          status: 'skipped',
          urlCount: 0,
          sitemapCount: 0,
          bytes: 0,
          compressedBytes: 0,
          gzip: false,
          durationMs: 0,
          error: `deeper than maxDepth ${maxDepth}`,
        });
        continue;
      }
      if (options.filterSitemap && !options.filterSitemap(child.url)) continue;
      enqueue(child);
    }
  };

  // Worker pool over a queue that grows while it is processed.
  let active = 0;
  await new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      if (queue.length === 0 && active === 0) {
        resolve();
        return;
      }
      while (active < concurrency && queue.length > 0) {
        const job = queue.shift()!;
        active++;
        processJob(job).then(
          () => {
            active--;
            pump();
          },
          (error: unknown) => reject(error),
        );
      }
    };
    pump();
  });

  return { roots: list, startedAt, finishedAt: new Date(clock()).toISOString(), sitemaps, urls, warnings };
}

function resolveChild(loc: string, base: URL): URL | undefined {
  // Sitemap URLs must be absolute; resolving relative ones is a courtesy.
  try {
    const url = new URL(loc, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}
