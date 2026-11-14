import { escapeXml } from '../xml/entities.js';

export interface ChartPoint {
  /** ISO timestamp. */
  time: string;
  value: number;
  label?: string;
}

export interface ChartOptions {
  width?: number;
  height?: number;
  title?: string;
  /** CSS colour of the line (default `#2563eb`). */
  color?: string;
}

/** "Nice" axis step for a range: 1, 2 or 5 times a power of ten. */
export function niceStep(range: number, ticks = 5): number {
  if (!(range > 0)) return 1;
  const raw = range / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return Math.max(1, nice * power);
}

function compact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${+(n / 1000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
}

/**
 * A self-contained SVG line chart (no scripts, no external fonts), suitable for inlining in
 * HTML reports and email. Points are placed on a real time axis, so irregular snapshot
 * intervals look right.
 */
export function renderLineChart(points: ChartPoint[], options: ChartOptions = {}): string {
  const width = options.width ?? 720;
  const height = options.height ?? 260;
  const color = options.color ?? '#2563eb';
  const title = options.title ?? 'URLs over time';
  const pad = { top: 28, right: 20, bottom: 36, left: 56 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(title)}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="11">`;
  const titleEl = `<title>${escapeXml(title)}</title><text x="${pad.left}" y="16" font-size="13" font-weight="600" fill="#111827">${escapeXml(title)}</text>`;
  if (points.length === 0) {
    return `${head}${titleEl}<text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#6b7280">No data yet</text></svg>`;
  }
  const sorted = [...points].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const times = sorted.map((p) => Date.parse(p.time));
  const values = sorted.map((p) => p.value);
  const t0 = times[0]!;
  const t1 = times[times.length - 1]!;
  let vMin = Math.min(...values);
  let vMax = Math.max(...values);
  if (vMin === vMax) {
    vMin = Math.max(0, vMin - 1);
    vMax = vMax + 1;
  }
  const step = niceStep(vMax - vMin);
  const yMin = Math.floor(vMin / step) * step;
  const yMax = Math.ceil(vMax / step) * step;
  const x = (t: number): number => pad.left + (t1 === t0 ? innerW / 2 : ((t - t0) / (t1 - t0)) * innerW);
  const y = (v: number): number => pad.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;
  const f = (n: number): string => n.toFixed(1);

  const parts: string[] = [head, titleEl];
  for (let v = yMin; v <= yMax + step / 2; v += step) {
    parts.push(`<line x1="${pad.left}" x2="${width - pad.right}" y1="${f(y(v))}" y2="${f(y(v))}" stroke="#e5e7eb"/>`);
    parts.push(`<text x="${pad.left - 6}" y="${f(y(v) + 4)}" text-anchor="end" fill="#6b7280">${compact(v)}</text>`);
  }
  const labelCount = Math.min(sorted.length, 6);
  for (let i = 0; i < labelCount; i++) {
    const idx = labelCount === 1 ? 0 : Math.round((i * (sorted.length - 1)) / (labelCount - 1));
    const t = times[idx]!;
    parts.push(`<text x="${f(x(t))}" y="${height - pad.bottom + 16}" text-anchor="middle" fill="#6b7280">${new Date(t).toISOString().slice(0, 10)}</text>`);
  }
  const line = sorted.map((p, i) => `${i ? 'L' : 'M'}${f(x(times[i]!))},${f(y(p.value))}`).join(' ');
  const area = `${line} L${f(x(t1))},${f(pad.top + innerH)} L${f(x(t0))},${f(pad.top + innerH)} Z`;
  parts.push(`<path d="${area}" fill="${escapeXml(color)}" fill-opacity="0.08"/>`);
  parts.push(`<path d="${line}" fill="none" stroke="${escapeXml(color)}" stroke-width="2" stroke-linejoin="round"/>`);
  sorted.forEach((p, i) => {
    const label = p.label ?? `${new Date(times[i]!).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${p.value.toLocaleString('en-US')} URLs`;
    parts.push(`<circle cx="${f(x(times[i]!))}" cy="${f(y(p.value))}" r="3" fill="#fff" stroke="${escapeXml(color)}" stroke-width="2"><title>${escapeXml(label)}</title></circle>`);
  });
  parts.push('</svg>');
  return parts.join('');
}
