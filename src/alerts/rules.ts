import type { WatchReport } from '../report/model.js';

export interface AlertRules {
  /** Alert when at least this many URLs were added (default 1; 0 turns it off). */
  minAdded?: number;
  /** Alert when at least this many URLs were removed (default 1; 0 turns it off). */
  minRemoved?: number;
  /** Alert when removals reach this percentage of the previous URL count (off by default). */
  minRemovedPct?: number;
  /** Alert when at least this many lastmod values changed (default 0: off). */
  minLastmodChanged?: number;
  /** Alert when validation finds errors (default true). */
  onErrors?: boolean;
  /** Alert when sitemaps failed to download or parse (default true). */
  onFetchErrors?: boolean;
  /** Alert on every run, even without changes (default false). */
  always?: boolean;
}

export interface AlertDecision {
  fire: boolean;
  reasons: string[];
}

export function evaluateAlert(report: WatchReport, rules: AlertRules = {}): AlertDecision {
  const reasons: string[] = [];
  const c = report.diff?.counts;
  const minAdded = rules.minAdded ?? 1;
  const minRemoved = rules.minRemoved ?? 1;
  if (c) {
    if (minAdded > 0 && c.added >= minAdded) reasons.push(`${c.added} URLs added`);
    if (minRemoved > 0 && c.removed >= minRemoved) reasons.push(`${c.removed} URLs removed`);
    if (rules.minRemovedPct !== undefined && c.before > 0 && (c.removed / c.before) * 100 >= rules.minRemovedPct) {
      reasons.push(`${Math.round((c.removed / c.before) * 1000) / 10}% of URLs removed`);
    }
    if ((rules.minLastmodChanged ?? 0) > 0 && c.lastmodChanged >= rules.minLastmodChanged!) reasons.push(`${c.lastmodChanged} lastmod changes`);
  }
  if ((rules.onErrors ?? true) && report.validation && report.validation.bySeverity.error > 0) {
    reasons.push(`${report.validation.bySeverity.error} validation errors`);
  }
  if ((rules.onFetchErrors ?? true) && report.snapshot.stats.errorCount > 0) {
    reasons.push(`${report.snapshot.stats.errorCount} sitemaps failed`);
  }
  if (rules.always && reasons.length === 0) reasons.push('scheduled report');
  return { fire: reasons.length > 0, reasons: [...new Set(reasons)] };
}
