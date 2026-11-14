import { errorMessage } from '../errors.js';
import { httpRequest, readLimited, type HttpOptions } from '../fetch/http.js';
import { originOf } from '../util/url.js';
import { isAllowed, parseRobotsTxt, ROBOTS_MAX_BYTES, type RobotsDecision, type RobotsTxt } from './robots.js';

/**
 * - `ok`: robots.txt was fetched and parsed.
 * - `unavailable`: 4xx (including 404). RFC 9309: the crawler may access everything.
 * - `unreachable`: 5xx or a network error. RFC 9309: assume everything is disallowed.
 */
export type RobotsStatus = 'ok' | 'unavailable' | 'unreachable';

export interface RobotsFetchResult {
  url: string;
  status: RobotsStatus;
  httpStatus?: number;
  robots: RobotsTxt;
  error?: string;
}

const EMPTY: RobotsTxt = { groups: [], sitemaps: [], invalidLines: 0 };

export async function fetchRobotsTxt(siteOrUrl: string, http: HttpOptions = {}): Promise<RobotsFetchResult> {
  const origin = originOf(siteOrUrl);
  if (!origin) throw new TypeError(`not an http(s) URL: ${siteOrUrl}`);
  const url = `${origin}/robots.txt`;
  try {
    const response = await httpRequest(url, {}, http);
    if (response.status >= 200 && response.status < 300) {
      const text = await readLimited(response, ROBOTS_MAX_BYTES, url);
      return { url, status: 'ok', httpStatus: response.status, robots: parseRobotsTxt(text) };
    }
    await response.body?.cancel().catch(() => {});
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      return { url, status: 'unavailable', httpStatus: response.status, robots: EMPTY };
    }
    return { url, status: 'unreachable', httpStatus: response.status, robots: EMPTY };
  } catch (error) {
    return { url, status: 'unreachable', robots: EMPTY, error: errorMessage(error) };
  }
}

/** Fetches each origin's robots.txt once and answers allow/disallow questions. */
export class RobotsCache {
  private readonly cache = new Map<string, Promise<RobotsFetchResult>>();

  constructor(
    private readonly http: HttpOptions = {},
    readonly userAgent = 'Googlebot',
  ) {}

  /** Pre-load a robots.txt you already have (e.g. from discovery). */
  set(origin: string, result: RobotsFetchResult): void {
    this.cache.set(origin, Promise.resolve(result));
  }

  get(url: string): Promise<RobotsFetchResult> {
    const origin = originOf(url);
    if (!origin) return Promise.resolve({ url, status: 'unavailable', robots: EMPTY });
    let pending = this.cache.get(origin);
    if (!pending) {
      pending = fetchRobotsTxt(origin, this.http);
      this.cache.set(origin, pending);
    }
    return pending;
  }

  async check(url: string): Promise<RobotsDecision & { status: RobotsStatus }> {
    const result = await this.get(url);
    if (result.status === 'unreachable') return { allowed: false, status: result.status };
    if (result.status === 'unavailable') return { allowed: true, status: result.status };
    return { ...isAllowed(result.robots, url, this.userAgent), status: 'ok' };
  }
}
