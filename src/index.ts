export { VERSION, DEFAULT_USER_AGENT } from './version.js';
export * from './errors.js';
export * from './types.js';
export { SITEMAP_LIMITS, CHANGEFREQ_VALUES, NAMESPACES } from './limits.js';

// XML and parsing
export { XmlTokenizer, type XmlElement, type XmlHandler, type TokenizerOptions } from './xml/tokenizer.js';
export { decodeEntities, escapeXml, escapeHtml } from './xml/entities.js';
export { SitemapParser, parseSitemapXml, type DocumentKind, type ParseSummary, type ParserOptions, type ParserCallbacks } from './parse/sitemap-parser.js';
export { TextSitemapParser } from './parse/text-sitemap.js';
export { parseSitemapStream, parseSitemapBuffer, TooLargeError, DEFAULT_MAX_BYTES, type StreamParseOptions, type StreamParseResult } from './parse/stream.js';

// Fetching
export { httpRequest, fetchText, readLimited, retryAfterMs, type HttpOptions, type HttpRequest } from './fetch/http.js';
export { crawlSitemaps, type CrawlOptions, type CrawlResult, type CrawledUrl, type SitemapInfo } from './fetch/crawler.js';
export { discoverSitemaps, COMMON_SITEMAP_PATHS, type DiscoveryResult } from './fetch/discover.js';

// robots.txt
export { parseRobotsTxt, isAllowed, matchPattern, rulesFor, productToken, pathForMatching, ROBOTS_MAX_BYTES, type RobotsTxt, type RobotsRule, type RobotsGroup, type RobotsDecision } from './robots/robots.js';
export { fetchRobotsTxt, RobotsCache, type RobotsFetchResult, type RobotsStatus } from './robots/fetch-robots.js';

// Snapshots
export * from './snapshot/index.js';

// Diffs and trends
export { diffSnapshots, isEmptyDiff, type SnapshotDiff, type DiffOptions, type LastmodChange, type MetadataChange, type SitemapMove, type DiffSide } from './diff/diff.js';
export { sectionGrowth, countSections, sectionOf, type SectionChange, type SectionOptions } from './diff/sections.js';
export { clusterUrls, segmentToken, type UrlCluster, type ClusterOptions } from './diff/clusters.js';
export { velocityFromHistory, velocityFromLastmod, type Velocity, type VelocityPoint, type VelocityBucket, type LastmodVelocityOptions } from './diff/velocity.js';

// Validation
export { validateEntries, type ValidationIssue, type ValidationReport, type ValidateOptions, type Severity } from './validate/validate.js';
export { headCheck, spreadSample, type HeadCheckOptions, type HeadResult } from './validate/head-check.js';
export { checkHreflang } from './validate/hreflang.js';

// Reports
export { buildReport, type WatchReport, type BuildReportInput } from './report/model.js';
export { renderMarkdown, type MarkdownOptions } from './report/markdown.js';
export { renderJson, type JsonReportOptions } from './report/json.js';
export { renderHtml, type HtmlOptions } from './report/html.js';
export { renderLineChart, niceStep, type ChartPoint, type ChartOptions } from './report/svg-chart.js';
export { renderRss, rssItemsFromDiffs, type RssItem, type RssOptions } from './report/rss.js';

// Alerts
export { evaluateAlert, type AlertRules, type AlertDecision } from './alerts/rules.js';
export { buildAlertMessage, alertText, type AlertMessage } from './alerts/message.js';
export { SlackChannel, TelegramChannel, WebhookChannel, sendAlerts, slackPayload, telegramText, signBody, type AlertChannel, type ChannelResult, type TelegramOptions, type WebhookOptions } from './alerts/channels.js';

// Config and the watch pipeline
export { loadConfig, validateConfig, interpolateEnv, type WatchConfig, type SiteConfig, type LoadedConfig, type ChannelConfig, type ReportFormat, type ValidateConfig, type AlertsConfig } from './config.js';
export { runWatch, buildChannels, silentLogger, type WatchOptions, type SiteRunResult, type Logger } from './watch.js';

// Utilities
export { parseW3cDatetime, isValidW3cDatetime, w3cToTime, utcDay, utcWeekStart, isoWeekLabel, type W3cDatetimeResult } from './util/w3c-datetime.js';
export { parseHttpUrl, looseUrlKey, pathSection, slugify, titleFromUrl } from './util/url.js';
export { mapLimit, RateLimiter } from './util/concurrency.js';
export { runCli, type CliIo } from './cli-run.js';
