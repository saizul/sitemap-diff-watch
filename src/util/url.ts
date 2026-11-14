/** Parse an absolute http(s) URL; returns `undefined` for anything else. */
export function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Key used to find near-duplicates: scheme and host lower-cased (the URL parser does that),
 * default port and fragment dropped, `www.` removed, trailing slash removed, and query
 * parameters sorted.
 */
export function looseUrlKey(value: string): string {
  const url = parseHttpUrl(value);
  if (!url) return value.trim();
  url.hash = '';
  const params = [...url.searchParams.entries()].sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const host = url.host.replace(/^www\./, '');
  return `${host}${path}${query}`;
}

/**
 * The directory a URL belongs to, `depth` levels deep: with depth 1,
 * `/blog/2026/post` -> `/blog/`, `/about` -> `/`, `/blog/` -> `/blog/`.
 */
export function pathSection(value: string, depth = 1): string {
  const url = parseHttpUrl(value);
  const pathname = url ? url.pathname : value;
  const parts = pathname.split('/').filter(Boolean);
  const dirs = pathname.endsWith('/') ? parts : parts.slice(0, -1);
  const take = dirs.slice(0, Math.max(0, depth));
  return take.length ? `/${take.map(safeDecode).join('/')}/` : '/';
}

export function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The origin a robots.txt applies to, e.g. `https://www.example.com`. */
export function originOf(value: string): string | undefined {
  return parseHttpUrl(value)?.origin;
}

/** A filesystem-safe key for a site name or URL. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'site';
}

/** A short human title for a URL: its last path segment, de-slugged. */
export function titleFromUrl(value: string): string {
  const url = parseHttpUrl(value);
  if (!url) return value;
  const parts = url.pathname.split('/').filter(Boolean);
  const last = parts.length ? safeDecode(parts[parts.length - 1]!) : url.host;
  return last.replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_]+/g, ' ').trim() || url.host;
}
