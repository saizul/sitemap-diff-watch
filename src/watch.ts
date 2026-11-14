import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SlackChannel, TelegramChannel, WebhookChannel, sendAlerts, type AlertChannel, type ChannelResult } from './alerts/channels.js';
import { buildAlertMessage } from './alerts/message.js';
import { evaluateAlert } from './alerts/rules.js';
import { resolvePath, type ChannelConfig, type LoadedConfig, type ReportFormat, type SiteConfig } from './config.js';
import { diffSnapshots, type SnapshotDiff } from './diff/diff.js';
import { velocityFromHistory, velocityFromLastmod } from './diff/velocity.js';
import { errorMessage } from './errors.js';
import { crawlSitemaps } from './fetch/crawler.js';
import { discoverSitemaps } from './fetch/discover.js';
import type { HttpOptions } from './fetch/http.js';
import { renderHtml } from './report/html.js';
import { renderJson } from './report/json.js';
import { renderMarkdown } from './report/markdown.js';
import { buildReport, type WatchReport } from './report/model.js';
import { renderRss, rssItemsFromDiffs } from './report/rss.js';
import { RobotsCache } from './robots/fetch-robots.js';
import { openStore } from './snapshot/index.js';
import { createSnapshot, type Snapshot } from './snapshot/snapshot.js';
import type { SnapshotStore } from './snapshot/store.js';
import { realClock, type ClockFn, type FetchLike, type SleepFn } from './types.js';
import { originOf, slugify } from './util/url.js';
import { validateEntries, type ValidationReport } from './validate/validate.js';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export interface WatchOptions {
  fetch?: FetchLike;
  clock?: ClockFn;
  sleep?: SleepFn;
  logger?: Logger;
  /** Skip sending alerts (reports and snapshots are still written). */
  dryRun?: boolean;
  /** Only run these sites (by name). */
  only?: string[];
  /** Use this store instead of opening the configured one. */
  store?: SnapshotStore;
}

export interface SiteRunResult {
  site: string;
  ok: boolean;
  error?: string;
  snapshotId?: string;
  urlCount?: number;
  diff?: SnapshotDiff['counts'];
  validation?: ValidationReport['bySeverity'];
  reports: string[];
  alert?: { fired: boolean; reasons: string[]; results: ChannelResult[] };
  report?: WatchReport;
}

/** Build alert channels; channels that reference unset environment variables are skipped. */
export function buildChannels(configs: ChannelConfig[], http: HttpOptions, logger: Logger, sleep?: SleepFn): AlertChannel[] {
  const channels: AlertChannel[] = [];
  for (const c of configs) {
    if (c.type === 'slack') {
      if (!c.url) logger.warn('slack alert skipped: url is empty (environment variable not set?)');
      else channels.push(new SlackChannel(c.url, http));
    } else if (c.type === 'telegram') {
      if (!c.botToken || !String(c.chatId)) logger.warn('telegram alert skipped: botToken or chatId is empty (environment variable not set?)');
      else channels.push(new TelegramChannel({ botToken: c.botToken, chatId: c.chatId, ...(c.messageThreadId !== undefined ? { messageThreadId: c.messageThreadId } : {}), http, ...(sleep ? { sleep } : {}) }));
    } else if (c.type === 'webhook') {
      if (!c.url) logger.warn('webhook alert skipped: url is empty (environment variable not set?)');
      else channels.push(new WebhookChannel({ url: c.url, ...(c.secret ? { secret: c.secret } : {}), ...(c.headers ? { headers: c.headers } : {}), http }));
    }
  }
  return channels;
}

const EXT: Record<ReportFormat, string> = { md: 'report.md', html: 'report.html', json: 'report.json', rss: 'new-urls.xml' };

/**
 * Run every configured site once: fetch the sitemaps, store a snapshot, compare it with the
 * previous one, validate, write reports and send alerts. One site failing does not stop
 * the others.
 */
export async function runWatch(loaded: LoadedConfig, options: WatchOptions = {}): Promise<SiteRunResult[]> {
  const { config, baseDir } = loaded;
  const logger = options.logger ?? silentLogger;
  const clock = options.clock ?? realClock;
  const http: HttpOptions = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(config.http?.userAgent ? { userAgent: config.http.userAgent } : {}),
    ...(config.http?.timeoutMs !== undefined ? { timeoutMs: config.http.timeoutMs } : {}),
    ...(config.http?.retries !== undefined ? { retries: config.http.retries } : {}),
  };
  for (const name of loaded.missingEnv) logger.warn(`environment variable ${name} is not set`);
  const store =
    options.store ??
    (await openStore(
      {
        type: config.store?.type ?? 'json',
        path: resolvePath(baseDir, config.store?.path ?? (config.store?.type === 'sqlite' ? 'snapshots/snapshots.sqlite' : 'snapshots')),
        ...(config.store?.compress !== undefined ? { compress: config.store.compress } : {}),
      },
      (m) => logger.warn(m),
    ));
  const results: SiteRunResult[] = [];
  try {
    for (const site of config.sites) {
      if (options.only?.length && !options.only.includes(site.name)) continue;
      try {
        results.push(await runSite(site, loaded, store, http, logger, clock, options));
      } catch (error) {
        logger.error(`${site.name}: ${errorMessage(error)}`);
        results.push({ site: site.name, ok: false, error: errorMessage(error), reports: [] });
      }
    }
  } finally {
    if (!options.store) await store.close();
  }
  return results;
}

async function runSite(
  site: SiteConfig,
  loaded: LoadedConfig,
  store: SnapshotStore,
  http: HttpOptions,
  logger: Logger,
  clock: ClockFn,
  options: WatchOptions,
): Promise<SiteRunResult> {
  const { config, baseDir } = loaded;
  let roots = site.sitemaps ?? [];
  let robots: RobotsCache | undefined;
  const validateCfg = { ...config.validate, ...site.validate };
  if (validateCfg.enabled !== false && validateCfg.robots !== false) robots = new RobotsCache(http, validateCfg.robotsUserAgent ?? 'Googlebot');

  if (!roots.length && site.discover) {
    const found = await discoverSitemaps(site.discover, http);
    robots?.set(found.origin, found.robots);
    roots = found.sitemaps;
    logger.info(`${site.name}: discovered ${roots.length} sitemap(s) via ${found.source}`);
    if (!roots.length) throw new Error(`no sitemap found for ${site.discover}`);
  }

  logger.info(`${site.name}: fetching ${roots.join(', ')}`);
  const crawl = await crawlSitemaps(roots, {
    http,
    clock,
    ...(site.maxDepth !== undefined ? { maxDepth: site.maxDepth } : {}),
    ...(site.maxSitemaps !== undefined ? { maxSitemaps: site.maxSitemaps } : {}),
    ...(config.http?.concurrency !== undefined ? { concurrency: config.http.concurrency } : {}),
  });
  const snapshot = createSnapshot(site.name, crawl);
  logger.info(`${site.name}: ${snapshot.stats.uniqueUrlCount} URLs in ${snapshot.stats.sitemapCount} sitemap(s)`);

  const window = Math.max(2, config.historyWindow ?? 12);
  const earlier = await store.latest(site.name, window - 1);
  const previous = earlier[earlier.length - 1];
  const diffOptions = { sections: { depth: site.sectionDepth ?? 1 } };
  const diff = previous ? diffSnapshots(previous, snapshot, diffOptions) : undefined;

  let validation: ValidationReport | undefined;
  if (validateCfg.enabled !== false) {
    const head = validateCfg.head;
    validation = await validateEntries(snapshot.urls, {
      roots,
      warnings: snapshot.warnings,
      clock,
      ...(robots ? { robots } : {}),
      ...(head ? { head: { http, ...(options.sleep ? { sleep: options.sleep } : {}), ...(typeof head === 'object' ? head : {}) } } : {}),
      ...(validateCfg.canonicalHost ? { canonicalHost: validateCfg.canonicalHost } : {}),
      ...(validateCfg.canonicalProtocol ? { canonicalProtocol: validateCfg.canonicalProtocol } : {}),
      ...(validateCfg.futureToleranceHours !== undefined ? { futureToleranceMs: validateCfg.futureToleranceHours * 3_600_000 } : {}),
      ...(validateCfg.checkScope !== undefined ? { checkScope: validateCfg.checkScope } : {}),
    });
  }

  await store.save(snapshot);
  const keep = config.keep ?? 120;
  if (keep > 0) {
    const removed = await store.prune(site.name, keep);
    if (removed.length) logger.info(`${site.name}: pruned ${removed.length} old snapshot(s)`);
  }

  const historySnaps: Snapshot[] = [...earlier, snapshot];
  const now = clock();
  const report = buildReport({
    snapshot,
    previous,
    diff,
    validation,
    velocity: {
      ...(historySnaps.length > 1 ? { history: velocityFromHistory(historySnaps, 'week') } : {}),
      lastmod: velocityFromLastmod(snapshot.urls, { bucket: 'week', now }),
    },
    history: await store.list(site.name),
    now,
  });

  const reports: string[] = [];
  const formats = config.reports?.formats ?? ['md', 'html', 'json', 'rss'];
  const reportDir = resolvePath(baseDir, join(config.reports?.dir ?? 'reports', slugify(site.name)));
  const baseUrl = config.reports?.baseUrl?.replace(/\/?$/, '/');
  if (formats.length) {
    await mkdir(reportDir, { recursive: true });
    const maxItems = config.reports?.maxItems;
    for (const format of formats) {
      let content: string;
      if (format === 'md') content = renderMarkdown(report, maxItems !== undefined ? { maxItems } : {});
      else if (format === 'html') content = renderHtml(report, maxItems !== undefined ? { maxItems } : {});
      else if (format === 'json') content = renderJson(report, maxItems !== undefined ? { maxItems } : {});
      else {
        const diffs: SnapshotDiff[] = [];
        for (let i = 1; i < historySnaps.length; i++) diffs.push(diffSnapshots(historySnaps[i - 1]!, historySnaps[i]!));
        content = renderRss(rssItemsFromDiffs(diffs), {
          title: `New URLs: ${site.name}`,
          link: originOf(roots[0]!) ?? roots[0]!,
          now,
          ...(baseUrl ? { selfUrl: `${baseUrl}${slugify(site.name)}/${EXT.rss}` } : {}),
        });
      }
      const file = join(reportDir, EXT[format]);
      await writeFile(file, content);
      reports.push(file);
    }
  }

  const alertsCfg = { ...config.alerts, ...site.alerts, rules: { ...config.alerts?.rules, ...site.alerts?.rules } };
  const decision = evaluateAlert(report, alertsCfg.rules);
  let alert: SiteRunResult['alert'];
  const channels = buildChannels(alertsCfg.channels ?? [], http, logger, options.sleep);
  if (decision.fire && channels.length) {
    if (options.dryRun) {
      logger.info(`${site.name}: would alert (${decision.reasons.join('; ')}) - dry run`);
      alert = { fired: false, reasons: decision.reasons, results: [] };
    } else {
      const message = buildAlertMessage(report, decision.reasons, {
        ...(alertsCfg.maxUrls !== undefined ? { maxUrls: alertsCfg.maxUrls } : {}),
        ...(baseUrl && formats.includes('html') ? { reportUrl: `${baseUrl}${slugify(site.name)}/${EXT.html}` } : {}),
      });
      const sent = await sendAlerts(channels, message);
      for (const r of sent) if (!r.ok) logger.warn(`${site.name}: ${r.channel} alert failed: ${r.error}`);
      alert = { fired: true, reasons: decision.reasons, results: sent };
    }
  } else {
    alert = { fired: false, reasons: decision.reasons, results: [] };
  }

  return {
    site: site.name,
    ok: true,
    snapshotId: snapshot.id,
    urlCount: snapshot.stats.uniqueUrlCount,
    ...(diff ? { diff: diff.counts } : {}),
    ...(validation ? { validation: validation.bySeverity } : {}),
    reports,
    alert,
    report,
  };
}

