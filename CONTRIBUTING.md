# Contributing

Thanks for taking the time to improve sitemap-diff-watch. Bug reports, new
validation rules, parser fixes for real-world sitemaps and documentation fixes
are all welcome.

## Reporting a bug

Open an issue with:

- what you expected and what happened, with the command and its output
- your Node.js version (`node --version`) and how you run the tool (CLI,
  library, GitHub Actions)
- for parser problems: the smallest sitemap that shows the problem. A public
  sitemap URL is fine; otherwise attach a trimmed copy with the URLs replaced
  by `example.com` ones.
- your config with every secret replaced by a placeholder

Never post webhook URLs, bot tokens or webhook secrets.

## Development setup

You need Node.js 20 or newer (22.13+ to run the SQLite tests).

```bash
git clone https://github.com/saizul/sitemap-diff-watch.git
cd sitemap-diff-watch
npm ci
npm run lint
npm test
```

`npm test` compiles `src/` and `test/` into `dist/` (ES modules) and `src/`
into `dist/cjs/` (CommonJS), then runs `node --test dist/test/*.test.js`.
CI runs it on Node.js 20, 22 and 24.

## Guidelines

- **No runtime dependencies.** Use Node.js built-ins. Development tools go in
  `devDependencies`.
- **Tests never touch the network.** Inject `MockFetch` from
  `test/helpers/mock-fetch.ts`, `noSleep`, and `fakeTime()` for anything rate
  limited.
- **Follow the specifications.** Changes to parsing or validation should link
  the sitemaps.org, Google Search Central, RFC 9309 or W3C page that documents
  the behaviour, and come with a fixture.
- **Treat sitemap content as untrusted.** Anything that ends up in a report or
  alert must be escaped for that format.
- **Keep memory flat while parsing.** The parser must not buffer whole
  documents; add a chunked test when you touch the tokenizer.
- **Every change comes with a test** that fails without it.
- Add a line to the `Unreleased` section of `CHANGELOG.md` for anything a user
  would notice.

## Project layout

```text
src/
  xml/           tokenizer and entity helpers
  parse/         sitemap, text and stream parsers
  fetch/         HTTP helper, crawler, discovery
  robots/        robots.txt parser, matcher and cache
  snapshot/      snapshot model, JSON and SQLite stores
  diff/          diff, sections, clusters, velocity
  validate/      validation rules, hreflang, HEAD checks
  report/        Markdown, JSON, HTML, SVG chart, RSS
  alerts/        rules, message, Slack, Telegram, webhook
  util/          W3C datetime, URL helpers, concurrency
  config.ts      config loading and validation
  watch.ts       the watch pipeline
  cli-run.ts     command-line interface (cli.ts is the bin entry)
test/            node:test suites, helpers and fixtures
examples/        configs, scripts, GitHub Actions workflow
```

## Adding a validation rule

Add the check to `src/validate/validate.ts` with a stable kebab-case `code`
and a severity (`error` only for things that break the protocol or indexing),
test it in `test/validate.test.ts`, and add a row to the table in the README.

## Pull requests

Keep pull requests focused on one change, describe what it does and why, and
mention anything you could not test. By contributing you agree that your work
is released under the MIT license of this project.
