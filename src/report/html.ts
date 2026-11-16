import type { UrlCluster } from '../diff/clusters.js';
import type { Velocity } from '../diff/velocity.js';
import { escapeHtml as e } from '../xml/entities.js';
import { formatNumber, pct, signed, type WatchReport } from './model.js';
import { renderLineChart } from './svg-chart.js';

export interface HtmlOptions {
  /** URLs listed per table (default 200). */
  maxItems?: number;
  title?: string;
}

const CSS = `
:root{color-scheme:light;--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--bad:#b91c1c;--warn:#b45309;--good:#15803d}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:#f9fafb}
main{max-width:1080px;margin:0 auto;padding:24px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}h3{font-size:15px;margin:20px 0 6px}
.muted{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px}.card b{display:block;font-size:20px}
.chart{background:#fff;border:1px solid var(--line);border-radius:8px;padding:8px;overflow-x:auto}.chart svg{max-width:100%;height:auto}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;margin:6px 0 12px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{background:#f3f4f6;font-weight:600}
td.n,th.n{text-align:right;white-space:nowrap}td a{color:var(--accent);word-break:break-all}code{font-size:12px}
.up{color:var(--good)}.down{color:var(--bad)}.error{color:var(--bad);font-weight:600}.warning{color:var(--warn);font-weight:600}.info{color:var(--muted)}
details{margin:6px 0}summary{cursor:pointer;font-weight:600}footer{margin-top:32px;color:var(--muted);font-size:12px}
`;

function a(url: string): string {
  return `<a href="${e(url)}" rel="noopener noreferrer">${e(url)}</a>`;
}

function delta(n: number): string {
  return `<span class="${n > 0 ? 'up' : n < 0 ? 'down' : ''}">${signed(n)}</span>`;
}

function more(total: number, shown: number, cols: number): string {
  return total > shown ? `<tr><td colspan="${cols}" class="muted">... and ${formatNumber(total - shown)} more</td></tr>` : '';
}

function clusterTable(title: string, clusters: UrlCluster[]): string {
  if (!clusters.length) return '';
  const rows = clusters
    .slice(0, 20)
    .map((c) => `<tr><td><code>${e(c.pattern)}</code></td><td class="n">${formatNumber(c.count)}</td><td>${c.examples.map(a).join('<br>')}</td></tr>`)
    .join('');
  return `<h3>${e(title)}</h3><table><thead><tr><th>Pattern</th><th class="n">URLs</th><th>Examples</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function velocityBlock(title: string, v: Velocity): string {
  const rows = v.series
    .slice(-12)
    .map((p) => `<tr><td>${e(p.period)}</td><td class="n">${formatNumber(p.count)}</td></tr>`)
    .join('');
  return `<h3>${e(title)}</h3><p>${formatNumber(v.total)} URLs over ${v.days} days: <b>${v.perDay}</b> per day, <b>${v.perWeek}</b> per week.</p>${
    rows ? `<table><thead><tr><th>${v.bucket === 'week' ? 'Week of' : 'Day'}</th><th class="n">URLs</th></tr></thead><tbody>${rows}</tbody></table>` : ''
  }`;
}

/** A single self-contained HTML page: inline CSS, an inline SVG chart, no scripts. */
export function renderHtml(report: WatchReport, options: HtmlOptions = {}): string {
  const max = options.maxItems ?? 200;
  const s = report.snapshot.stats;
  const title = options.title ?? `Sitemap report: ${report.site}`;
  const body: string[] = [];
  body.push(`<h1>${e(title)}</h1>`);
  body.push(
    `<p class="muted">Snapshot <code>${e(report.snapshot.id)}</code>, ${e(report.snapshot.createdAt)}${
      report.previous ? ` compared with <code>${e(report.previous.id)}</code>, ${e(report.previous.createdAt)}` : ''
    }. Sitemaps: ${report.roots.map(a).join(', ')}</p>`,
  );
  if (s.filter) {
    const parts = [s.filter.include.length ? `include ${s.filter.include.map((p) => `<code>${e(p)}</code>`).join(', ')}` : '', s.filter.exclude.length ? `exclude ${s.filter.exclude.map((p) => `<code>${e(p)}</code>`).join(', ')}` : ''];
    body.push(`<p class="muted">URL scope: ${parts.filter(Boolean).join('; ')}. ${formatNumber(s.filter.excludedUrls)} URLs out of scope.</p>`);
  }
  const c = report.diff?.counts;
  const cards: Array<[string, string]> = [
    ['URLs', formatNumber(s.uniqueUrlCount)],
    ['Sitemaps', `${formatNumber(s.sitemapCount)}${s.errorCount ? ` <span class="down">(${s.errorCount} failed)</span>` : ''}`],
  ];
  if (c) cards.push(['Net change', `${delta(c.net)} <span class="muted">${e(pct(c.growthPct))}</span>`], ['Added', formatNumber(c.added)], ['Removed', formatNumber(c.removed)], ['Lastmod changed', formatNumber(c.lastmodChanged)]);
  if (report.validation) cards.push(['Errors', formatNumber(report.validation.bySeverity.error)], ['Warnings', formatNumber(report.validation.bySeverity.warning)]);
  body.push(`<div class="cards">${cards.map(([k, v]) => `<div class="card"><span class="muted">${e(k)}</span><b>${v}</b></div>`).join('')}</div>`);

  const points = report.history.map((m) => ({ time: m.createdAt, value: m.stats.uniqueUrlCount }));
  body.push(`<div class="chart">${renderLineChart(points, { title: 'URLs in sitemaps over time' })}</div>`);

  const d = report.diff;
  if (d) {
    if (d.sections.length) {
      const rows = d.sections
        .slice(0, 30)
        .map((x) => `<tr><td><code>${e(x.section)}</code></td><td class="n">${formatNumber(x.before)}</td><td class="n">${formatNumber(x.after)}</td><td class="n">${delta(x.delta)}</td><td class="n">${e(pct(x.pct))}</td></tr>`)
        .join('');
      body.push(`<h2>Sections</h2><table><thead><tr><th>Section</th><th class="n">Before</th><th class="n">After</th><th class="n">Change</th><th class="n">%</th></tr></thead><tbody>${rows}</tbody></table>`);
    }
    if (d.addedClusters.length || d.removedClusters.length) {
      body.push('<h2>URL patterns</h2>', clusterTable('Added', d.addedClusters), clusterTable('Removed', d.removedClusters));
    }
    const urlTable = (heading: string, rows: string[], total: number, header: string, cols: number): void => {
      if (!total) return;
      body.push(`<details${total <= 50 ? ' open' : ''}><summary>${e(heading)} (${formatNumber(total)})</summary><table><thead>${header}</thead><tbody>${rows.slice(0, max).join('')}${more(total, Math.min(max, rows.length), cols)}</tbody></table></details>`);
    };
    body.push('<h2>Changes</h2>');
    if (!c!.added && !c!.removed && !c!.lastmodChanged && !c!.metadataChanged && !c!.moved) body.push('<p class="muted">No changes since the previous snapshot.</p>');
    urlTable('Added', d.added.slice(0, max).map((u) => `<tr><td>${a(u.loc)}</td><td>${e(u.lastmod ?? '')}</td></tr>`), c!.added, '<tr><th>URL</th><th>Lastmod</th></tr>', 2);
    urlTable('Removed', d.removed.slice(0, max).map((u) => `<tr><td>${a(u.loc)}</td><td>${e(u.lastmod ?? '')}</td></tr>`), c!.removed, '<tr><th>URL</th><th>Last lastmod</th></tr>', 2);
    urlTable('Lastmod changed', d.lastmodChanged.slice(0, max).map((x) => `<tr><td>${a(x.loc)}</td><td>${e(x.before ?? '')}</td><td>${e(x.after ?? '')}</td></tr>`), c!.lastmodChanged, '<tr><th>URL</th><th>Before</th><th>After</th></tr>', 3);
    urlTable('Metadata changed', d.metadataChanged.slice(0, max).map((x) => `<tr><td>${a(x.loc)}</td><td>${e(x.fields.join(', '))}</td></tr>`), c!.metadataChanged, '<tr><th>URL</th><th>Fields</th></tr>', 2);
    urlTable('Moved between sitemaps', d.moved.slice(0, max).map((x) => `<tr><td>${a(x.loc)}</td><td>${a(x.from)}</td><td>${a(x.to)}</td></tr>`), c!.moved, '<tr><th>URL</th><th>From</th><th>To</th></tr>', 3);
  } else {
    body.push('<h2>Changes</h2><p class="muted">First snapshot for this site; nothing to compare yet.</p>');
  }

  if (report.velocity?.history || report.velocity?.lastmod) {
    body.push('<h2>Velocity</h2>');
    if (report.velocity.history) body.push(velocityBlock('New URLs between snapshots', report.velocity.history));
    if (report.velocity.lastmod) body.push(velocityBlock('URLs by lastmod', report.velocity.lastmod));
  }

  const v = report.validation;
  if (v) {
    body.push(`<h2>Validation</h2><p>${formatNumber(v.bySeverity.error)} errors, ${formatNumber(v.bySeverity.warning)} warnings, ${formatNumber(v.bySeverity.info)} notices.</p>`);
    const codes = Object.entries(v.counts).sort((x, y) => y[1] - x[1]);
    if (codes.length) {
      body.push(`<table><thead><tr><th>Issue</th><th class="n">Count</th></tr></thead><tbody>${codes.map(([k, n]) => `<tr><td><code>${e(k)}</code></td><td class="n">${formatNumber(n)}</td></tr>`).join('')}</tbody></table>`);
      const rows = v.issues.slice(0, max).map((i) => `<tr><td class="${i.severity}">${e(i.severity)}</td><td><code>${e(i.code)}</code></td><td>${i.loc ? a(i.loc) : i.sitemap ? a(i.sitemap) : ''}</td><td>${e(i.message)}</td></tr>`);
      const total = v.bySeverity.error + v.bySeverity.warning + v.bySeverity.info;
      body.push(`<details><summary>Details (${formatNumber(total)})</summary><table><thead><tr><th>Severity</th><th>Code</th><th>Where</th><th>Message</th></tr></thead><tbody>${rows.join('')}${more(total, rows.length, 4)}</tbody></table></details>`);
    }
  }

  const sm = report.sitemaps;
  if (sm.length) {
    const rows = sm
      .slice(0, max)
      .map((x) => `<tr><td>${a(x.url)}</td><td>${e(x.kind ?? '')}</td><td class="n">${formatNumber(x.urlCount || x.sitemapCount)}</td><td class="n">${formatNumber(Math.round(x.bytes / 1024))} KiB${x.gzip ? ' (gz)' : ''}</td><td class="${x.status === 'ok' ? '' : 'error'}">${e(x.status === 'ok' ? 'ok' : `${x.status}: ${x.error ?? ''}`)}</td></tr>`)
      .join('');
    body.push(`<h2>Sitemaps</h2><details><summary>${formatNumber(sm.length)} documents</summary><table><thead><tr><th>URL</th><th>Type</th><th class="n">Entries</th><th class="n">Size</th><th>Status</th></tr></thead><tbody>${rows}${more(sm.length, Math.min(max, sm.length), 5)}</tbody></table></details>`);
  }
  body.push(`<footer>${e(report.tool)} &middot; ${e(report.generatedAt)}</footer>`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${e(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body.join('\n')}
</main>
</body>
</html>
`;
}
