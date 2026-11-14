import { SITEMAP_LIMITS } from '../limits.js';
import type { ParseWarning, UrlEntry } from '../types.js';
import { parseHttpUrl } from '../util/url.js';

export interface TextSitemapSummary {
  kind: 'text';
  urlCount: number;
  sitemapCount: 0;
  newsCount: 0;
  imageCount: 0;
  videoCount: 0;
  alternateCount: 0;
  namespace: '';
}

/**
 * Plain text sitemap (sitemaps.org "Text file"): one absolute URL per line, UTF-8, at most
 * 50,000 lines and 50 MB. Blank lines are skipped; anything that is not an http(s) URL is
 * reported as a warning and ignored.
 */
export class TextSitemapParser {
  private rest = '';
  private lineNo = 0;
  private count = 0;
  private warnedLimit = false;

  constructor(
    private readonly options: { source?: string; onUrl?(entry: UrlEntry): void; onWarning?(w: ParseWarning): void } = {},
  ) {}

  write(chunk: string): void {
    const data = this.rest + chunk;
    const lines = data.split(/\r?\n/);
    this.rest = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  end(): TextSitemapSummary {
    if (this.rest) this.line(this.rest);
    this.rest = '';
    return {
      kind: 'text',
      urlCount: this.count,
      sitemapCount: 0,
      newsCount: 0,
      imageCount: 0,
      videoCount: 0,
      alternateCount: 0,
      namespace: '',
    };
  }

  private line(raw: string): void {
    this.lineNo++;
    const value = raw.replace(/^\uFEFF/, '').trim();
    if (!value) return;
    if (!parseHttpUrl(value)) {
      this.options.onWarning?.({
        code: 'invalid-text-line',
        message: `line ${this.lineNo} is not an absolute http(s) URL`,
        ...(this.options.source ? { sitemap: this.options.source } : {}),
      });
      return;
    }
    this.count++;
    if (this.count > SITEMAP_LIMITS.maxUrls && !this.warnedLimit) {
      this.warnedLimit = true;
      this.options.onWarning?.({
        code: 'too-many-urls',
        message: `more than ${SITEMAP_LIMITS.maxUrls.toLocaleString('en-US')} URLs in one sitemap`,
        ...(this.options.source ? { sitemap: this.options.source } : {}),
      });
    }
    this.options.onUrl?.({ loc: value });
  }
}
