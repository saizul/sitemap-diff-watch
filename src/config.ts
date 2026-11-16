import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { AlertRules } from './alerts/rules.js';
import { ConfigError, errorMessage } from './errors.js';
import { compileUrlPattern } from './filter/url-filter.js';
import { parseHttpUrl } from './util/url.js';

export type ReportFormat = 'md' | 'html' | 'json' | 'rss';

export interface SlackChannelConfig {
  type: 'slack';
  url: string;
}
export interface TelegramChannelConfig {
  type: 'telegram';
  botToken: string;
  chatId: string;
  messageThreadId?: number;
}
export interface WebhookChannelConfig {
  type: 'webhook';
  url: string;
  secret?: string;
  headers?: Record<string, string>;
}
export type ChannelConfig = SlackChannelConfig | TelegramChannelConfig | WebhookChannelConfig;

export interface AlertsConfig {
  rules?: AlertRules;
  channels?: ChannelConfig[];
  /** URLs listed per alert (default 10). */
  maxUrls?: number;
}

export interface ValidateConfig {
  /** Run validation (default true). */
  enabled?: boolean;
  /** Check URLs against robots.txt (default true). */
  robots?: boolean;
  /** Product token used for robots.txt matching (default `Googlebot`). */
  robotsUserAgent?: string;
  /** HEAD-check URLs (default false), or options. */
  head?: boolean | { maxUrls?: number; ratePerSecond?: number; concurrency?: number };
  canonicalHost?: string;
  canonicalProtocol?: 'https:' | 'http:';
  futureToleranceHours?: number;
  checkScope?: boolean;
}

export interface SiteConfig {
  /** Short name; used for the snapshot directory and in reports. */
  name: string;
  /** Sitemap or sitemap index URLs. */
  sitemaps?: string[];
  /** Site URL whose robots.txt lists the sitemaps (used when `sitemaps` is empty). */
  discover?: string;
  maxDepth?: number;
  maxSitemaps?: number;
  /** Directory depth for section growth (default 1). */
  sectionDepth?: number;
  /** Only keep URLs matching one of these patterns (see `UrlFilterSpec`). */
  include?: string[];
  /** Drop URLs matching any of these patterns. */
  exclude?: string[];
  /** Do not download child sitemaps whose URL matches any of these patterns. */
  excludeSitemaps?: string[];
  validate?: ValidateConfig;
  alerts?: AlertsConfig;
}

export interface WatchConfig {
  store?: { type?: 'json' | 'sqlite'; path?: string; compress?: boolean };
  reports?: {
    dir?: string;
    formats?: ReportFormat[];
    maxItems?: number;
    /** Public base URL of the reports directory, used for links in alerts and the RSS self link. */
    baseUrl?: string;
  };
  http?: { userAgent?: string; timeoutMs?: number; retries?: number; concurrency?: number };
  /** Snapshots kept per site (default 120; 0 keeps all). */
  keep?: number;
  /** Snapshots used for history velocity and the RSS feed (default 12). */
  historyWindow?: number;
  validate?: ValidateConfig;
  alerts?: AlertsConfig;
  sites: SiteConfig[];
}

export interface LoadedConfig {
  config: WatchConfig;
  /** Directory of the config file; relative paths resolve against it. */
  baseDir: string;
  /** `${VAR}` references that were not set. Alert channels using them are skipped. */
  missingEnv: string[];
}

const FORMATS: ReportFormat[] = ['md', 'html', 'json', 'rss'];

/** Replace `${NAME}` in every string with the environment variable, recording missing ones. */
export function interpolateEnv<T>(value: T, env: NodeJS.ProcessEnv, missing: Set<string>): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, name: string) => {
      const v = env[name];
      if (v === undefined || v === '') {
        missing.add(name);
        return '';
      }
      return v;
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env, missing)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env, missing)])) as T;
  }
  return value;
}

function fail(message: string): never {
  throw new ConfigError(message);
}

function checkChannel(ch: unknown, where: string): void {
  const c = ch as Partial<ChannelConfig> & Record<string, unknown>;
  if (!c || typeof c !== 'object') fail(`${where}: must be an object`);
  if (c.type === 'slack' || c.type === 'webhook') {
    if (typeof c.url !== 'string') fail(`${where}: "url" is required`);
  } else if (c.type === 'telegram') {
    if (typeof c['botToken'] !== 'string' || (typeof c['chatId'] !== 'string' && typeof c['chatId'] !== 'number')) {
      fail(`${where}: "botToken" and "chatId" are required`);
    }
  } else fail(`${where}: "type" must be slack, telegram or webhook`);
}

/** Validate a parsed config object and fill nothing in; defaults are applied where used. */
export function validateConfig(raw: unknown): WatchConfig {
  const c = raw as Partial<WatchConfig> | null;
  if (!c || typeof c !== 'object') fail('config must be a JSON object');
  if (!Array.isArray(c.sites) || c.sites.length === 0) fail('"sites" must be a non-empty array');
  const names = new Set<string>();
  c.sites.forEach((s, i) => {
    const where = `sites[${i}]`;
    if (!s || typeof s !== 'object') fail(`${where} must be an object`);
    if (typeof s.name !== 'string' || !s.name.trim()) fail(`${where}.name is required`);
    if (names.has(s.name)) fail(`${where}.name "${s.name}" is used twice`);
    names.add(s.name);
    if (s.sitemaps !== undefined && (!Array.isArray(s.sitemaps) || s.sitemaps.some((u) => typeof u !== 'string' || !parseHttpUrl(u)))) {
      fail(`${where}.sitemaps must be a list of http(s) URLs`);
    }
    if (!s.sitemaps?.length && !(typeof s.discover === 'string' && parseHttpUrl(s.discover))) fail(`${where} needs "sitemaps" or a "discover" URL`);
    s.alerts?.channels?.forEach((ch, j) => checkChannel(ch, `${where}.alerts.channels[${j}]`));
    if (s.sectionDepth !== undefined && (!Number.isInteger(s.sectionDepth) || s.sectionDepth < 1)) fail(`${where}.sectionDepth must be a positive integer`);
    for (const key of ['include', 'exclude', 'excludeSitemaps'] as const) {
      const list: unknown = s[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some((p) => typeof p !== 'string')) fail(`${where}.${key} must be a list of strings`);
      (list as string[]).forEach((p, j) => {
        try {
          compileUrlPattern(p);
        } catch (error) {
          fail(`${where}.${key}[${j}]: ${errorMessage(error)}`);
        }
      });
    }
  });
  c.alerts?.channels?.forEach((ch, j) => checkChannel(ch, `alerts.channels[${j}]`));
  if (c.store?.type !== undefined && c.store.type !== 'json' && c.store.type !== 'sqlite') fail('store.type must be "json" or "sqlite"');
  for (const f of c.reports?.formats ?? []) if (!FORMATS.includes(f)) fail(`reports.formats: unknown format "${f}" (use ${FORMATS.join(', ')})`);
  if (c.keep !== undefined && (!Number.isInteger(c.keep) || c.keep < 0)) fail('keep must be a non-negative integer');
  return c as WatchConfig;
}

export async function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read config ${path}: ${errorMessage(error)}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`config ${path} is not valid JSON: ${errorMessage(error)}`, { cause: error });
  }
  const missing = new Set<string>();
  const config = validateConfig(interpolateEnv(raw, env, missing));
  return { config, baseDir: dirname(resolve(path)), missingEnv: [...missing].sort() };
}

export function resolvePath(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}
