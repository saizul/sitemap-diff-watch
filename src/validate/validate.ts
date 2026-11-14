import { CHANGEFREQ_VALUES, SITEMAP_LIMITS } from '../limits.js';
import type { RobotsCache } from '../robots/fetch-robots.js';
import type { ParseWarning, UrlEntry, VideoEntry } from '../types.js';
import { realClock, type ClockFn } from '../types.js';
import { looseUrlKey, originOf, parseHttpUrl } from '../util/url.js';
import { parseW3cDatetime } from '../util/w3c-datetime.js';
import { headCheck, type HeadCheckOptions, type HeadResult } from './head-check.js';
import { checkHreflang } from './hreflang.js';

export type Severity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  code: string;
  severity: Severity;
  message: string;
  loc?: string;
  sitemap?: string;
}

export interface ValidationReport {
  checkedAt: string;
  /** Entries checked, duplicates included. */
  urlCount: number;
  canonicalHost?: string;
  canonicalProtocol?: string;
  issues: ValidationIssue[];
  /** Issues per code, including those beyond `maxIssuesPerCode`. */
  counts: Record<string, number>;
  bySeverity: Record<Severity, number>;
  head?: HeadResult[];
}

export interface ValidateOptions {
  /** Host every URL should use, e.g. `www.example.com`. Default: the host of the first root sitemap, else the most common host. */
  canonicalHost?: string;
  /** `https:` or `http:`. Default: the protocol of the first root sitemap, else the most common one. */
  canonicalProtocol?: 'https:' | 'http:';
  /** Root sitemap URLs, used for the defaults above. */
  roots?: string[];
  /** Crawl warnings to include as sitemap-level issues. */
  warnings?: ParseWarning[];
  /** Lastmod later than now plus this is reported (default 24 h, to absorb time zone slips). */
  futureToleranceMs?: number;
  /** Check the sitemaps.org location rule (default true). */
  checkScope?: boolean;
  /** Check URLs against robots.txt. */
  robots?: RobotsCache;
  /** HEAD-check URLs (off by default). */
  head?: HeadCheckOptions | boolean;
  /** Keep at most this many issues per code (default 500); `counts` stays exact. */
  maxIssuesPerCode?: number;
  clock?: ClockFn;
}

type Entry = UrlEntry & { sitemap?: string };

const SEVERITY_OF_WARNING: Record<string, Severity> = {
  'too-many-urls': 'error',
  'too-many-sitemaps': 'error',
  'sitemap-too-large': 'error',
  'too-many-news': 'error',
  'sitemap-error': 'error',
  'missing-loc': 'error',
  'invalid-sitemap-loc': 'error',
  'cross-host-sitemap': 'warning',
  'nested-index': 'warning',
  'unexpected-namespace': 'warning',
  'non-utf8-encoding': 'warning',
  'invalid-utf8': 'warning',
  'empty-sitemap': 'warning',
  'duplicate-sitemap': 'info',
  'max-sitemaps': 'warning',
};

// Characters that must be percent-encoded in a URL, and any non-ASCII character.
const UNSAFE_CHARS = /[\s<>"{}|\\^`]|[^\p{ASCII}]/u;

function mostCommon(values: Iterable<string>): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let n = -1;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

class IssueList {
  readonly issues: ValidationIssue[] = [];
  readonly counts: Record<string, number> = {};
  readonly bySeverity: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  constructor(private readonly max: number) {}

  add(issue: ValidationIssue): void {
    const n = (this.counts[issue.code] = (this.counts[issue.code] ?? 0) + 1);
    this.bySeverity[issue.severity]++;
    if (n <= this.max) this.issues.push(issue);
  }
}

/**
 * Check sitemap entries against the sitemaps.org protocol and Google's sitemap, image,
 * video, news and hreflang rules, plus common SEO problems: non-canonical hosts, http and
 * https mixed, duplicates, invalid or future lastmod, robots.txt blocks and (optionally)
 * URLs that do not answer 200.
 */
export async function validateEntries(entries: readonly Entry[], options: ValidateOptions = {}): Promise<ValidationReport> {
  const now = (options.clock ?? realClock)();
  const tolerance = options.futureToleranceMs ?? 24 * 60 * 60 * 1000;
  const list = new IssueList(options.maxIssuesPerCode ?? 500);
  const add = (code: string, severity: Severity, message: string, e?: Entry): void =>
    list.add({ code, severity, message, ...(e ? { loc: e.loc } : {}), ...(e?.sitemap ? { sitemap: e.sitemap } : {}) });

  for (const w of options.warnings ?? []) {
    list.add({ code: w.code, severity: SEVERITY_OF_WARNING[w.code] ?? 'warning', message: w.message, ...(w.loc ? { loc: w.loc } : {}), ...(w.sitemap ? { sitemap: w.sitemap } : {}) });
  }

  const parsed = entries.map((e) => parseHttpUrl(e.loc));
  const firstRoot = options.roots?.length ? parseHttpUrl(options.roots[0]!) : undefined;
  const canonicalHost = (options.canonicalHost ?? firstRoot?.host ?? mostCommon(parsed.flatMap((u) => (u ? [u.host] : []))))?.toLowerCase();
  const canonicalProtocol = options.canonicalProtocol ?? (firstRoot?.protocol as 'https:' | 'http:' | undefined) ?? (mostCommon(parsed.flatMap((u) => (u ? [u.protocol] : []))) as 'https:' | 'http:' | undefined);

  // Duplicates
  const seen = new Map<string, Entry[]>();
  for (const e of entries) {
    const arr = seen.get(e.loc);
    if (arr) arr.push(e);
    else seen.set(e.loc, [e]);
  }
  for (const [loc, arr] of seen) {
    if (arr.length > 1) {
      const where = [...new Set(arr.map((x) => x.sitemap).filter(Boolean))];
      add('duplicate-url', 'warning', `listed ${arr.length} times${where.length > 1 ? ` across ${where.length} sitemaps` : ''}`, { loc, ...(arr[0]!.sitemap ? { sitemap: arr[0]!.sitemap } : {}) });
    }
  }
  const loose = new Map<string, string>();
  for (const loc of seen.keys()) {
    const key = looseUrlKey(loc);
    const other = loose.get(key);
    if (other !== undefined && other !== loc) add('near-duplicate', 'info', `differs from ${other} only by www, trailing slash, protocol case or parameter order`, { loc });
    else loose.set(key, loc);
  }

  let httpCount = 0;
  let httpsCount = 0;
  const hreflangIndex = new Map<string, Set<string>>();

  entries.forEach((e, i) => {
    const url = parsed[i];
    if (!url) {
      add('invalid-url', 'error', `"${e.loc.slice(0, 200)}" is not an absolute http(s) URL`, e);
      return;
    }
    if (e.loc.length >= SITEMAP_LIMITS.maxLocLength) add('url-too-long', 'error', `URL is ${e.loc.length} characters; it must be under ${SITEMAP_LIMITS.maxLocLength}`, e);
    if (url.hash) add('url-has-fragment', 'warning', 'URL contains a #fragment, which crawlers ignore', e);
    if (UNSAFE_CHARS.test(e.loc)) add('unencoded-url', 'warning', 'URL contains spaces or characters that must be percent-encoded (RFC 3986)', e);
    if (url.protocol === 'http:') httpCount++;
    else httpsCount++;
    if (canonicalHost && url.host.toLowerCase() !== canonicalHost) add('non-canonical-host', 'warning', `host ${url.host} is not the canonical host ${canonicalHost}`, e);
    if (canonicalProtocol && url.protocol !== canonicalProtocol) add('mixed-protocol', 'warning', `uses ${url.protocol.slice(0, -1)} while the site uses ${canonicalProtocol.slice(0, -1)}`, e);
    if (options.checkScope !== false && e.sitemap) checkScope(e, url, add);

    if (e.lastmod !== undefined) {
      const r = parseW3cDatetime(e.lastmod);
      if (!r.valid) add('invalid-lastmod', 'error', `lastmod "${e.lastmod}": ${r.reason}`, e);
      else if (r.time > now + tolerance) add('future-lastmod', 'warning', `lastmod ${e.lastmod} is in the future`, e);
    }
    if (e.changefreq !== undefined && !(CHANGEFREQ_VALUES as readonly string[]).includes(e.changefreq)) {
      add('invalid-changefreq', 'warning', `changefreq "${e.changefreq}" is not one of ${CHANGEFREQ_VALUES.join(', ')}`, e);
    }
    if (e.priorityRaw !== undefined) add('invalid-priority', 'warning', `priority "${e.priorityRaw}" is not a number`, e);
    else if (e.priority !== undefined && (e.priority < 0 || e.priority > 1)) add('invalid-priority', 'warning', `priority ${e.priority} is outside 0.0-1.0`, e);

    if (e.images) {
      if (e.images.length > SITEMAP_LIMITS.maxImagesPerUrl) add('too-many-images', 'warning', `${e.images.length} images; Google reads at most ${SITEMAP_LIMITS.maxImagesPerUrl} per URL`, e);
      for (const img of e.images) if (!parseHttpUrl(img.loc)) add('invalid-image-loc', 'warning', `image "${img.loc.slice(0, 200)}" is not an absolute URL`, e);
    }
    for (const v of e.videos ?? []) checkVideo(v, e, add);
    if (e.news) checkNews(e, now, add);
    if (e.alternates?.length) {
      checkAlternates(e, add);
      hreflangIndex.set(e.loc, new Set(e.alternates.map((a) => a.href)));
    }
  });

  if (httpCount > 0 && httpsCount > 0) {
    add('protocol-mix', 'warning', `${httpCount} http and ${httpsCount} https URLs in the same sitemap set`);
  }

  // Return links: if A lists B as an alternate and B is in the sitemaps with its own
  // annotations, B must list A.
  for (const [loc, targets] of hreflangIndex) {
    for (const href of targets) {
      if (href === loc) continue;
      const back = hreflangIndex.get(href);
      if (back && !back.has(loc)) add('hreflang-missing-return', 'warning', `${href} does not link back to this URL`, { loc });
    }
  }

  if (options.robots) await checkRobots([...seen.keys()], options.robots, add);

  let head: HeadResult[] | undefined;
  if (options.head) {
    const headOptions = options.head === true ? {} : options.head;
    head = await headCheck([...seen.keys()].filter((l) => parseHttpUrl(l)), { ...(options.clock ? { clock: options.clock } : {}), ...headOptions });
    for (const r of head) {
      const e = { loc: r.loc };
      if (r.error) add('http-failed', 'error', `request failed: ${r.error}`, e);
      else if (r.status! >= 300 && r.status! < 400) add('http-redirect', 'warning', `HTTP ${r.status} redirect${r.location ? ` to ${r.location}` : ''}; list the final URL instead`, e);
      else if (r.status !== 200) add('http-status', 'error', `HTTP ${r.status}`, e);
      if (r.xRobotsTag && /noindex/i.test(r.xRobotsTag)) add('noindex-header', 'warning', `X-Robots-Tag: ${r.xRobotsTag}`, e);
    }
  }

  return {
    checkedAt: new Date(now).toISOString(),
    urlCount: entries.length,
    ...(canonicalHost ? { canonicalHost } : {}),
    ...(canonicalProtocol ? { canonicalProtocol } : {}),
    issues: list.issues,
    counts: list.counts,
    bySeverity: list.bySeverity,
    ...(head ? { head } : {}),
  };
}

type Add = (code: string, severity: Severity, message: string, e?: Entry) => void;

/** sitemaps.org: a sitemap may only list URLs on the same protocol, host and port, under its own directory. */
function checkScope(e: Entry, url: URL, add: Add): void {
  const sm = parseHttpUrl(e.sitemap!);
  if (!sm) return;
  if (sm.protocol !== url.protocol || sm.host !== url.host) {
    add('outside-sitemap-scope', 'warning', `URL is on ${url.origin} but the sitemap is on ${sm.origin}; only allowed for cross-site setups verified in Search Console or referenced from robots.txt`, e);
    return;
  }
  const dir = sm.pathname.slice(0, sm.pathname.lastIndexOf('/') + 1);
  if (!url.pathname.startsWith(dir)) add('outside-sitemap-scope', 'warning', `URL is outside the sitemap's directory ${dir}`, e);
}

function checkVideo(v: VideoEntry, e: Entry, add: Add): void {
  const missing: string[] = [];
  if (!v.thumbnailLoc) missing.push('thumbnail_loc');
  if (!v.title) missing.push('title');
  if (!v.description) missing.push('description');
  if (!v.contentLoc && !v.playerLoc) missing.push('content_loc or player_loc');
  if (missing.length) add('video-missing-field', 'error', `video is missing ${missing.join(', ')}`, e);
  if (v.description && v.description.length > SITEMAP_LIMITS.maxVideoDescription) add('video-description-too-long', 'warning', `video description is ${v.description.length} characters (max ${SITEMAP_LIMITS.maxVideoDescription})`, e);
  if (v.durationRaw !== undefined || (v.duration !== undefined && (v.duration < SITEMAP_LIMITS.minVideoDuration || v.duration > SITEMAP_LIMITS.maxVideoDuration))) {
    add('video-invalid-duration', 'warning', `video duration ${v.durationRaw ?? v.duration} must be whole seconds from 1 to 28800`, e);
  }
  if (v.ratingRaw !== undefined || (v.rating !== undefined && (v.rating < 0 || v.rating > SITEMAP_LIMITS.maxVideoRating))) {
    add('video-invalid-rating', 'warning', `video rating ${v.ratingRaw ?? v.rating} must be 0.0-5.0`, e);
  }
  if ((v.tags?.length ?? 0) > SITEMAP_LIMITS.maxVideoTags) add('video-too-many-tags', 'warning', `${v.tags!.length} video tags (max ${SITEMAP_LIMITS.maxVideoTags})`, e);
  if (v.uploader && v.uploader.length > SITEMAP_LIMITS.maxVideoUploader) add('video-uploader-too-long', 'warning', `video uploader is longer than ${SITEMAP_LIMITS.maxVideoUploader} characters`, e);
  for (const [name, value] of [['publication_date', v.publicationDate], ['expiration_date', v.expirationDate]] as const) {
    if (value !== undefined && !parseW3cDatetime(value).valid) add('video-invalid-date', 'warning', `video ${name} "${value}" is not W3C Datetime`, e);
  }
  for (const [name, rel] of [['restriction', v.restriction?.relationship], ['platform', v.platform?.relationship]] as const) {
    if (rel !== undefined && rel !== 'allow' && rel !== 'deny') add('video-invalid-relationship', 'warning', `video ${name} needs relationship="allow" or "deny"`, e);
  }
  for (const loc of [v.thumbnailLoc, v.contentLoc, v.playerLoc]) {
    if (loc && !parseHttpUrl(loc)) add('video-invalid-url', 'warning', `video URL "${loc.slice(0, 200)}" is not absolute`, e);
  }
  if (v.contentLoc && v.contentLoc === e.loc) add('video-invalid-url', 'warning', 'video content_loc must not be the same as the page URL', e);
}

function checkNews(e: Entry, now: number, add: Add): void {
  const n = e.news!;
  const missing: string[] = [];
  if (!n.publicationName) missing.push('publication name');
  if (!n.language) missing.push('publication language');
  if (!n.publicationDate) missing.push('publication_date');
  if (!n.title) missing.push('title');
  if (missing.length) add('news-missing-field', 'error', `news entry is missing ${missing.join(', ')}`, e);
  if (n.language && !/^([a-z]{2,3}|zh-cn|zh-tw)$/i.test(n.language)) add('news-invalid-language', 'warning', `news language "${n.language}" must be an ISO 639 code (zh-cn and zh-tw for Chinese)`, e);
  if (n.publicationDate) {
    const r = parseW3cDatetime(n.publicationDate);
    if (!r.valid) add('news-invalid-date', 'error', `news publication_date "${n.publicationDate}": ${r.reason}`, e);
    else if (now - r.time > SITEMAP_LIMITS.newsMaxAgeMs) add('news-too-old', 'info', 'article is older than two days; Google News sitemaps should only list recent articles', e);
  }
}

function checkAlternates(e: Entry, add: Add): void {
  const alts = e.alternates!;
  let self = false;
  const byLang = new Map<string, string>();
  for (const a of alts) {
    const check = checkHreflang(a.hreflang);
    if (!check.valid) add('hreflang-invalid-code', 'warning', `hreflang "${a.hreflang}": ${check.reason}`, e);
    if (!parseHttpUrl(a.href)) add('hreflang-relative-href', 'warning', `alternate href "${a.href.slice(0, 200)}" must be fully qualified`, e);
    if (a.href === e.loc) self = true;
    const key = a.hreflang.toLowerCase();
    const prev = byLang.get(key);
    if (prev !== undefined && prev !== a.href) add('hreflang-conflict', 'warning', `hreflang "${a.hreflang}" points to two different URLs`, e);
    byLang.set(key, a.href);
  }
  if (!self) add('hreflang-missing-self', 'warning', 'the alternates do not include the URL itself', e);
}

async function checkRobots(locs: string[], robots: RobotsCache, add: Add): Promise<void> {
  const reportedOrigins = new Set<string>();
  for (const loc of locs) {
    if (!parseHttpUrl(loc)) continue;
    const decision = await robots.check(loc);
    if (decision.status === 'unreachable') {
      const origin = originOf(loc)!;
      if (!reportedOrigins.has(origin)) {
        reportedOrigins.add(origin);
        add('robots-unreachable', 'error', `${origin}/robots.txt could not be fetched (5xx or network error); crawlers treat the whole site as disallowed`);
      }
      continue;
    }
    if (!decision.allowed) add('blocked-by-robots', 'error', `blocked by robots.txt for ${robots.userAgent}${decision.rule ? ` (Disallow: ${decision.rule.pattern})` : ''}`, { loc });
  }
}
