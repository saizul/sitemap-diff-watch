import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { loadConfig } from './config.js';
import { diffSnapshots } from './diff/diff.js';
import { velocityFromHistory, velocityFromLastmod } from './diff/velocity.js';
import { errorMessage, SitemapWatchError } from './errors.js';
import { crawlSitemaps } from './fetch/crawler.js';
import { discoverSitemaps } from './fetch/discover.js';
import { compileUrlFilter, FilterError, filterKey, filterSnapshot, type UrlFilter } from './filter/url-filter.js';
import type { HttpOptions } from './fetch/http.js';
import { parseSitemapBuffer } from './parse/stream.js';
import { renderHtml } from './report/html.js';
import { renderJson } from './report/json.js';
import { renderMarkdown } from './report/markdown.js';
import { buildReport } from './report/model.js';
import { renderRss, rssItemsFromDiffs } from './report/rss.js';
import { RobotsCache } from './robots/fetch-robots.js';
import { openStore } from './snapshot/index.js';
import { assertSnapshot, createSnapshot, type Snapshot, type SnapshotMeta } from './snapshot/snapshot.js';
import type { FetchLike, SleepFn } from './types.js';
import { originOf } from './util/url.js';
import { validateEntries, type Severity } from './validate/validate.js';
import { VERSION } from './version.js';
import { runWatch, type Logger } from './watch.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch?: FetchLike;
  sleep?: SleepFn;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const HELP = `sitemap-diff-watch ${VERSION}
Monitor XML sitemaps over time: snapshots, diffs, validation, reports and alerts.

Usage:
  sitemap-diff-watch <command> [options]

Commands:
  discover <site-url>                 List the sitemaps in a site's robots.txt
  fetch <sitemap-url>...              Fetch sitemaps (indexes recursively) and print a summary
      --out <file.json[.gz]>          Also write the snapshot to a file
      --urls                          Print every URL instead of the summary
  parse <file>                        Parse a local sitemap file (.xml, .xml.gz, .txt)
  snapshot <sitemap-url>... --site <name>
                                      Fetch and store a snapshot, then print what changed
  diff --site <name> [--from <id>] [--to <id>]
  diff <old.json[.gz]> <new.json[.gz]>
                                      Compare two snapshots
  history --site <name>               List stored snapshots
  validate <sitemap-url>...           Fetch and validate sitemaps
      --robots                        Check URLs against robots.txt (user agent: --user-agent)
      --head                          HEAD-check URLs (rate limited; see --head-max, --head-rate)
      --canonical-host <host>         Expected host, e.g. www.example.com
      --fail-on <error|warning|none>  Exit with 1 when issues of this level exist (default error)
  watch --config <file>               Run every site in a config file (see examples/)
      --site <name>                   Only this site (repeatable)
      --dry-run                       Do not send alerts

Common options:
  --store <dir|file.sqlite>           Snapshot store (default ./snapshots; .sqlite/.db uses node:sqlite)
  --format <md|json|html|rss>         Output format for diff and validate (default md)
  --output, -o <file>                 Write the output to a file instead of stdout
  --max-depth <n>                     Sitemap index depth to follow (default 3)
  --include <pattern>                 Only keep matching URLs (repeatable; fetch, snapshot, diff, validate)
  --exclude <pattern>                 Drop matching URLs (repeatable)
  --exclude-sitemap <pattern>         Do not download matching child sitemaps (repeatable)
                                      Patterns: /path/** (path glob), https://host/path/* (URL glob),
                                      host/path/** (host glob) or re:<regex>
  --user-agent <ua>                   User-Agent for requests; product token for robots.txt
  --timeout <ms>                      Request timeout, body included (default 60000)
  --json                              Machine-readable output where supported
  -h, --help                          Show this help
  -v, --version                       Show the version
`;

class UsageError extends SitemapWatchError {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  out: { type: 'string' },
  output: { type: 'string', short: 'o' },
  urls: { type: 'boolean' },
  site: { type: 'string', multiple: true },
  store: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  format: { type: 'string' },
  robots: { type: 'boolean' },
  head: { type: 'boolean' },
  'head-max': { type: 'string' },
  'head-rate': { type: 'string' },
  'canonical-host': { type: 'string' },
  'fail-on': { type: 'string' },
  config: { type: 'string', short: 'c' },
  'dry-run': { type: 'boolean' },
  'max-depth': { type: 'string' },
  include: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  'exclude-sitemap': { type: 'string', multiple: true },
  'user-agent': { type: 'string' },
  timeout: { type: 'string' },
  json: { type: 'boolean' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

function int(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a non-negative number`);
  return n;
}

function httpFrom(values: Values, io: CliIo): HttpOptions {
  const timeout = int(values.timeout, 'timeout');
  return {
    ...(io.fetch ? { fetch: io.fetch } : {}),
    ...(io.sleep ? { sleep: io.sleep } : {}),
    ...(values['user-agent'] ? { userAgent: values['user-agent'] } : {}),
    ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
  };
}

function compileOption(spec: { include?: string[]; exclude?: string[] }, excludeName = 'exclude'): UrlFilter {
  try {
    return compileUrlFilter(spec);
  } catch (error) {
    if (!(error instanceof FilterError)) throw error;
    // "include[1]: message" -> "--include (pattern 2): message"
    const m = /^(include|exclude)\[(\d+)\]: (.*)$/s.exec(error.message);
    if (!m) throw new UsageError(error.message);
    throw new UsageError(`--${m[1] === 'include' ? 'include' : excludeName} (pattern ${Number(m[2]) + 1}): ${m[3]}`);
  }
}

/** The URL filter from --include / --exclude. */
function urlFilterFrom(values: Values): UrlFilter {
  return compileOption({ ...(values.include ? { include: values.include } : {}), ...(values.exclude ? { exclude: values.exclude } : {}) });
}

function storeConfig(path: string | undefined): { type: 'json' | 'sqlite'; path: string } {
  const p = path ?? 'snapshots';
  return /\.(sqlite3?|db)$/i.test(p) ? { type: 'sqlite', path: p } : { type: 'json', path: p };
}

async function readSnapshotFile(path: string): Promise<Snapshot> {
  const raw = await readFile(path);
  const text = raw[0] === 0x1f && raw[1] === 0x8b ? (await gunzipAsync(raw)).toString('utf8') : raw.toString('utf8');
  const value: unknown = JSON.parse(text);
  assertSnapshot(value);
  return value;
}

async function emit(io: CliIo, values: Values, content: string): Promise<void> {
  const out = values.output;
  if (out) await writeFile(out, content);
  else io.stdout(content.endsWith('\n') ? content : `${content}\n`);
}

function single(values: Values): string | undefined {
  return values.site?.[0];
}

/** Run the CLI. Returns the process exit code: 0 ok, 1 failure or issues found, 2 usage error. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    io.stderr(`${errorMessage(error)}\nRun "sitemap-diff-watch --help" for usage.\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  const [command, ...args] = positionals;
  if (values.help || !command) {
    io.stdout(HELP);
    return command || values.help ? 0 : 2;
  }
  const logger: Logger = {
    info: (m) => io.stderr(`${m}\n`),
    warn: (m) => io.stderr(`warning: ${m}\n`),
    error: (m) => io.stderr(`error: ${m}\n`),
  };
  const now = io.now ?? Date.now;
  try {
    switch (command) {
      case 'discover':
        return await cmdDiscover(args, values, io);
      case 'fetch':
        return await cmdFetch(args, values, io);
      case 'parse':
        return await cmdParse(args, values, io);
      case 'snapshot':
        return await cmdSnapshot(args, values, io, logger, now);
      case 'diff':
        return await cmdDiff(args, values, io, now);
      case 'history':
        return await cmdHistory(values, io);
      case 'validate':
        return await cmdValidate(args, values, io, now);
      case 'watch':
        return await cmdWatch(values, io, logger, now);
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\nRun "sitemap-diff-watch --help" for usage.\n`);
      return 2;
    }
    io.stderr(`error: ${errorMessage(error)}\n`);
    return 1;
  }
}

async function cmdDiscover(args: string[], values: Values, io: CliIo): Promise<number> {
  if (args.length !== 1) throw new UsageError('discover needs one site URL');
  const result = await discoverSitemaps(args[0]!, httpFrom(values, io));
  if (values.json) io.stdout(`${JSON.stringify({ origin: result.origin, source: result.source, robots: result.robots.status, sitemaps: result.sitemaps }, null, 2)}\n`);
  else {
    io.stderr(`robots.txt: ${result.robots.status}${result.robots.httpStatus ? ` (HTTP ${result.robots.httpStatus})` : ''}; sitemaps from: ${result.source}\n`);
    for (const s of result.sitemaps) io.stdout(`${s}\n`);
  }
  return result.sitemaps.length ? 0 : 1;
}

async function crawlFromArgs(args: string[], values: Values, io: CliIo): Promise<Awaited<ReturnType<typeof crawlSitemaps>>> {
  if (!args.length) throw new UsageError('give at least one sitemap URL');
  const maxDepth = int(values['max-depth'], 'max-depth');
  const sitemapFilter = values['exclude-sitemap'] ? compileOption({ exclude: values['exclude-sitemap'] }, 'exclude-sitemap') : undefined;
  return crawlSitemaps(args, {
    http: httpFrom(values, io),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    ...(sitemapFilter ? { filterSitemap: (url: string) => sitemapFilter.test(url) } : {}),
  });
}

function summaryLines(snapshot: Snapshot): string {
  const s = snapshot.stats;
  const lines = [
    `URLs: ${s.uniqueUrlCount} distinct, ${s.urlCount} entries`,
    `Sitemaps: ${s.sitemapCount}${s.errorCount ? ` (${s.errorCount} failed)` : ''}`,
    `Images: ${s.imageCount}, videos: ${s.videoCount}, news: ${s.newsCount}, hreflang links: ${s.alternateCount}`,
    `Downloaded: ${Math.round(s.bytes / 1024)} KiB uncompressed`,
  ];
  if (s.filter) lines.push(`Filtered: ${s.filter.excludedUrls} URL(s) out of scope (${scopeText(s.filter)})`);
  for (const sm of snapshot.sitemaps) {
    lines.push(`  ${sm.status === 'ok' ? 'ok ' : sm.status === 'error' ? 'ERR' : 'skip'} ${sm.url}${sm.kind ? ` [${sm.kind}${sm.gzip ? ', gzip' : ''}]` : ''} ${sm.urlCount || sm.sitemapCount}${sm.error ? ` ${sm.error}` : ''}`);
  }
  if (snapshot.warnings.length) {
    lines.push(`Warnings (${snapshot.warnings.length}):`);
    for (const w of snapshot.warnings.slice(0, 20)) lines.push(`  ${w.code}: ${w.message}`);
  }
  return `${lines.join('\n')}\n`;
}

function scopeText(f: { include: string[]; exclude: string[] }): string {
  return [f.include.length ? `include ${f.include.join(', ')}` : '', f.exclude.length ? `exclude ${f.exclude.join(', ')}` : ''].filter(Boolean).join('; ');
}

async function writeSnapshotFile(path: string, snapshot: Snapshot): Promise<void> {
  const json = JSON.stringify(snapshot);
  await writeFile(path, path.endsWith('.gz') ? await gzipAsync(json) : `${json}\n`);
}

async function cmdFetch(args: string[], values: Values, io: CliIo): Promise<number> {
  const filter = urlFilterFrom(values);
  const crawl = await crawlFromArgs(args, values, io);
  const snapshot = createSnapshot(single(values) ?? originOf(args[0]!) ?? args[0]!, crawl, { filter });
  if (values.out) await writeSnapshotFile(values.out, snapshot);
  if (values.urls) for (const u of new Set(snapshot.urls.map((x) => x.loc))) io.stdout(`${u}\n`);
  else if (values.json) io.stdout(`${JSON.stringify({ stats: snapshot.stats, sitemaps: snapshot.sitemaps, warnings: snapshot.warnings }, null, 2)}\n`);
  else io.stdout(summaryLines(snapshot));
  return snapshot.stats.errorCount ? 1 : 0;
}

async function cmdParse(args: string[], values: Values, io: CliIo): Promise<number> {
  if (args.length !== 1) throw new UsageError('parse needs one file');
  const data = await readFile(args[0]!);
  const { result, urls, sitemaps, warnings } = await parseSitemapBuffer(data, { source: args[0]! });
  if (values.urls) {
    for (const u of urls) io.stdout(`${u.loc}\n`);
    for (const s of sitemaps) io.stdout(`${s.loc}\n`);
  } else {
    io.stdout(`${JSON.stringify({ ...result, warnings, ...(values.json ? { urls, sitemaps } : {}) }, null, 2)}\n`);
  }
  return 0;
}

async function cmdSnapshot(args: string[], values: Values, io: CliIo, logger: Logger, now: () => number): Promise<number> {
  const site = single(values);
  if (!site) throw new UsageError('snapshot needs --site <name>');
  const filter = urlFilterFrom(values);
  const crawl = await crawlFromArgs(args, values, io);
  const snapshot = createSnapshot(site, crawl, { filter });
  const store = await openStore(storeConfig(values.store), (m) => logger.warn(m));
  try {
    let [previous] = await store.latest(site, 1);
    if (previous && filterKey(previous.stats.filter) !== filterKey(snapshot.stats.filter)) {
      logger.warn(`the URL filter differs from snapshot ${previous.id}; it is re-filtered for the diff, and URLs it left out may show as added`);
      previous = filterSnapshot(previous, filter);
    }
    await store.save(snapshot);
    io.stderr(summaryLines(snapshot));
    if (previous) {
      const diff = diffSnapshots(previous, snapshot);
      const report = buildReport({ snapshot, previous, diff, history: await store.list(site), now: now() });
      await emit(io, values, values.format === 'json' ? renderJson(report) : renderMarkdown(report));
    } else {
      io.stdout(`Stored first snapshot ${snapshot.id} for ${site} (${snapshot.stats.uniqueUrlCount} URLs).\n`);
    }
  } finally {
    await store.close();
  }
  return snapshot.stats.errorCount ? 1 : 0;
}

async function cmdDiff(args: string[], values: Values, io: CliIo, now: () => number): Promise<number> {
  const filter = urlFilterFrom(values);
  let before: Snapshot;
  let after: Snapshot;
  let history: SnapshotMeta[] | undefined;
  if (args.length === 2) {
    before = await readSnapshotFile(args[0]!);
    after = await readSnapshotFile(args[1]!);
  } else if (args.length === 0) {
    const site = single(values);
    if (!site) throw new UsageError('diff needs --site <name> or two snapshot files');
    const store = await openStore(storeConfig(values.store));
    try {
      const metas = await store.list(site);
      if (metas.length < 2 && !(values.from && values.to)) throw new SitemapWatchError(`need two snapshots of ${site} to compare; found ${metas.length}`);
      const toId = values.to ?? metas[metas.length - 1]!.id;
      const toIndex = metas.findIndex((m) => m.id === toId);
      const fromId = values.from ?? metas[toIndex - 1]?.id;
      if (!fromId) throw new SitemapWatchError(`no snapshot before ${toId}`);
      before = await store.load(site, fromId);
      after = await store.load(site, toId);
      history = metas;
    } finally {
      await store.close();
    }
  } else throw new UsageError('diff takes --site <name> or exactly two snapshot files');
  if (filter.active) {
    before = filterSnapshot(before, filter);
    after = filterSnapshot(after, filter);
  }
  const diff = diffSnapshots(before, after);
  const report = buildReport({
    snapshot: after,
    previous: before,
    diff,
    history: history ?? [before, after].map((s) => ({ id: s.id, site: s.site, createdAt: s.createdAt, stats: s.stats })),
    velocity: { history: velocityFromHistory([before, after]), lastmod: velocityFromLastmod(after.urls, { now: now() }) },
    now: now(),
  });
  await emit(io, values, render(values.format ?? (values.json ? 'json' : 'md'), report, [diff], now()));
  return 0;
}

function render(format: string, report: ReturnType<typeof buildReport>, diffs: ReturnType<typeof diffSnapshots>[], now: number): string {
  switch (format) {
    case 'md':
    case 'markdown':
      return renderMarkdown(report);
    case 'json':
      return renderJson(report);
    case 'html':
      return renderHtml(report);
    case 'rss':
      return renderRss(rssItemsFromDiffs(diffs), { title: `New URLs: ${report.site}`, link: originOf(report.roots[0] ?? '') ?? report.site, now });
    default:
      throw new UsageError(`unknown format "${format}" (use md, json, html or rss)`);
  }
}

async function cmdHistory(values: Values, io: CliIo): Promise<number> {
  const site = single(values);
  const store = await openStore(storeConfig(values.store));
  try {
    if (!site) {
      for (const s of await store.sites()) io.stdout(`${s}\n`);
      return 0;
    }
    const metas = await store.list(site);
    if (values.json) io.stdout(`${JSON.stringify(metas, null, 2)}\n`);
    else {
      io.stdout('id                    created                   urls     sitemaps errors\n');
      for (const m of metas) {
        io.stdout(`${m.id.padEnd(21)} ${m.createdAt.padEnd(25)} ${String(m.stats.uniqueUrlCount).padStart(8)} ${String(m.stats.sitemapCount).padStart(8)} ${String(m.stats.errorCount).padStart(6)}\n`);
      }
    }
    return 0;
  } finally {
    await store.close();
  }
}

async function cmdValidate(args: string[], values: Values, io: CliIo, now: () => number): Promise<number> {
  const failOn = (values['fail-on'] ?? 'error') as Severity | 'none';
  if (!['error', 'warning', 'info', 'none'].includes(failOn)) throw new UsageError('--fail-on must be error, warning, info or none');
  const http = httpFrom(values, io);
  const filter = urlFilterFrom(values);
  const crawl = await crawlFromArgs(args, values, io);
  const snapshot = createSnapshot(originOf(args[0]!) ?? args[0]!, crawl, { filter });
  const headMax = int(values['head-max'], 'head-max');
  const headRate = int(values['head-rate'], 'head-rate');
  const validation = await validateEntries(snapshot.urls, {
    roots: crawl.roots,
    warnings: crawl.warnings,
    clock: now,
    ...(values['canonical-host'] ? { canonicalHost: values['canonical-host'] } : {}),
    ...(values.robots ? { robots: new RobotsCache(http, values['user-agent'] ?? 'Googlebot') } : {}),
    ...(values.head ? { head: { http, ...(io.sleep ? { sleep: io.sleep } : {}), ...(headMax !== undefined ? { maxUrls: headMax } : {}), ...(headRate ? { ratePerSecond: headRate } : {}) } } : {}),
  });
  const report = buildReport({ snapshot, validation, now: now() });
  const format = values.format ?? (values.json ? 'json' : 'md');
  if (format === 'json') await emit(io, values, `${JSON.stringify(validation, null, 2)}\n`);
  else if (format === 'html') await emit(io, values, renderHtml(report));
  else if (format === 'md') await emit(io, values, renderMarkdown(report));
  else throw new UsageError(`unknown format "${format}" for validate (use md, json or html)`);
  const b = validation.bySeverity;
  const failing = failOn === 'none' ? 0 : failOn === 'error' ? b.error : failOn === 'warning' ? b.error + b.warning : b.error + b.warning + b.info;
  return failing > 0 ? 1 : 0;
}

async function cmdWatch(values: Values, io: CliIo, logger: Logger, now: () => number): Promise<number> {
  if (!values.config) throw new UsageError('watch needs --config <file>');
  const loaded = await loadConfig(values.config, io.env ?? process.env);
  const results = await runWatch(loaded, {
    logger,
    clock: now,
    ...(io.fetch ? { fetch: io.fetch } : {}),
    ...(io.sleep ? { sleep: io.sleep } : {}),
    ...(values['dry-run'] ? { dryRun: true } : {}),
    ...(values.site?.length ? { only: values.site } : {}),
  });
  if (values.json) io.stdout(`${JSON.stringify(results.map(({ report: _report, ...r }) => r), null, 2)}\n`);
  else {
    for (const r of results) {
      if (!r.ok) io.stdout(`${r.site}: FAILED ${r.error}\n`);
      else {
        const d = r.diff ? `+${r.diff.added} -${r.diff.removed} ~${r.diff.lastmodChanged}` : 'first snapshot';
        const v = r.validation ? `, ${r.validation.error} errors, ${r.validation.warning} warnings` : '';
        const a = r.alert?.fired ? `, alerted (${r.alert.reasons.join('; ')})` : '';
        io.stdout(`${r.site}: ${r.urlCount} URLs, ${d}${v}${a}\n`);
      }
    }
  }
  return results.every((r) => r.ok) ? 0 : 1;
}
