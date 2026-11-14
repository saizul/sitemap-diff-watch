/**
 * Protocol limits.
 *
 * - sitemaps.org protocol 0.9: https://www.sitemaps.org/protocol.html
 * - Google Search Central sitemap docs:
 *   https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
 *   and the image, video and news extension pages.
 */
export const SITEMAP_LIMITS = {
  /** Maximum `<url>` entries in one sitemap (and in a text sitemap). */
  maxUrls: 50_000,
  /** Maximum `<sitemap>` entries in one sitemap index. */
  maxIndexEntries: 50_000,
  /** Maximum uncompressed size of a sitemap or sitemap index: 50 MB = 52,428,800 bytes. */
  maxBytes: 52_428_800,
  /** `<loc>` must be less than 2,048 characters. */
  maxLocLength: 2_048,
  /** Google: up to 1,000 `<image:image>` per `<url>`. */
  maxImagesPerUrl: 1_000,
  /** Google News: up to 1,000 `<news:news>` per sitemap. */
  maxNewsPerSitemap: 1_000,
  /** Google News: only articles published in the last two days. */
  newsMaxAgeMs: 2 * 24 * 60 * 60 * 1000,
  /** Google video: `<video:description>` at most 2,048 characters. */
  maxVideoDescription: 2_048,
  /** Google video: `<video:duration>` 1 to 28,800 seconds. */
  minVideoDuration: 1,
  maxVideoDuration: 28_800,
  /** Google video: `<video:rating>` 0.0 to 5.0. */
  maxVideoRating: 5,
  /** Google video: at most 32 `<video:tag>` per video. */
  maxVideoTags: 32,
  /** Google video: `<video:uploader>` at most 255 characters. */
  maxVideoUploader: 255,
} as const;

export const CHANGEFREQ_VALUES = ['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'] as const;

export const NAMESPACES = {
  sitemap: 'http://www.sitemaps.org/schemas/sitemap/0.9',
  image: 'http://www.google.com/schemas/sitemap-image/1.1',
  video: 'http://www.google.com/schemas/sitemap-video/1.1',
  news: 'http://www.google.com/schemas/sitemap-news/0.9',
  xhtml: 'http://www.w3.org/1999/xhtml',
} as const;
