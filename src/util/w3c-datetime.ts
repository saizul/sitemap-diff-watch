/**
 * W3C Datetime (https://www.w3.org/TR/NOTE-datetime), the format sitemaps.org requires for
 * `<lastmod>` and Google requires for news and video dates:
 *
 *   YYYY | YYYY-MM | YYYY-MM-DD | YYYY-MM-DDThh:mmTZD | YYYY-MM-DDThh:mm:ssTZD | YYYY-MM-DDThh:mm:ss.sTZD
 *
 * where TZD is `Z` or `+hh:mm` / `-hh:mm`. A time without a time zone is not valid.
 */
export type DatetimePrecision = 'year' | 'month' | 'day' | 'minute' | 'second';

export type W3cDatetimeResult =
  | { valid: true; time: number; precision: DatetimePrecision; iso: string }
  | { valid: false; reason: string };

const RE =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;

export function parseW3cDatetime(input: string): W3cDatetimeResult {
  const value = input.trim();
  if (value === '') return { valid: false, reason: 'empty value' };
  const m = RE.exec(value);
  if (!m) return { valid: false, reason: explainInvalid(value) };
  const [, y, mo, d, hh, mi, ss, frac, tz] = m;
  const year = Number(y);
  const month = mo === undefined ? 1 : Number(mo);
  const day = d === undefined ? 1 : Number(d);
  if (month < 1 || month > 12) return { valid: false, reason: `month ${mo} is out of range` };
  if (day < 1 || day > daysInMonth(year, month)) return { valid: false, reason: `day ${d} is out of range for ${y}-${mo}` };
  let precision: DatetimePrecision = d !== undefined ? 'day' : mo !== undefined ? 'month' : 'year';
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  let millis = 0;
  let offsetMinutes = 0;
  if (hh !== undefined) {
    if (tz === undefined) return { valid: false, reason: 'a time must include a time zone designator (Z or +hh:mm)' };
    hours = Number(hh);
    minutes = Number(mi);
    if (hours > 23) return { valid: false, reason: `hour ${hh} is out of range` };
    if (minutes > 59) return { valid: false, reason: `minute ${mi} is out of range` };
    precision = 'minute';
    if (ss !== undefined) {
      seconds = Number(ss);
      if (seconds > 59) return { valid: false, reason: `second ${ss} is out of range` };
      precision = 'second';
      if (frac !== undefined) millis = Math.round(Number(`0${frac}`) * 1000);
    }
    if (tz !== 'Z') {
      const sign = tz!.startsWith('-') ? -1 : 1;
      const oh = Number(tz!.slice(1, 3));
      const om = Number(tz!.slice(4, 6));
      if (oh > 14 || om > 59) return { valid: false, reason: `time zone offset ${tz} is out of range` };
      offsetMinutes = sign * (oh * 60 + om);
    }
  }
  const time = Date.UTC(year, month - 1, day, hours, minutes, seconds, millis) - offsetMinutes * 60_000;
  return { valid: true, time, precision, iso: new Date(time).toISOString() };
}

export function isValidW3cDatetime(input: string): boolean {
  return parseW3cDatetime(input).valid;
}

/** Milliseconds since the epoch for a valid W3C datetime, else `undefined`. */
export function w3cToTime(input: string | undefined): number | undefined {
  if (input === undefined) return undefined;
  const r = parseW3cDatetime(input);
  return r.valid ? r.time : undefined;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function explainInvalid(value: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)) return 'date and time must be separated by "T", not a space';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?[+-]\d{4}$/.test(value)) return 'time zone offset must be written +hh:mm';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}(:\d{2})?$/.test(value)) return 'a time needs hours and minutes and a time zone';
  if (/^\d{4}\/\d{2}\/\d{2}/.test(value) || /^\d{2}[/.-]\d{2}[/.-]\d{4}/.test(value)) return 'use YYYY-MM-DD';
  if (/^[A-Z][a-z]{2}, /.test(value)) return 'RFC 822 dates are not W3C Datetime';
  if (/^\d{9,}$/.test(value)) return 'Unix timestamps are not W3C Datetime';
  return 'not in W3C Datetime format';
}

/** Convert an RFC 822 / RFC 2822 date (RSS `pubDate`) to ISO 8601, if `Date` can read it. */
export function rfc822ToIso(value: string): string | undefined {
  const time = Date.parse(value.trim());
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** `YYYY-MM-DD` in UTC. */
export function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Monday 00:00 UTC of the ISO week containing `time`, as `YYYY-MM-DD`. */
export function utcWeekStart(time: number): string {
  const d = new Date(time);
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  return utcDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
}

/** ISO 8601 week label such as `2026-W46`. */
export function isoWeekLabel(time: number): string {
  const src = new Date(time);
  const d = new Date(Date.UTC(src.getUTCFullYear(), src.getUTCMonth(), src.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
