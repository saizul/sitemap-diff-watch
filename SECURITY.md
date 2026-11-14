# Security policy

## Supported versions

Security fixes are made for the latest released minor version.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/saizul/sitemap-diff-watch/security/advisories/new)
for this repository and include a description, the sitemap or configuration
that triggers the problem and the version you used.

You can expect an acknowledgement within a few days. Once a fix is released
the advisory is published with credit to the reporter, unless you prefer to
stay anonymous.

## Scope

sitemap-diff-watch downloads and parses documents from sites you may not
control, so sitemap content is untrusted input. Things that count as
vulnerabilities include:

- script or markup injection into the HTML, Markdown or RSS reports, or into
  Slack or Telegram messages, through URLs or text in a sitemap
- XML external entity (XXE) resolution, entity expansion or any file or
  network access triggered by document content
- memory or CPU exhaustion from a crafted document that gets past the byte cap,
  depth limit or token limit (for example a gzip bomb or deeply nested XML)
- a crawl that can be made to loop forever or to request an unbounded number of
  documents despite `maxDepth` and `maxSitemaps`
- secrets (webhook URLs, bot tokens, webhook secrets) written to logs, reports,
  snapshots or error messages
- a webhook signature that can be forged or that does not cover the whole body

Problems in Slack's, Telegram's or other services' APIs should be reported to
them.

## Handling secrets

Keep webhook URLs, bot tokens and secrets in environment variables and refer to
them as `${NAME}` in the config file; never commit them. If one was exposed,
rotate it: create a new Slack webhook, revoke the bot token with @BotFather, and
change the webhook secret on both sides.
