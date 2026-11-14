import { parseHttpUrl, pathSection } from '../util/url.js';

export interface SectionChange {
  /** Directory such as `/blog/`, prefixed with the host when URLs span several hosts. */
  section: string;
  before: number;
  after: number;
  delta: number;
  /** Relative change in percent; `null` when the section is new. */
  pct: number | null;
}

export interface SectionOptions {
  /** Directory depth (default 1: `/blog/`; 2: `/blog/2026/`). */
  depth?: number;
  /** Prefix sections with the host: `true`, `false` or `auto` (default: when several hosts appear). */
  includeHost?: boolean | 'auto';
}

function hostCount(lists: Array<Iterable<string>>): number {
  const hosts = new Set<string>();
  for (const list of lists) for (const loc of list) hosts.add(parseHttpUrl(loc)?.host ?? '');
  return hosts.size;
}

export function sectionOf(loc: string, depth: number, withHost: boolean): string {
  const section = pathSection(loc, depth);
  if (!withHost) return section;
  const host = parseHttpUrl(loc)?.host ?? '';
  return `${host}${section}`;
}

/** URL counts per directory. */
export function countSections(locs: Iterable<string>, options: SectionOptions = {}): Map<string, number> {
  const depth = options.depth ?? 1;
  const list = [...locs];
  const withHost = options.includeHost === 'auto' || options.includeHost === undefined ? hostCount([list]) > 1 : options.includeHost;
  const counts = new Map<string, number>();
  for (const loc of list) {
    const key = sectionOf(loc, depth, withHost);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Per-directory growth between two sets of URLs, largest absolute change first. */
export function sectionGrowth(before: Iterable<string>, after: Iterable<string>, options: SectionOptions = {}): SectionChange[] {
  const b = [...before];
  const a = [...after];
  const withHost = options.includeHost === 'auto' || options.includeHost === undefined ? hostCount([b, a]) > 1 : options.includeHost;
  const opts = { depth: options.depth ?? 1, includeHost: withHost };
  const cb = countSections(b, opts);
  const ca = countSections(a, opts);
  const keys = new Set([...cb.keys(), ...ca.keys()]);
  const out: SectionChange[] = [];
  for (const section of keys) {
    const x = cb.get(section) ?? 0;
    const y = ca.get(section) ?? 0;
    out.push({ section, before: x, after: y, delta: y - x, pct: x === 0 ? null : Math.round(((y - x) / x) * 1000) / 10 });
  }
  return out.sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta) || q.after - p.after || (p.section < q.section ? -1 : 1));
}
