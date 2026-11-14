import { ParseError } from '../errors.js';
import { NAMESPACES, SITEMAP_LIMITS } from '../limits.js';
import type { AlternateLink, ImageEntry, NewsEntry, ParseWarning, SitemapRef, UrlEntry, VideoEntry } from '../types.js';
import { rfc822ToIso } from '../util/w3c-datetime.js';
import { XmlTokenizer, type XmlElement } from '../xml/tokenizer.js';

/** What a document turned out to be. RSS 2.0 and Atom 1.0 feeds are valid sitemaps per sitemaps.org. */
export type DocumentKind = 'urlset' | 'sitemapindex' | 'rss' | 'atom';

export interface ParserCallbacks {
  onUrl?(entry: UrlEntry): void;
  onSitemap?(ref: SitemapRef): void;
  onWarning?(warning: ParseWarning): void;
}

export interface ParserOptions extends ParserCallbacks {
  /** URL of the document, used in warnings. */
  source?: string;
  /** Element nesting limit passed to the tokenizer. */
  maxDepth?: number;
}

export interface ParseSummary {
  kind: DocumentKind;
  urlCount: number;
  sitemapCount: number;
  newsCount: number;
  imageCount: number;
  videoCount: number;
  alternateCount: number;
  /** Namespace URI of the root element. */
  namespace: string;
  /** Encoding named in the XML declaration, if any. */
  declaredEncoding?: string;
}

type Ext = 'image' | 'video' | 'news' | 'xhtml' | 'core' | 'other';

const PREFIX_GUESS: Record<string, Ext> = { image: 'image', video: 'video', news: 'news', xhtml: 'xhtml' };

/**
 * Event-driven sitemap parser on top of {@link XmlTokenizer}. Each finished `<url>` or
 * `<sitemap>` is passed to the callbacks and then dropped, so memory use does not grow
 * with the document.
 */
export class SitemapParser {
  private readonly tokenizer: XmlTokenizer;
  private readonly source: string | undefined;
  private kind: DocumentKind | undefined;
  private namespace = '';
  private declaredEncoding: string | undefined;
  private readonly path: Array<{ local: string; ext: Ext }> = [];
  private text = '';
  private url: UrlEntry | undefined;
  private ref: SitemapRef | undefined;
  private image: ImageEntry | undefined;
  private video: VideoEntry | undefined;
  private news: NewsEntry | undefined;
  private counts = { urlCount: 0, sitemapCount: 0, newsCount: 0, imageCount: 0, videoCount: 0, alternateCount: 0 };
  private readonly warned = new Set<string>();
  private feedLink: string | undefined;
  private feedDate: string | undefined;

  constructor(private readonly options: ParserOptions = {}) {
    this.source = options.source;
    this.tokenizer = new XmlTokenizer(
      {
        open: (el) => this.open(el),
        close: (el) => this.close(el),
        text: (t) => {
          this.text += t;
        },
        declaration: (attrs) => {
          this.declaredEncoding = attrs['encoding'];
          if (attrs['encoding'] && !/^utf-?8$/i.test(attrs['encoding'])) {
            this.warnOnce('non-utf8-encoding', `the XML declaration says encoding="${attrs['encoding']}"; sitemaps must be UTF-8`);
          }
        },
      },
      { maxDepth: options.maxDepth ?? 32 },
    );
  }

  write(chunk: string): void {
    this.tokenizer.write(chunk);
  }

  end(): ParseSummary {
    this.tokenizer.end();
    if (!this.kind) throw new ParseError('document is not a sitemap');
    this.checkLimits(true);
    return {
      kind: this.kind,
      namespace: this.namespace,
      ...this.counts,
      ...(this.declaredEncoding ? { declaredEncoding: this.declaredEncoding } : {}),
    };
  }

  private warn(code: string, message: string, loc?: string): void {
    this.options.onWarning?.({ code, message, ...(this.source ? { sitemap: this.source } : {}), ...(loc ? { loc } : {}) });
  }

  private warnOnce(code: string, message: string): void {
    if (this.warned.has(code)) return;
    this.warned.add(code);
    this.warn(code, message);
  }

  private classify(el: XmlElement): Ext {
    if (el.ns === NAMESPACES.image) return 'image';
    if (el.ns === NAMESPACES.video) return 'video';
    if (el.ns === NAMESPACES.news) return 'news';
    if (el.ns === NAMESPACES.xhtml) return 'xhtml';
    if (el.undeclaredPrefix) {
      const guess = PREFIX_GUESS[el.prefix];
      if (guess) {
        this.warnOnce(`undeclared-namespace-${el.prefix}`, `the "${el.prefix}:" prefix is used without an xmlns:${el.prefix} declaration`);
        return guess;
      }
      return 'other';
    }
    if (el.prefix === '' || el.ns === this.namespace) return 'core';
    return 'other';
  }

  private open(el: XmlElement): void {
    this.text = '';
    if (this.path.length === 0) {
      this.openRoot(el);
      this.path.push({ local: el.local, ext: 'core' });
      return;
    }
    const ext = this.classify(el);
    const parent = this.path[this.path.length - 1]!;
    this.path.push({ local: el.local, ext });
    const depth = this.path.length;

    if (this.kind === 'urlset') {
      if (depth === 2 && ext === 'core' && el.local === 'url') {
        this.url = { loc: '' };
      } else if (this.url && depth === 3) {
        if (ext === 'image' && el.local === 'image') this.image = { loc: '' };
        else if (ext === 'video' && el.local === 'video') this.video = {};
        else if (ext === 'news' && el.local === 'news') {
          if (this.url.news) this.warn('multiple-news', 'a <url> may contain only one <news:news>', this.url.loc || undefined);
          this.news = {};
        } else if (ext === 'xhtml' && el.local === 'link') this.addAlternate(el);
      } else if (this.video && parent.ext === 'video' && depth === 4) {
        if (el.local === 'restriction') this.video.restriction = { relationship: el.attrs['relationship'] ?? '', countries: [] };
        else if (el.local === 'platform') this.video.platform = { relationship: el.attrs['relationship'] ?? '', platforms: [] };
        else if (el.local === 'uploader' && el.attrs['info']) this.video.uploaderInfo = el.attrs['info'];
      }
    } else if (this.kind === 'sitemapindex') {
      if (depth === 2 && ext === 'core' && el.local === 'sitemap') this.ref = { loc: '' };
    } else if (this.kind === 'rss') {
      if (el.local === 'item' && depth === 3) {
        this.feedLink = undefined;
        this.feedDate = undefined;
      }
    } else if (this.kind === 'atom') {
      if (el.local === 'entry' && depth === 2) {
        this.feedLink = undefined;
        this.feedDate = undefined;
      } else if (el.local === 'link' && depth === 3) {
        const rel = el.attrs['rel'] ?? 'alternate';
        if (rel === 'alternate' && el.attrs['href'] && this.feedLink === undefined) this.feedLink = el.attrs['href'].trim();
      }
    }
  }

  private openRoot(el: XmlElement): void {
    this.namespace = el.ns;
    switch (el.local) {
      case 'urlset':
      case 'sitemapindex':
        this.kind = el.local;
        if (el.ns !== NAMESPACES.sitemap) {
          this.warn(
            'unexpected-namespace',
            el.ns
              ? `root namespace is "${el.ns}", expected "${NAMESPACES.sitemap}"`
              : `<${el.local}> has no xmlns; expected "${NAMESPACES.sitemap}"`,
          );
        }
        break;
      case 'rss':
        this.kind = 'rss';
        break;
      case 'feed':
        this.kind = 'atom';
        break;
      default:
        throw new ParseError(`not a sitemap: the root element is <${el.qname}>`);
    }
  }

  private close(el: XmlElement): void {
    const node = this.path.pop();
    const depth = this.path.length + 1;
    const text = this.text.trim();
    this.text = '';
    if (!node) return;

    if (this.kind === 'urlset') this.closeUrlset(el, node.ext, depth, text);
    else if (this.kind === 'sitemapindex') this.closeIndex(el, node.ext, depth, text);
    else this.closeFeed(el, depth, text);
  }

  private closeUrlset(el: XmlElement, ext: Ext, depth: number, text: string): void {
    const url = this.url;
    if (!url) return;
    if (depth === 2 && el.local === 'url' && ext === 'core') {
      this.url = undefined;
      if (!url.loc) {
        this.warn('missing-loc', 'a <url> has no <loc>');
        return;
      }
      this.counts.urlCount++;
      if (url.news) this.counts.newsCount++;
      this.checkLimits(false);
      this.options.onUrl?.(url);
      return;
    }
    if (depth === 3 && ext === 'core') {
      switch (el.local) {
        case 'loc':
          url.loc = text;
          break;
        case 'lastmod':
          if (text) url.lastmod = text;
          break;
        case 'changefreq':
          if (text) url.changefreq = text;
          break;
        case 'priority': {
          if (!text) break;
          const n = Number(text);
          if (Number.isFinite(n) && /^\s*[0-9.]+\s*$/.test(text)) url.priority = n;
          else url.priorityRaw = text;
          break;
        }
      }
      return;
    }
    if (depth === 3 && ext === 'image' && el.local === 'image' && this.image) {
      if (this.image.loc) {
        (url.images ??= []).push(this.image);
        this.counts.imageCount++;
      } else this.warn('missing-image-loc', '<image:image> without <image:loc>', url.loc || undefined);
      this.image = undefined;
      return;
    }
    if (depth === 3 && ext === 'video' && el.local === 'video' && this.video) {
      (url.videos ??= []).push(this.video);
      this.counts.videoCount++;
      this.video = undefined;
      return;
    }
    if (depth === 3 && ext === 'news' && el.local === 'news' && this.news) {
      url.news = this.news;
      this.news = undefined;
      return;
    }
    if (this.image && ext === 'image' && depth === 4) {
      if (el.local === 'loc') this.image.loc = text;
      else if (el.local === 'title' && text) this.image.title = text;
      else if (el.local === 'caption' && text) this.image.caption = text;
      return;
    }
    if (this.video && ext === 'video' && depth === 4) {
      this.videoField(this.video, el.local, text);
      return;
    }
    if (this.news && ext === 'news') {
      if (depth === 5 && el.local === 'name') this.news.publicationName = text;
      else if (depth === 5 && el.local === 'language') this.news.language = text;
      else if (depth === 4 && el.local === 'publication_date') this.news.publicationDate = text;
      else if (depth === 4 && el.local === 'title') this.news.title = text;
    }
  }

  private videoField(video: VideoEntry, local: string, text: string): void {
    switch (local) {
      case 'thumbnail_loc':
        video.thumbnailLoc = text;
        break;
      case 'title':
        video.title = text;
        break;
      case 'description':
        video.description = text;
        break;
      case 'content_loc':
        video.contentLoc = text;
        break;
      case 'player_loc':
        video.playerLoc = text;
        break;
      case 'duration':
        if (/^\d+$/.test(text)) video.duration = Number(text);
        else video.durationRaw = text;
        break;
      case 'expiration_date':
        video.expirationDate = text;
        break;
      case 'rating': {
        const n = Number(text);
        if (text !== '' && Number.isFinite(n)) video.rating = n;
        else video.ratingRaw = text;
        break;
      }
      case 'view_count':
        if (/^\d+$/.test(text)) video.viewCount = Number(text);
        break;
      case 'publication_date':
        video.publicationDate = text;
        break;
      case 'family_friendly':
        video.familyFriendly = yesNo(text);
        break;
      case 'requires_subscription':
        video.requiresSubscription = yesNo(text);
        break;
      case 'live':
        video.live = yesNo(text);
        break;
      case 'uploader':
        video.uploader = text;
        break;
      case 'tag':
        if (text) (video.tags ??= []).push(text);
        break;
      case 'restriction':
        if (video.restriction) video.restriction.countries = text.split(/\s+/).filter(Boolean);
        break;
      case 'platform':
        if (video.platform) video.platform.platforms = text.split(/\s+/).filter(Boolean);
        break;
    }
  }

  private addAlternate(el: XmlElement): void {
    const rel = el.attrs['rel'];
    const hreflang = el.attrs['hreflang'];
    const href = el.attrs['href'];
    if (rel !== 'alternate' || hreflang === undefined || href === undefined) {
      this.warn('invalid-alternate', '<xhtml:link> needs rel="alternate", hreflang and href', this.url?.loc || undefined);
      return;
    }
    const link: AlternateLink = { hreflang: hreflang.trim(), href: href.trim() };
    (this.url!.alternates ??= []).push(link);
    this.counts.alternateCount++;
  }

  private closeIndex(el: XmlElement, ext: Ext, depth: number, text: string): void {
    const ref = this.ref;
    if (!ref) return;
    if (depth === 2 && el.local === 'sitemap') {
      this.ref = undefined;
      if (!ref.loc) {
        this.warn('missing-loc', 'a <sitemap> has no <loc>');
        return;
      }
      this.counts.sitemapCount++;
      this.checkLimits(false);
      this.options.onSitemap?.(ref);
      return;
    }
    if (depth === 3 && ext === 'core') {
      if (el.local === 'loc') ref.loc = text;
      else if (el.local === 'lastmod' && text) ref.lastmod = text;
    }
  }

  private closeFeed(el: XmlElement, depth: number, text: string): void {
    if (this.kind === 'rss') {
      if (depth === 4 && el.local === 'link' && el.prefix === '') this.feedLink = text;
      else if (depth === 4 && el.local === 'pubDate') this.feedDate = rfc822ToIso(text);
      else if (depth === 3 && el.local === 'item') this.emitFeedEntry();
    } else {
      if (depth === 3 && el.local === 'updated') this.feedDate = text;
      else if (depth === 2 && el.local === 'entry') this.emitFeedEntry();
    }
  }

  private emitFeedEntry(): void {
    if (!this.feedLink) return;
    const entry: UrlEntry = { loc: this.feedLink };
    if (this.feedDate) entry.lastmod = this.feedDate;
    this.counts.urlCount++;
    this.checkLimits(false);
    this.options.onUrl?.(entry);
  }

  private checkLimits(final: boolean): void {
    const c = this.counts;
    if (c.urlCount > SITEMAP_LIMITS.maxUrls) {
      this.warnOnce('too-many-urls', `more than ${SITEMAP_LIMITS.maxUrls.toLocaleString('en-US')} URLs in one sitemap`);
    }
    if (c.sitemapCount > SITEMAP_LIMITS.maxIndexEntries) {
      this.warnOnce('too-many-sitemaps', `more than ${SITEMAP_LIMITS.maxIndexEntries.toLocaleString('en-US')} sitemaps in one index`);
    }
    if (final && c.newsCount > SITEMAP_LIMITS.maxNewsPerSitemap) {
      this.warnOnce('too-many-news', `${c.newsCount} <news:news> entries; Google allows ${SITEMAP_LIMITS.maxNewsPerSitemap} per sitemap`);
    }
  }
}

function yesNo(text: string): boolean | undefined {
  const t = text.toLowerCase();
  return t === 'yes' ? true : t === 'no' ? false : undefined;
}

/** Parse a complete XML string. Convenient for small documents and tests. */
export function parseSitemapXml(
  xml: string,
  options: { source?: string } = {},
): { summary: ParseSummary; urls: UrlEntry[]; sitemaps: SitemapRef[]; warnings: ParseWarning[] } {
  const urls: UrlEntry[] = [];
  const sitemaps: SitemapRef[] = [];
  const warnings: ParseWarning[] = [];
  const parser = new SitemapParser({
    ...options,
    onUrl: (u) => urls.push(u),
    onSitemap: (s) => sitemaps.push(s),
    onWarning: (w) => warnings.push(w),
  });
  parser.write(xml);
  const summary = parser.end();
  return { summary, urls, sitemaps, warnings };
}
