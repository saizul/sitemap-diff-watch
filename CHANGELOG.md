# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-14

First public release.

### Added

- Incremental XML tokenizer with namespace resolution, entity and CDATA decoding,
  DOCTYPE skipping (no entity expansion), depth and token limits.
- Streaming sitemap parser for `urlset`, `sitemapindex`, RSS 2.0, Atom 1.0 and
  text sitemaps, with the image, video, news and hreflang (`xhtml:link`)
  extensions; gzip detected from magic bytes; warnings for the 50,000 URL,
  50 MB, 50,000 sitemap and 1,000 news limits, wrong namespaces and encodings;
  a hard byte cap against gzip bombs.
- Recursive crawler for sitemap indexes with depth and document limits, cycle
  detection, concurrency, per-document error reporting and cross-host and
  nested-index warnings; discovery from robots.txt `Sitemap:` lines with a
  fallback to common paths.
- HTTP helper with User-Agent, timeout, retries with exponential backoff and
  `Retry-After`; injectable `fetch` everywhere.
- robots.txt parser and matcher following RFC 9309, with a per-origin cache and
  the `ok` / `unavailable` / `unreachable` status rules.
- Snapshots stored as gzip JSON files with a metadata index, or in SQLite through
  `node:sqlite` with a fallback to JSON; retention pruning.
- Diffs: added and removed URLs, lastmod and metadata changes, moves between
  sitemap files, section growth, URL pattern clustering, and new-content velocity
  per day or week from history or from lastmod.
- Validation: canonical host, http/https mixing, duplicates and near-duplicates,
  W3C Datetime lastmod with explanations, future dates, the sitemaps.org location
  rule, URL length and encoding, changefreq and priority, Google's image, video,
  news and hreflang rules, robots.txt blocks, and rate-limited HEAD checks for
  redirects, error statuses and `X-Robots-Tag: noindex`.
- Reports in Markdown, JSON, self-contained HTML with an inline SVG chart of URL
  counts over time, and an RSS 2.0 feed of new URLs.
- Alerts to Slack-compatible webhooks, Telegram and signed generic webhooks, with
  per-site thresholds.
- `sitemap-diff-watch` CLI: `discover`, `fetch`, `parse`, `snapshot`, `diff`,
  `history`, `validate` and `watch` with a JSON config file and `${ENV}`
  references.
- ES module and CommonJS builds with type declarations.
- GitHub Actions example that commits snapshots on a schedule.

[Unreleased]: https://github.com/saizul/sitemap-diff-watch/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/saizul/sitemap-diff-watch/releases/tag/v0.1.0
