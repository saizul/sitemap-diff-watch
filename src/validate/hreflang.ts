export type HreflangCheck = { valid: true } | { valid: false; reason: string };

/**
 * Check an hreflang value as Google reads it: `x-default`, or an ISO 639-1 language code,
 * optionally a script (`zh-Hant`) and an ISO 3166-1 alpha-2 region (`en-GB`) or UN M.49
 * area (`es-419`), separated by hyphens. Case does not matter.
 */
export function checkHreflang(value: string): HreflangCheck {
  const v = value.trim();
  if (v.toLowerCase() === 'x-default') return { valid: true };
  if (v.includes('_')) return { valid: false, reason: `use a hyphen, not an underscore ("${v.replace(/_/g, '-')}")` };
  const m = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?$/i.exec(v);
  if (!m) return { valid: false, reason: 'expected a language code (ISO 639-1), optionally followed by -REGION (ISO 3166-1 alpha-2)' };
  const region = m[3]?.toLowerCase();
  // The most common mistake: the United Kingdom is GB in ISO 3166-1.
  if (region === 'uk') return { valid: false, reason: `"UK" is not an ISO 3166-1 code; use "${m[1]}-GB"` };
  return { valid: true };
}
