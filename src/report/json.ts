import type { WatchReport } from './model.js';

export interface JsonReportOptions {
  /** Cap the URL lists in the diff (default: no cap). Counts are always exact. */
  maxItems?: number;
  pretty?: boolean;
}

export function renderJson(report: WatchReport, options: JsonReportOptions = {}): string {
  let out: WatchReport = report;
  const max = options.maxItems;
  if (max !== undefined && report.diff) {
    const d = report.diff;
    out = {
      ...report,
      diff: {
        ...d,
        added: d.added.slice(0, max),
        removed: d.removed.slice(0, max),
        lastmodChanged: d.lastmodChanged.slice(0, max),
        metadataChanged: d.metadataChanged.slice(0, max),
        moved: d.moved.slice(0, max),
      },
    };
  }
  return `${JSON.stringify(out, null, options.pretty === false ? undefined : 2)}\n`;
}
