import { httpRequest, type HttpOptions } from './http.js';
import { fetchRobotsTxt, type RobotsFetchResult } from '../robots/fetch-robots.js';
import { originOf } from '../util/url.js';

export interface DiscoveryResult {
  origin: string;
  /** Sitemap URLs, de-duplicated, in the order found. */
  sitemaps: string[];
  /** Where they came from. */
  source: 'robots' | 'probe' | 'none';
  robots: RobotsFetchResult;
}

/** Paths tried when robots.txt lists no sitemap. */
export const COMMON_SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml', '/sitemap.xml.gz'];

/**
 * Find a site's sitemaps: the `Sitemap:` lines of its robots.txt, or, when there are none
 * and `probe` is on (default), the first of {@link COMMON_SITEMAP_PATHS} that answers 2xx
 * with something other than HTML.
 */
export async function discoverSitemaps(site: string, options: HttpOptions & { probe?: boolean } = {}): Promise<DiscoveryResult> {
  const origin = originOf(site);
  if (!origin) throw new TypeError(`not an http(s) URL: ${site}`);
  const robots = await fetchRobotsTxt(origin, options);
  const sitemaps = [...new Set(robots.robots.sitemaps)];
  if (sitemaps.length) return { origin, sitemaps, source: 'robots', robots };
  if (options.probe === false) return { origin, sitemaps: [], source: 'none', robots };
  for (const path of COMMON_SITEMAP_PATHS) {
    const url = `${origin}${path}`;
    try {
      const response = await httpRequest(url, {}, { ...options, retries: 0 });
      const type = response.headers.get('content-type') ?? '';
      await response.body?.cancel().catch(() => {});
      if (response.ok && !type.includes('text/html')) return { origin, sitemaps: [response.url || url], source: 'probe', robots };
    } catch {
      // try the next path
    }
  }
  return { origin, sitemaps: [], source: 'none', robots };
}
