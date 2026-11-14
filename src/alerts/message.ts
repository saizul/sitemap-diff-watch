import { formatNumber, pct, signed, type WatchReport } from '../report/model.js';

/** Format-neutral content of an alert; each channel renders it in its own markup. */
export interface AlertMessage {
  site: string;
  title: string;
  reasons: string[];
  /** Short `label: value` lines. */
  facts: Array<[string, string]>;
  added: string[];
  removed: string[];
  addedTotal: number;
  removedTotal: number;
  topSections: string[];
  reportUrl?: string;
}

export function buildAlertMessage(report: WatchReport, reasons: string[], options: { maxUrls?: number; reportUrl?: string } = {}): AlertMessage {
  const max = options.maxUrls ?? 10;
  const d = report.diff;
  const facts: Array<[string, string]> = [['URLs', formatNumber(report.snapshot.stats.uniqueUrlCount)]];
  if (d) {
    facts.push(['Change', `${signed(d.counts.net)} (${pct(d.counts.growthPct)})`]);
    facts.push(['Added / removed', `${formatNumber(d.counts.added)} / ${formatNumber(d.counts.removed)}`]);
    if (d.counts.lastmodChanged) facts.push(['Lastmod changes', formatNumber(d.counts.lastmodChanged)]);
  }
  if (report.validation) facts.push(['Errors / warnings', `${formatNumber(report.validation.bySeverity.error)} / ${formatNumber(report.validation.bySeverity.warning)}`]);
  return {
    site: report.site,
    title: `Sitemap change: ${report.site}`,
    reasons,
    facts,
    added: (d?.added ?? []).slice(0, max).map((u) => u.loc),
    removed: (d?.removed ?? []).slice(0, max).map((u) => u.loc),
    addedTotal: d?.counts.added ?? 0,
    removedTotal: d?.counts.removed ?? 0,
    topSections: (d?.sections ?? []).slice(0, 5).map((s) => `${s.section} ${signed(s.delta)}`),
    ...(options.reportUrl ? { reportUrl: options.reportUrl } : {}),
  };
}

/** Plain text rendering, used by channels without markup and in logs. */
export function alertText(m: AlertMessage): string {
  const lines = [m.title, m.reasons.join('; '), ...m.facts.map(([k, v]) => `${k}: ${v}`)];
  if (m.topSections.length) lines.push(`Sections: ${m.topSections.join(', ')}`);
  if (m.added.length) lines.push('Added:', ...m.added.map((u) => `+ ${u}`), ...(m.addedTotal > m.added.length ? [`  and ${m.addedTotal - m.added.length} more`] : []));
  if (m.removed.length) lines.push('Removed:', ...m.removed.map((u) => `- ${u}`), ...(m.removedTotal > m.removed.length ? [`  and ${m.removedTotal - m.removed.length} more`] : []));
  if (m.reportUrl) lines.push(`Report: ${m.reportUrl}`);
  return lines.join('\n');
}
