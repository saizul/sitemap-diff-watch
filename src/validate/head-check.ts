import { errorMessage } from '../errors.js';
import { httpRequest, type HttpOptions } from '../fetch/http.js';
import { realClock, realSleep, type ClockFn, type SleepFn } from '../types.js';
import { mapLimit, RateLimiter } from '../util/concurrency.js';

export interface HeadCheckOptions {
  http?: HttpOptions;
  /** Requests started per second, across all workers (default 2). */
  ratePerSecond?: number;
  /** Requests in flight (default 2). */
  concurrency?: number;
  /** Check at most this many URLs (default 200); a spread sample is taken from longer lists. */
  maxUrls?: number;
  clock?: ClockFn;
  sleep?: SleepFn;
}

export interface HeadResult {
  loc: string;
  status?: number;
  /** `Location` of a redirect. */
  location?: string;
  /** `X-Robots-Tag` header, when present. */
  xRobotsTag?: string;
  method: 'HEAD' | 'GET';
  error?: string;
}

/** Evenly spread sample of `count` items, always including the first. */
export function spreadSample<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const out: T[] = [];
  const step = items.length / count;
  for (let i = 0; i < count; i++) out.push(items[Math.floor(i * step)]!);
  return out;
}

/**
 * Check that sitemap URLs answer 200. Redirects are not followed (a sitemap should list
 * final URLs), servers that refuse HEAD (405/501) are asked again with GET, and the
 * request rate is limited so the site is not hammered.
 */
export async function headCheck(locs: readonly string[], options: HeadCheckOptions = {}): Promise<HeadResult[]> {
  const sample = spreadSample([...new Set(locs)], options.maxUrls ?? 200);
  const limiter = new RateLimiter(options.ratePerSecond ?? 2, options.clock ?? realClock, options.sleep ?? realSleep);
  const http: HttpOptions = { retries: 1, ...options.http, ...(options.sleep ? { sleep: options.sleep } : {}) };
  return mapLimit(sample, options.concurrency ?? 2, async (loc) => {
    await limiter.wait();
    try {
      let method: HeadResult['method'] = 'HEAD';
      let response = await httpRequest(loc, { method: 'HEAD', redirect: 'manual' }, http);
      if (response.status === 405 || response.status === 501) {
        await response.body?.cancel().catch(() => {});
        await limiter.wait();
        method = 'GET';
        response = await httpRequest(loc, { method: 'GET', redirect: 'manual' }, http);
      }
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      const xRobotsTag = response.headers.get('x-robots-tag');
      return {
        loc,
        status: response.status,
        method,
        ...(location ? { location: new URL(location, loc).toString() } : {}),
        ...(xRobotsTag ? { xRobotsTag } : {}),
      };
    } catch (error) {
      return { loc, method: 'HEAD' as const, error: errorMessage(error) };
    }
  });
}
