/**
 * robots.txt parsing and matching per RFC 9309 (Robots Exclusion Protocol), which Google
 * follows: https://www.rfc-editor.org/rfc/rfc9309 and
 * https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt
 *
 * - Groups start with one or more `user-agent` lines; the crawler obeys the group(s) whose
 *   product token matches its own (case-insensitive), all such groups combined, otherwise
 *   the `*` groups, otherwise everything is allowed.
 * - The most specific (longest) matching rule wins; on a tie `allow` wins.
 * - `*` matches any sequence of characters and `$` anchors the end of the URL path.
 * - `sitemap:` lines are global and not tied to a group.
 * - `/robots.txt` itself is always allowed.
 */
export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export interface RobotsTxt {
  groups: RobotsGroup[];
  sitemaps: string[];
  /** Lines that could not be understood (for diagnostics). */
  invalidLines: number;
}

/** Google stops reading robots.txt after 500 KiB. */
export const ROBOTS_MAX_BYTES = 500 * 1024;

export function parseRobotsTxt(text: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let invalidLines = 0;
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;
  const body = text.length > ROBOTS_MAX_BYTES ? text.slice(0, ROBOTS_MAX_BYTES) : text;

  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/^\uFEFF/, '').replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) {
      invalidLines++;
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    switch (key) {
      case 'user-agent':
      case 'useragent':
      case 'user agent': {
        if (!current || !lastWasAgent) {
          current = { agents: [], rules: [] };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        lastWasAgent = true;
        break;
      }
      case 'allow':
      case 'disallow': {
        lastWasAgent = false;
        if (!current) {
          invalidLines++;
          break;
        }
        // An empty Disallow means "nothing is disallowed" and adds no rule.
        if (value === '') break;
        current.rules.push({ allow: key === 'allow', pattern: normalizePattern(value) });
        break;
      }
      case 'sitemap':
      case 'site-map':
        if (value) sitemaps.push(value);
        break;
      default:
        // crawl-delay, host, clean-param and other extensions do not end a group.
        if (!/^[a-z-]+$/.test(key)) invalidLines++;
        break;
    }
  }
  return { groups, sitemaps, invalidLines };
}

/** The product token of a user agent string: `Googlebot/2.1 (+http://...)` -> `googlebot`. */
export function productToken(userAgent: string): string {
  const token = userAgent.trim().split(/[\s/]/)[0] ?? '';
  return token.toLowerCase();
}

/** The rules that apply to `userAgent`, combined from every matching group. */
export function rulesFor(robots: RobotsTxt, userAgent: string): RobotsRule[] {
  const token = productToken(userAgent);
  const specific = robots.groups.filter((g) => g.agents.includes(token));
  const chosen = specific.length ? specific : robots.groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

export interface RobotsDecision {
  allowed: boolean;
  /** The rule that decided, if any. */
  rule?: RobotsRule;
}

/** Decide whether `url` (absolute, or a path starting with `/`) may be crawled by `userAgent`. */
export function isAllowed(robots: RobotsTxt, url: string, userAgent: string): RobotsDecision {
  const path = pathForMatching(url);
  if (path === '/robots.txt') return { allowed: true };
  let best: RobotsRule | undefined;
  let bestLength = -1;
  for (const rule of rulesFor(robots, userAgent)) {
    if (!matchPattern(rule.pattern, path)) continue;
    const length = rule.pattern.length;
    if (length > bestLength || (length === bestLength && rule.allow && !best!.allow)) {
      best = rule;
      bestLength = length;
    }
  }
  if (!best) return { allowed: true };
  return { allowed: best.allow, rule: best };
}

/** Path plus query, with percent-encoding normalised, as robots.txt rules see it. */
export function pathForMatching(url: string): string {
  let pathAndQuery: string;
  if (url.startsWith('/')) pathAndQuery = url;
  else {
    try {
      const u = new URL(url);
      pathAndQuery = `${u.pathname}${u.search}`;
    } catch {
      pathAndQuery = url;
    }
  }
  return normalizePercent(pathAndQuery.replace(/#.*$/, '')) || '/';
}

function normalizePattern(pattern: string): string {
  return normalizePercent(pattern);
}

/** Encode non-ASCII characters as UTF-8 percent escapes and upper-case existing escapes. */
function normalizePercent(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code > 0x7e || code < 0x21) out += encodeURIComponent(ch);
    else out += ch;
  }
  return out.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
}

/** Match a robots.txt path pattern (`*` wildcard, trailing `$` anchor) against a path. */
export function matchPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  if (!body.includes('*')) return anchored ? path === body : path.startsWith(body);
  const parts = body.split('*');
  // First part must be a prefix.
  if (!path.startsWith(parts[0]!)) return false;
  let index = parts[0]!.length;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    if (i === parts.length - 1 && anchored) {
      return path.length - part.length >= index && path.endsWith(part);
    }
    if (part === '') continue;
    const found = path.indexOf(part, index);
    if (found === -1) return false;
    index = found + part.length;
  }
  return !anchored || index === path.length;
}
