import { mkdtemp, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

// Compiled tests live in dist/test/helpers; fixtures stay in test/fixtures.
const FIXTURES = new URL('../../../test/fixtures/', import.meta.url);

export function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

export function fixturePath(name: string): string {
  return new URL(name, FIXTURES).pathname;
}

export function gz(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(gzipSync(Buffer.from(text, 'utf8')));
}

export async function tempDir(prefix = 'sdw-'): Promise<string> {
  return promisify(mkdtemp)(join(tmpdir(), prefix));
}

/** A urlset with `count` URLs, built in memory. */
export function bigUrlset(count: number, origin = 'https://www.example.com'): string {
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'];
  for (let i = 0; i < count; i++) parts.push(`<url><loc>${origin}/products/item-${i}</loc><lastmod>2026-11-01</lastmod></url>\n`);
  parts.push('</urlset>\n');
  return parts.join('');
}

export function urlset(urls: Array<string | { loc: string; lastmod?: string; extra?: string }>, extraNs = ''): string {
  const body = urls
    .map((u) => (typeof u === 'string' ? { loc: u } : u))
    .map((u) => `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}${u.extra ?? ''}</url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${extraNs}>\n${body}\n</urlset>\n`;
}

export function sitemapIndex(locs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs.map((l) => `  <sitemap><loc>${l}</loc></sitemap>`).join('\n')}\n</sitemapindex>\n`;
}
