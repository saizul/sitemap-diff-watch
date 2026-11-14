import type { SnapshotDiff } from '../diff/diff.js';
import { titleFromUrl } from '../util/url.js';
import { parseW3cDatetime } from '../util/w3c-datetime.js';
import { escapeXml } from '../xml/entities.js';
import { VERSION } from '../version.js';

export interface RssItem {
  title: string;
  link: string;
  /** ISO timestamp. */
  date: string;
  description?: string;
}

export interface RssOptions {
  title: string;
  /** Channel link, usually the site home page. */
  link: string;
  description?: string;
  /** Public URL of the feed itself, for `atom:link rel="self"`. */
  selfUrl?: string;
  /** Items kept, newest first (default 100). */
  maxItems?: number;
  now?: number;
}

/**
 * Items for the URLs added in one or more diffs. The date is the URL's own `<lastmod>`
 * (or news publication date) when it is valid and not later than the snapshot, else the
 * time of the snapshot in which it first appeared.
 */
export function rssItemsFromDiffs(diffs: SnapshotDiff[]): RssItem[] {
  const items = new Map<string, RssItem>();
  for (const d of diffs) {
    const seenAt = Date.parse(d.to.createdAt);
    for (const u of d.added) {
      if (items.has(u.loc)) continue;
      const candidates = [u.news?.publicationDate, u.lastmod];
      let date = d.to.createdAt;
      for (const c of candidates) {
        if (!c) continue;
        const r = parseW3cDatetime(c);
        if (r.valid && r.time <= seenAt) {
          date = r.iso;
          break;
        }
      }
      items.set(u.loc, {
        title: u.news?.title ?? titleFromUrl(u.loc),
        link: u.loc,
        date,
        description: `New in ${u.sitemap}`,
      });
    }
  }
  return [...items.values()];
}

/** RSS 2.0 feed of new URLs. */
export function renderRss(items: RssItem[], options: RssOptions): string {
  const max = options.maxItems ?? 100;
  const sorted = [...items].sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || (a.link < b.link ? -1 : 1)).slice(0, max);
  const built = new Date(options.now ?? Date.now()).toUTCString();
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `<title>${escapeXml(options.title)}</title>`,
    `<link>${escapeXml(options.link)}</link>`,
    `<description>${escapeXml(options.description ?? `New URLs found in the sitemaps of ${options.link}`)}</description>`,
    `<lastBuildDate>${built}</lastBuildDate>`,
    `<generator>sitemap-diff-watch ${VERSION}</generator>`,
  ];
  if (options.selfUrl) out.push(`<atom:link href="${escapeXml(options.selfUrl)}" rel="self" type="application/rss+xml"/>`);
  for (const item of sorted) {
    out.push(
      '<item>',
      `<title>${escapeXml(item.title)}</title>`,
      `<link>${escapeXml(item.link)}</link>`,
      `<guid isPermaLink="true">${escapeXml(item.link)}</guid>`,
      `<pubDate>${new Date(item.date).toUTCString()}</pubDate>`,
      ...(item.description ? [`<description>${escapeXml(item.description)}</description>`] : []),
      '</item>',
    );
  }
  out.push('</channel>', '</rss>', '');
  return out.join('\n');
}
