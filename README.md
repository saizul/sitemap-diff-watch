# sitemap-diff-watch

[![CI](https://github.com/saizul/sitemap-diff-watch/actions/workflows/ci.yml/badge.svg)](https://github.com/saizul/sitemap-diff-watch/actions/workflows/ci.yml)
![Node 20+](https://img.shields.io/badge/node-20%2B-blue)
![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-blue)
![ESM and CommonJS](https://img.shields.io/badge/module-ESM%20%2B%20CJS-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

Keep an eye on **XML sitemaps over time**, your own or your competitors'. `sitemap-diff-watch` fetches a sitemap
index and every sitemap in it (gzip included), stores a snapshot, and tells you what changed since last time: which
URLs were **added or removed**, which **lastmod** dates moved, which **sections grew**, what **URL patterns** the new
pages follow and how fast new content is published. It also **validates** the entries against the sitemaps.org
protocol and Google's rules, and writes **Markdown, JSON, HTML and RSS** reports and sends **Slack, Telegram or
webhook** alerts.

```text
robots.txt ──Sitemap:──▶ sitemap index ──▶ sitemaps (.xml / .xml.gz / RSS / text)
                              │  streaming parse, 50k URLs / 50 MB, image, video, news, hreflang
                              ▼
                          snapshot ──▶ store (gzip JSON files or SQLite)
                              │
            previous snapshot ┴─▶ diff: added, removed, lastmod, sections, patterns, velocity
                              │
                              ├─▶ validation: hosts, http/https, duplicates, lastmod, robots.txt, HEAD
                              ├─▶ reports: report.md, report.html (SVG chart), report.json, new-urls.xml
                              └─▶ alerts: Slack, Telegram, signed webhook
```

It is a TypeScript library and CLI for Node.js 20+ with **no runtime dependencies**: the XML parser, robots.txt
matcher, gzip handling (`node:zlib`), HTTP (`fetch`), SQLite (`node:sqlite`, when your Node.js has it) and the SVG
chart are all built in. It ships as both ES modules and CommonJS.

## Contents

- [Features](#features)
- [Install](#install)
- [Install from GitHub Packages](#install-from-github-packages)
- [Quick start](#quick-start)
- [CLI](#cli)
- [Configuration](#configuration)
- [What the diff contains](#what-the-diff-contains)
- [Validation rules](#validation-rules)
- [Reports](#reports)
- [Alerts](#alerts)
- [Scheduled runs with GitHub Actions](#scheduled-runs-with-github-actions)
- [Library use](#library-use)
- [Examples](#examples)
- [Testing](#testing)
- [Protocol references](#protocol-references)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Fetching**
  - sitemap indexes followed recursively (configurable depth and document limit), cycles and duplicates detected,
    parallel downloads with a concurrency limit, retries with backoff for 408/425/429/5xx and `Retry-After`
  - gzip detected from the magic bytes, so `.xml.gz` works whatever the `Content-Type`
  - discovery from the `Sitemap:` lines of `robots.txt`, with a fallback to `/sitemap.xml`, `/sitemap_index.xml` and
    other common paths
  - one failing child sitemap is recorded and reported; the rest of the crawl continues
- **Streaming parser** written for sitemaps: documents are parsed chunk by chunk as they download, so a 50,000 URL /
  50 MB file never sits in memory as a whole. Namespaces are resolved properly (any prefix works), entities and
  CDATA are decoded, DOCTYPEs are skipped and custom entities are never expanded (no XXE or entity bombs), and a hard
  byte cap stops gzip bombs.
- **Formats**: `urlset`, `sitemapindex`, RSS 2.0 and Atom 1.0 feeds, and plain text sitemaps, as allowed by
  sitemaps.org
- **Extensions**: image (`image:image`), video (all current `video:*` fields), news (`news:news`) and hreflang
  (`xhtml:link rel="alternate"`)
- **Protocol limits** warned about: more than 50,000 URLs or 50,000 sitemaps, more than 50 MB uncompressed, more than
  1,000 news entries, nested indexes, child sitemaps on another host, wrong or missing namespace, non-UTF-8
- **Snapshots** in gzip-compressed JSON files (good for committing to git) or in one SQLite file through
  `node:sqlite`, with automatic fallback to JSON on Node.js versions without it, and retention pruning
- **Diffs**: added and removed URLs, lastmod changes (compared as instants, so `+06:00` and `Z` forms of the same
  time are equal), metadata changes (changefreq, priority, images, videos, news, hreflang), URLs that moved to
  another sitemap file, **section (directory) growth**, **URL pattern clustering** (`/blog/{slug}`,
  `/product/{n}`, `/news/{yyyy}/{n}/{slug}`) and **new-content velocity** per day or week, from snapshot history
  or from `<lastmod>` dates of a single snapshot
- **Validation**: non-canonical hosts, http and https mixed, duplicates and near-duplicates, invalid W3C datetime
  lastmod, future dates, the sitemaps.org location rule, URL length and encoding, changefreq and priority values,
  Google's image, video, news and hreflang rules (including missing return links), URLs blocked by `robots.txt`
  (RFC 9309 matching), and optional rate-limited **HEAD checks** for redirects, errors and `X-Robots-Tag: noindex`
- **Reports**: Markdown, JSON, a self-contained HTML page with an **inline SVG chart of URL counts over time**, and
  an **RSS feed of new URLs**
- **Alerts**: Slack-compatible incoming webhooks (Block Kit), Telegram Bot API, and a generic JSON webhook signed
  with HMAC-SHA256, with thresholds per site
- **Testable**: `fetch`, clock and sleep are injectable everywhere; the test suite never touches the network

## Install

```bash
git clone https://github.com/saizul/sitemap-diff-watch.git
cd sitemap-diff-watch
npm ci            # also builds dist/
node dist/src/cli.js --help
```

To use it from another project or a CI job, install from GitHub Packages (below) or from a git tag:

```bash
npm install github:saizul/sitemap-diff-watch#v0.1.0
npx sitemap-diff-watch --version
```

Requires Node.js 20 or newer. The SQLite store needs Node.js 22.13+ (or 23.4+, 24); older versions fall back to the
JSON store automatically.

## Install from GitHub Packages

Every release is also published to GitHub Packages as `@saizul/sitemap-diff-watch`.

1. Create a GitHub personal access token (classic) with the `read:packages` scope.
2. Add an `.npmrc` next to your `package.json`:

   ```ini
   @saizul:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
   ```

3. Install with the token in your environment:

   ```bash
   export GITHUB_TOKEN=ghp_your_token_here
   npm install @saizul/sitemap-diff-watch
   ```

4. Run the bundled CLI, or import the scoped name:

   ```bash
   npx sitemap-diff-watch watch --config watch.json
   ```

   ```ts
   import { crawlSitemaps, createSnapshot, diffSnapshots } from '@saizul/sitemap-diff-watch';
   ```

In GitHub Actions, use `secrets.GITHUB_TOKEN` with `permissions: packages: read`.

## Quick start

```bash
# Where are the sitemaps?
sitemap-diff-watch discover https://www.example.com

# What is in them?
sitemap-diff-watch fetch https://www.example.com/sitemap_index.xml

# Is anything wrong? (exit code 1 when errors are found)
sitemap-diff-watch validate https://www.example.com/sitemap_index.xml --robots --head --head-max 50

# Take a snapshot now, and again tomorrow; the second run prints what changed
sitemap-diff-watch snapshot https://www.example.com/sitemap_index.xml --site example
sitemap-diff-watch diff --site example --format html -o diff.html

# Or put several sites, reports and alerts in a config file and run them all
sitemap-diff-watch watch --config watch.json
```

## CLI

| Command | What it does |
| --- | --- |
| `discover <site-url>` | Lists the sitemaps named in robots.txt (or found at common paths). `--json` for machine output. |
| `fetch <sitemap-url>...` | Fetches sitemaps recursively and prints a summary. `--urls` prints the URL list, `--json` the stats, `--out file.json.gz` saves the snapshot. |
| `parse <file>` | Parses a local `.xml`, `.xml.gz` or `.txt` sitemap. `--urls` lists URLs, `--json` includes all entries. |
| `snapshot <sitemap-url>... --site <name>` | Fetches and stores a snapshot, then prints the diff against the previous one. |
| `diff --site <name> [--from <id>] [--to <id>]` | Compares two stored snapshots (default: the last two). |
| `diff <old.json[.gz]> <new.json[.gz]>` | Compares two snapshot files. |
| `history [--site <name>]` | Lists stored snapshots, or the sites in the store. |
| `validate <sitemap-url>...` | Validates entries. `--robots`, `--head`, `--head-max <n>`, `--head-rate <per-second>`, `--canonical-host <host>`, `--fail-on error\|warning\|info\|none`. |
| `watch --config <file>` | Runs every site of a config file: snapshot, diff, validation, reports, alerts. `--site <name>` (repeatable), `--dry-run` (no alerts), `--json`. |

Common options: `--store <dir|file.sqlite>` (default `./snapshots`; a `.sqlite` or `.db` path selects SQLite),
`--format md|json|html|rss`, `--output`/`-o <file>`, `--max-depth <n>`, `--user-agent <ua>` (also the product
token for robots.txt matching), `--timeout <ms>`.

Exit codes: `0` success, `1` failure or issues at the `--fail-on` level, `2` usage error.

## Configuration

`watch` reads a JSON file. Relative paths resolve against the file's directory, and `${NAME}` anywhere in a string
is replaced by the environment variable `NAME`; alert channels whose variables are not set are skipped with a
warning, so the same file works locally without secrets.

```json
{
  "store": { "type": "json", "path": "snapshots" },
  "reports": { "dir": "reports", "formats": ["md", "html", "json", "rss"], "baseUrl": "https://you.github.io/watch/" },
  "validate": { "robots": true, "robotsUserAgent": "Googlebot" },
  "alerts": {
    "rules": { "minAdded": 1, "minRemoved": 1, "minRemovedPct": 10 },
    "channels": [
      { "type": "slack", "url": "${SLACK_WEBHOOK_URL}" },
      { "type": "telegram", "botToken": "${TELEGRAM_BOT_TOKEN}", "chatId": "${TELEGRAM_CHAT_ID}" }
    ]
  },
  "sites": [
    { "name": "my-site", "sitemaps": ["https://www.example.com/sitemap_index.xml"], "validate": { "canonicalHost": "www.example.com" } },
    { "name": "competitor", "discover": "https://shop.example.net/", "sectionDepth": 2, "validate": { "enabled": false } }
  ]
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `store.type` | `json` | `json` (one `.json.gz` per snapshot plus `index.json`) or `sqlite` (`node:sqlite`, falls back to JSON) |
| `store.path` | `snapshots` (`snapshots/snapshots.sqlite`) | Directory or database file |
| `store.compress` | `true` | `false` writes plain, indented `.json` files that diff line by line in git |
| `reports.dir` | `reports` | Reports go to `<dir>/<site>/report.md`, `report.html`, `report.json`, `new-urls.xml` |
| `reports.formats` | all four | Any of `md`, `html`, `json`, `rss`; `[]` writes none |
| `reports.maxItems` | 50 (md), 200 (html), all (json) | URLs listed per section |
| `reports.baseUrl` | none | Public URL of the reports directory; adds report links to alerts and the RSS `atom:link` |
| `http.userAgent` | `sitemap-diff-watch/0.1.0 (+https://github.com/saizul/sitemap-diff-watch)` | Request `User-Agent` |
| `http.timeoutMs` / `retries` / `concurrency` | `60000` / `2` / `4` | Per request, body included / retries / parallel sitemap downloads |
| `keep` | `120` | Snapshots kept per site (`0` keeps all) |
| `historyWindow` | `12` | Snapshots used for history velocity and the RSS feed |
| `validate.enabled` | `true` | Turn validation off (e.g. for competitors) |
| `validate.robots` / `robotsUserAgent` | `true` / `Googlebot` | Check URLs against robots.txt, as this crawler |
| `validate.head` | `false` | `true`, or `{ "maxUrls": 200, "ratePerSecond": 2, "concurrency": 2 }` |
| `validate.canonicalHost` / `canonicalProtocol` | host and protocol of the first sitemap | Expected host and `https:` / `http:` |
| `validate.futureToleranceHours` | `24` | How far in the future a lastmod may be before it is reported |
| `validate.checkScope` | `true` | Check the sitemaps.org location rule |
| `alerts.rules` | see [Alerts](#alerts) | Thresholds; site rules are merged over global ones |
| `alerts.channels` | none | `slack`, `telegram`, `webhook` (site channels replace global ones) |
| `alerts.maxUrls` | `10` | URLs listed per alert |
| `sites[].name` | required | Snapshot directory and report name |
| `sites[].sitemaps` or `sites[].discover` | one required | Sitemap URLs, or a site URL whose robots.txt lists them |
| `sites[].maxDepth` / `maxSitemaps` | `3` / `1000` | Index depth and document limit |
| `sites[].sectionDepth` | `1` | Directory depth for section growth (`/blog/` vs `/blog/2026/`) |

See [examples/config.example.json](examples/config.example.json) for every option.

## What the diff contains

`diffSnapshots(before, after)` compares distinct `<loc>` values (duplicates count once):

- `added`, `removed`: full entries, sorted by URL
- `lastmodChanged`: `{ loc, before, after }`; values are compared as instants, so reformatting a date is not a change
- `metadataChanged`: `{ loc, fields }` for changefreq, priority, images, videos, news and alternates
- `moved`: URLs that now come from a different sitemap file (a CMS re-sharding its sitemaps, for example)
- `sections`: per-directory counts before and after, largest absolute change first. Hosts are added to the section
  name when the sitemaps span several hosts.
- `addedClusters`, `removedClusters`: URL patterns. Segments that look like numbers, years, dates, UUIDs or hashes
  become `{n}`, `{yyyy}`, `{date}`, `{uuid}`, `{hash}`; then any position where at least three different values
  share the same surroundings becomes `{slug}`. Query keys are kept (`/search?page={n}&q={v}`).
- `counts`: before, after, added, removed, net and growth in percent

Velocity comes in two flavours. `velocityFromHistory(snapshots)` counts URLs on the date of the first snapshot that
contains them (the oldest snapshot is the baseline). `velocityFromLastmod(urls)` needs only one snapshot and counts
URLs by `<lastmod>` in a window (28 days by day, 84 days by week), which gives a first estimate for a competitor you
just started watching. Both report `perDay` and `perWeek`.

## Validation rules

| Code | Severity | Rule |
| --- | --- | --- |
| `invalid-url` | error | `<loc>` must be an absolute http(s) URL |
| `url-too-long` | error | `<loc>` must be under 2,048 characters |
| `unencoded-url` | warning | Spaces, `<>"{}\|\\^` or non-ASCII characters must be percent-encoded |
| `url-has-fragment` | warning | `#fragments` are ignored by crawlers |
| `non-canonical-host` | warning | Host differs from the canonical host |
| `mixed-protocol`, `protocol-mix` | warning | http URLs on an https site (per URL, and once for the set) |
| `outside-sitemap-scope` | warning | sitemaps.org: same protocol, host and port as the sitemap, and under its directory |
| `duplicate-url` | warning | The same URL listed more than once (across all sitemaps) |
| `near-duplicate` | info | URLs differing only by `www.`, trailing slash or parameter order |
| `invalid-lastmod` | error | Not W3C Datetime; the message says why (space instead of `T`, missing time zone, `+0000`, ...) |
| `future-lastmod` | warning | Later than now plus the tolerance |
| `invalid-changefreq`, `invalid-priority` | warning | Not one of the seven values / not 0.0 to 1.0 |
| `too-many-images`, `invalid-image-loc` | warning | More than 1,000 images per URL / relative image URL |
| `video-missing-field` | error | `thumbnail_loc`, `title`, `description` and `content_loc` or `player_loc` are required |
| `video-*` | warning | Description over 2,048 characters, duration outside 1 to 28,800 s, rating outside 0 to 5, more than 32 tags, uploader over 255 characters, bad dates, `relationship` not `allow`/`deny`, relative URLs, `content_loc` equal to the page |
| `news-missing-field`, `news-invalid-date` | error | Publication name, language, date and title are required; date must be W3C Datetime |
| `news-invalid-language` | warning | ISO 639 code (`zh-cn` / `zh-tw` for Chinese) |
| `news-too-old` | info | Older than two days |
| `hreflang-invalid-code` | warning | ISO 639-1 language, optional script and ISO 3166-1 region or UN M.49 area, or `x-default`; catches `en_US` and `en-UK` |
| `hreflang-missing-self`, `hreflang-missing-return`, `hreflang-conflict`, `hreflang-relative-href` | warning | Each version lists itself, links are reciprocal, one URL per hreflang value, fully qualified hrefs |
| `blocked-by-robots` | error | Disallowed for the configured user agent (RFC 9309: most specific group, longest match, allow wins ties, `*` and `$`) |
| `robots-unreachable` | error | robots.txt answered 5xx or failed; crawlers then treat the site as disallowed |
| `http-status`, `http-failed` | error | HEAD check: not 200, or no answer |
| `http-redirect` | warning | HEAD check: 3xx; list the final URL instead |
| `noindex-header` | warning | HEAD check: `X-Robots-Tag: noindex` |

Crawl-level problems appear with the same report: `too-many-urls`, `too-many-sitemaps`, `sitemap-too-large`,
`too-many-news` and `sitemap-error` are errors; `nested-index`, `cross-host-sitemap`, `unexpected-namespace`,
`non-utf8-encoding`, `invalid-utf8` and `empty-sitemap` are warnings.

HEAD checks are off by default. They take an evenly spread sample (200 URLs by default), start at most
`ratePerSecond` requests per second (default 2), do not follow redirects, and retry with GET when a server refuses
HEAD with 405 or 501. Only run them against sites you are allowed to load-test, which in practice means your own.

## Reports

- **Markdown** (`report.md`): summary table, changes, sections, URL patterns, velocity, validation; fits a pull
  request, a wiki or an issue
- **HTML** (`report.html`): one file with inline CSS, cards, tables and an inline SVG line chart of distinct URLs
  per snapshot on a real time axis. No scripts, no external requests, `noindex`.
- **JSON** (`report.json`): everything, for dashboards or your own tooling
- **RSS 2.0** (`new-urls.xml`): new URLs from the last `historyWindow` snapshots, newest first, dated by the URL's
  own lastmod or news publication date when that is plausible (never later than when it was first seen)

All output escapes URLs and text from the sitemaps, which is untrusted input when you watch other people's sites.

## Alerts

An alert is sent when one of the rules matches:

| Rule | Default | Fires when |
| --- | --- | --- |
| `minAdded` | `1` | at least this many URLs were added (`0` disables) |
| `minRemoved` | `1` | at least this many URLs were removed (`0` disables) |
| `minRemovedPct` | off | removals reach this percentage of the previous count |
| `minLastmodChanged` | off | at least this many lastmod values changed |
| `onErrors` | `true` | validation found errors |
| `onFetchErrors` | `true` | sitemaps failed to download or parse |
| `always` | `false` | every run, as a scheduled report |

The first snapshot of a site has nothing to compare with, so it only alerts on errors.

- **Slack** (`{ "type": "slack", "url": "https://hooks.slack.com/services/..." }`): Block Kit message with a plain
  `text` fallback, so Mattermost, Rocket.Chat and Discord's `/slack` webhook endpoint accept it too.
- **Telegram** (`{ "type": "telegram", "botToken": "...", "chatId": "...", "messageThreadId": 7 }`): `sendMessage`
  in HTML mode, cut to 4,096 characters, waiting on `retry_after` when rate limited. The token never appears in
  errors or logs.
- **Webhook** (`{ "type": "webhook", "url": "...", "secret": "...", "headers": { ... } }`): JSON `POST` with
  `event: "sitemap.changed"`, the facts, sample URLs and a `text` rendering. With a `secret`, the body is signed:
  `X-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`. See
  [examples/webhook-receiver.mjs](examples/webhook-receiver.mjs) for a verifier.

## Scheduled runs with GitHub Actions

[examples/github-actions/sitemap-watch.yml](examples/github-actions/sitemap-watch.yml) runs `watch` every day in a
repository of your own and commits `snapshots/` and `reports/`, so the history lives in git and the reports can be
served with GitHub Pages. Put your `watch.json` next to it and the alert secrets in the repository secrets.

Snapshots are gzip-compressed JSON: from a few bytes per URL for very regular URL schemes to a few dozen for
varied ones with extensions (50,000 blog-style URLs with lastmod measured 3 bytes each). Set `"compress": false` if
you prefer readable line-by-line git diffs, and `keep` to cap how many are retained.

## Library use

```ts
import {
  crawlSitemaps,
  createSnapshot,
  diffSnapshots,
  JsonSnapshotStore,
  RobotsCache,
  validateEntries,
  buildReport,
  renderHtml,
} from 'sitemap-diff-watch'; // or require('sitemap-diff-watch')

const crawl = await crawlSitemaps('https://www.example.com/sitemap_index.xml', { concurrency: 4 });
const snapshot = createSnapshot('example', crawl);

const store = new JsonSnapshotStore('snapshots');
const [previous] = await store.latest('example');
await store.save(snapshot);

const diff = previous ? diffSnapshots(previous, snapshot) : undefined;
const validation = await validateEntries(snapshot.urls, {
  roots: crawl.roots,
  warnings: crawl.warnings,
  robots: new RobotsCache({}, 'Googlebot'),
});
const html = renderHtml(buildReport({ snapshot, previous, diff, validation, history: await store.list('example') }));
```

Lower-level pieces are exported too: `parseSitemapStream` / `parseSitemapBuffer` (any byte stream, gzip detected),
`SitemapParser` and `XmlTokenizer` (incremental, callback based), `parseRobotsTxt` / `isAllowed`,
`parseW3cDatetime`, `clusterUrls`, `sectionGrowth`, `velocityFromHistory`, `velocityFromLastmod`, `headCheck`,
`renderLineChart`, `renderRss`, `SlackChannel`, `TelegramChannel`, `WebhookChannel` and `runWatch`. Every function
that makes requests accepts `{ fetch }`, and the time-dependent ones accept a `clock` and `sleep`.

## Examples

- [examples/config.example.json](examples/config.example.json): two sites (yours and a competitor), all options
- [examples/config.minimal.json](examples/config.minimal.json): the smallest useful config
- [examples/library-usage.mjs](examples/library-usage.mjs): offline tour of parse, snapshot, diff, validate, report
- [examples/webhook-receiver.mjs](examples/webhook-receiver.mjs): verify the webhook signature with `node:http`
- [examples/github-actions/sitemap-watch.yml](examples/github-actions/sitemap-watch.yml): daily run that commits
  snapshots

## Testing

```bash
npm ci
npm run lint        # eslint + tsc --noEmit
npm test            # builds ESM and CommonJS, then node --test dist/test/*.test.js
```

The suite (228 tests) uses `node:test` with fixture sitemaps in [test/fixtures](test/fixtures) and a scripted
`fetch` ([test/helpers/mock-fetch.ts](test/helpers/mock-fetch.ts)), so it never touches the network. It covers the
tokenizer (including every chunk boundary), the parser and all extensions, gzip and size limits (a 50,000 URL
sitemap, a 70 MB document and a gzip bomb), W3C Datetime, RFC 9309 matching, retries and timeouts, the crawler
(cycles, depth, failures, concurrency), both stores, diffs, clustering, velocity, every validation rule, HEAD checks
with a fake clock for the rate limiter, all report formats (including HTML escaping), the alert channels, the config
loader, the watch pipeline end to end, the CLI and the CommonJS build. The SQLite tests are skipped where
`node:sqlite` is missing, and the fallback test runs there instead. CI runs it on Node.js 20, 22 and 24.

## Protocol references

The rules implemented here follow:

- [sitemaps.org protocol](https://www.sitemaps.org/protocol.html): 50,000 URLs and 50 MB (52,428,800 bytes)
  uncompressed per file, the same for indexes, `<loc>` under 2,048 characters, W3C Datetime, the seven changefreq
  values, priority 0.0 to 1.0, entity escaping, UTF-8, the location rule, `Sitemap:` in robots.txt, RSS/Atom and text
  formats
- Google Search Central: [build a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
  (Google ignores `priority` and `changefreq` and uses `lastmod` only when it is accurate),
  [image](https://developers.google.com/search/docs/crawling-indexing/sitemaps/image-sitemaps),
  [video](https://developers.google.com/search/docs/crawling-indexing/sitemaps/video-sitemaps) and
  [news](https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap) sitemaps, and
  [localized versions](https://developers.google.com/search/docs/specialty/international/localized-versions)
  (hreflang)
- [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309) Robots Exclusion Protocol and
  [W3C Datetime](https://www.w3.org/TR/NOTE-datetime)

## Limitations

- **Snapshots are loaded whole.** Parsing streams, but a crawl result and a snapshot keep every entry in memory
  (about 260 bytes per URL with a lastmod in our measurement, more with images, videos or hreflang). Millions of URLs work, tens of millions need a lot of RAM.
- **History velocity depends on how often you run.** URLs are dated by the snapshot that first saw them, so weekly
  runs give weekly resolution. A URL that comes back after being removed is not counted as new.
- **The parser is not a general XML parser.** It is non-validating, ignores DTDs, and expects UTF-8 (the protocol
  requires it); other encodings are reported, not converted.
- **robots.txt**: the cache lives for one run; `crawl-delay` is not applied to sitemap downloads; sitemaps
  themselves are fetched even if robots.txt disallows them (Google does the same for sitemaps you submit).
- **HEAD checks are sampled** and do not render pages, so soft 404s, canonical tags and `<meta name="robots">` are
  not seen.
- **Alerts are sent once per run.** There is no deduplication across runs; set thresholds to avoid noise.
- **One writer per store.** The JSON store is safe for one process at a time; SQLite handles concurrent readers and a
  single writer.
- Some sites block unknown user agents or rate limit aggressively; use `http.userAgent`, a lower `concurrency` and
  respect their terms when you watch sites you do not own.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Saizul Amin
