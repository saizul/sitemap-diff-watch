import type { UrlCluster } from '../diff/clusters.js';
import type { Velocity } from '../diff/velocity.js';
import { formatNumber, pct, signed, type WatchReport } from './model.js';

export interface MarkdownOptions {
  /** URLs listed per section (default 50). */
  maxItems?: number;
}

/** Escape text for a Markdown table cell or list item. */
export function mdEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/([|*_`[\]<>#])/g, '\\$1').replace(/\r?\n/g, ' ');
}

/** Inline code that cannot break out of its span or carry raw HTML. */
function code(text: string): string {
  return `\`${text.replace(/`/g, "'").replace(/[<>|]/g, encodeURIComponent).replace(/\r?\n/g, ' ')}\``;
}

function link(url: string): string {
  return `<${url.replace(/[<>\s]/g, encodeURIComponent)}>`;
}

function list(lines: string[], items: string[], total: number, max: number): void {
  for (const item of items.slice(0, max)) lines.push(`- ${item}`);
  if (total > max) lines.push(`- ... and ${formatNumber(total - max)} more`);
  lines.push('');
}

function clusters(lines: string[], title: string, items: UrlCluster[]): void {
  if (!items.length) return;
  lines.push(`#### ${title}`, '', '| Pattern | URLs | Example |', '| --- | ---: | --- |');
  for (const c of items.slice(0, 15)) lines.push(`| ${code(c.pattern)} | ${formatNumber(c.count)} | ${link(c.examples[0] ?? '')} |`);
  lines.push('');
}

function velocity(lines: string[], title: string, v: Velocity): void {
  lines.push(`#### ${title}`, '');
  lines.push(`${formatNumber(v.total)} URLs over ${v.days} days: **${v.perDay}/day**, **${v.perWeek}/week**.`, '');
  const recent = v.series.slice(-12);
  if (recent.length) {
    lines.push(`| ${v.bucket === 'week' ? 'Week of' : 'Day'} | New URLs |`, '| --- | ---: |');
    for (const p of recent) lines.push(`| ${p.period} | ${formatNumber(p.count)} |`);
    lines.push('');
  }
}

export function renderMarkdown(report: WatchReport, options: MarkdownOptions = {}): string {
  const max = options.maxItems ?? 50;
  const lines: string[] = [];
  const s = report.snapshot.stats;
  lines.push(`# Sitemap report: ${mdEscape(report.site)}`, '');
  lines.push(`Snapshot \`${report.snapshot.id}\` taken ${report.snapshot.createdAt}${report.previous ? `, compared with \`${report.previous.id}\` (${report.previous.createdAt})` : ''}.`, '');
  lines.push('| Metric | Value |', '| --- | ---: |');
  lines.push(`| URLs (distinct) | ${formatNumber(s.uniqueUrlCount)} |`);
  lines.push(`| Entries | ${formatNumber(s.urlCount)} |`);
  lines.push(`| Sitemaps | ${formatNumber(s.sitemapCount)}${s.errorCount ? ` (${s.errorCount} failed)` : ''} |`);
  if (s.imageCount) lines.push(`| Images | ${formatNumber(s.imageCount)} |`);
  if (s.videoCount) lines.push(`| Videos | ${formatNumber(s.videoCount)} |`);
  if (s.newsCount) lines.push(`| News entries | ${formatNumber(s.newsCount)} |`);
  if (s.alternateCount) lines.push(`| hreflang links | ${formatNumber(s.alternateCount)} |`);
  lines.push(`| Downloaded (uncompressed) | ${formatNumber(Math.round(s.bytes / 1024))} KiB |`);
  lines.push('');

  const d = report.diff;
  if (d) {
    const c = d.counts;
    lines.push('## Changes', '');
    lines.push(`**${signed(c.net)} URLs** (${pct(c.growthPct)}): ${formatNumber(c.added)} added, ${formatNumber(c.removed)} removed, ${formatNumber(c.lastmodChanged)} lastmod changes, ${formatNumber(c.metadataChanged)} metadata changes, ${formatNumber(c.moved)} moved between sitemaps.`, '');
    if (d.sections.length) {
      lines.push('### Sections', '', '| Section | Before | After | Change |', '| --- | ---: | ---: | ---: |');
      for (const sec of d.sections.slice(0, 20)) lines.push(`| ${code(sec.section)} | ${formatNumber(sec.before)} | ${formatNumber(sec.after)} | ${signed(sec.delta)} (${pct(sec.pct)}) |`);
      lines.push('');
    }
    if (d.addedClusters.length || d.removedClusters.length) {
      lines.push('### URL patterns', '');
      clusters(lines, 'Added', d.addedClusters);
      clusters(lines, 'Removed', d.removedClusters);
    }
    if (c.added) {
      lines.push(`### Added (${formatNumber(c.added)})`, '');
      list(lines, d.added.map((u) => `${link(u.loc)}${u.lastmod ? ` (lastmod ${mdEscape(u.lastmod)})` : ''}`), c.added, max);
    }
    if (c.removed) {
      lines.push(`### Removed (${formatNumber(c.removed)})`, '');
      list(lines, d.removed.map((u) => link(u.loc)), c.removed, max);
    }
    if (c.lastmodChanged) {
      lines.push(`### Lastmod changed (${formatNumber(c.lastmodChanged)})`, '');
      list(lines, d.lastmodChanged.map((x) => `${link(x.loc)}: ${mdEscape(x.before ?? 'none')} -> ${mdEscape(x.after ?? 'none')}`), c.lastmodChanged, max);
    }
    if (c.metadataChanged) {
      lines.push(`### Metadata changed (${formatNumber(c.metadataChanged)})`, '');
      list(lines, d.metadataChanged.map((x) => `${link(x.loc)}: ${x.fields.join(', ')}`), c.metadataChanged, max);
    }
    if (c.moved) {
      lines.push(`### Moved between sitemaps (${formatNumber(c.moved)})`, '');
      list(lines, d.moved.map((x) => `${link(x.loc)}: ${link(x.from)} -> ${link(x.to)}`), c.moved, max);
    }
  } else {
    lines.push('## Changes', '', 'First snapshot for this site; nothing to compare yet.', '');
  }

  if (report.velocity?.history || report.velocity?.lastmod) {
    lines.push('## Velocity', '');
    if (report.velocity.history) velocity(lines, 'New URLs between snapshots', report.velocity.history);
    if (report.velocity.lastmod) velocity(lines, 'URLs by lastmod', report.velocity.lastmod);
  }

  const v = report.validation;
  if (v) {
    lines.push('## Validation', '');
    lines.push(`${formatNumber(v.bySeverity.error)} errors, ${formatNumber(v.bySeverity.warning)} warnings, ${formatNumber(v.bySeverity.info)} notices.`, '');
    const codes = Object.entries(v.counts).sort((a, b) => b[1] - a[1]);
    if (codes.length) {
      lines.push('| Issue | Count |', '| --- | ---: |');
      for (const [code, n] of codes) lines.push(`| \`${code}\` | ${formatNumber(n)} |`);
      lines.push('');
      const shown = v.issues.filter((i) => i.severity !== 'info').slice(0, max);
      if (shown.length) {
        lines.push('### Details', '');
        for (const i of shown) lines.push(`- **${i.severity}** \`${i.code}\`${i.loc ? ` ${link(i.loc)}` : i.sitemap ? ` ${link(i.sitemap)}` : ''}: ${mdEscape(i.message)}`);
        const rest = v.bySeverity.error + v.bySeverity.warning - shown.length;
        if (rest > 0) lines.push(`- ... and ${formatNumber(rest)} more`);
        lines.push('');
      }
    }
  }

  const failed = report.sitemaps.filter((x) => x.status === 'error');
  if (failed.length) {
    lines.push('## Failed sitemaps', '');
    for (const f of failed) lines.push(`- ${link(f.url)}: ${mdEscape(f.error ?? 'error')}`);
    lines.push('');
  }
  lines.push(`<sub>${mdEscape(report.tool)}, ${report.generatedAt}</sub>`, '');
  return lines.join('\n');
}
