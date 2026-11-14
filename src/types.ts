/** The subset of `fetch` this package uses; pass your own for tests, proxies or caching. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Waits `ms` milliseconds. Injectable so tests and rate limiters do not have to wait. */
export type SleepFn = (ms: number) => Promise<void>;

/** Returns the current time in milliseconds since the epoch. */
export type ClockFn = () => number;

export const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const realClock: ClockFn = () => Date.now();

export type Changefreq = 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';

export interface ImageEntry {
  loc: string;
  /** Deprecated by Google but still common; kept when present. */
  title?: string;
  caption?: string;
}

export interface VideoEntry {
  thumbnailLoc?: string;
  title?: string;
  description?: string;
  contentLoc?: string;
  playerLoc?: string;
  duration?: number;
  /** Raw `<video:duration>` text when it is not an integer. */
  durationRaw?: string;
  expirationDate?: string;
  rating?: number;
  ratingRaw?: string;
  viewCount?: number;
  publicationDate?: string;
  familyFriendly?: boolean;
  requiresSubscription?: boolean;
  live?: boolean;
  uploader?: string;
  uploaderInfo?: string;
  tags?: string[];
  restriction?: { relationship: string; countries: string[] };
  platform?: { relationship: string; platforms: string[] };
}

export interface NewsEntry {
  publicationName?: string;
  language?: string;
  publicationDate?: string;
  title?: string;
}

export interface AlternateLink {
  hreflang: string;
  href: string;
}

/** One `<url>` of a urlset, or one line of a text sitemap. */
export interface UrlEntry {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
  /** Raw `<priority>` text when it is not a number. */
  priorityRaw?: string;
  images?: ImageEntry[];
  videos?: VideoEntry[];
  news?: NewsEntry;
  alternates?: AlternateLink[];
}

/** One `<sitemap>` of a sitemap index. */
export interface SitemapRef {
  loc: string;
  lastmod?: string;
}

export type SitemapKind = 'urlset' | 'sitemapindex' | 'text';

/** A problem found while fetching or parsing, e.g. a sitemap over the 50,000 URL limit. */
export interface ParseWarning {
  code: string;
  message: string;
  sitemap?: string;
  loc?: string;
}
