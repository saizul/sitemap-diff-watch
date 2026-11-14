import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { LoadedConfig } from '../src/config.js';
import { runWatch, type Logger } from '../src/watch.js';
import { gz, sitemapIndex, tempDir, urlset } from './helpers/fixtures.js';
import { MockFetch, noSleep } from './helpers/mock-fetch.js';

const O = 'https://www.example.com';

/** A site whose sitemap changes between runs. */
function siteAt(run: number): MockFetch {
  const posts = run === 1 ? [`${O}/blog/a`, `${O}/blog/b`] : [`${O}/blog/a`, { loc: `${O}/blog/c`, lastmod: '2026-11-07' }, `${O}/blog/d`, `${O}/blog/e`, `${O}/private/x`];
  return new MockFetch()
    .get(`${O}/robots.txt`, `User-agent: *\nDisallow: /private/\n\nSitemap: ${O}/sitemap_index.xml\n`, { 'content-type': 'text/plain' })
    .get(`${O}/sitemap_index.xml`, sitemapIndex([`${O}/posts.xml.gz`, `${O}/pages.xml`]))
    .get(`${O}/posts.xml.gz`, gz(urlset(posts)), { 'content-type': 'application/gzip' })
    .get(`${O}/pages.xml`, urlset([`${O}/`, `${O}/about`]))
    .on('POST', 'https://hooks.slack.com/services/T/B/X', { status: 200, body: 'ok' })
    .on('POST', /api\.telegram\.org/, { status: 200, json: { ok: true } })
    .on('POST', 'https://hooks.example.com/sitemaps', { status: 202 });
}

function collect(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), error: (m) => lines.push(`error ${m}`) };
}

function config(dir: string, extra: Partial<LoadedConfig['config']> = {}): LoadedConfig {
  return {
    baseDir: dir,
    missingEnv: [],
    config: {
      store: { type: 'json', path: 'snapshots' },
      reports: { dir: 'reports', baseUrl: 'https://reports.example.com/watch' },
      alerts: {
        channels: [
          { type: 'slack', url: 'https://hooks.slack.com/services/T/B/X' },
          { type: 'telegram', botToken: '1:abc', chatId: '42' },
          { type: 'webhook', url: 'https://hooks.example.com/sitemaps', secret: 'k' },
        ],
      },
      sites: [{ name: 'example', discover: `${O}/` }],
      ...extra,
    },
  };
}

describe('runWatch', () => {
  it('stores snapshots, writes reports, validates and alerts on changes', async () => {
    const dir = await tempDir();
    try {
      let t = Date.parse('2026-11-01T06:00:00Z');
      const clock = (): number => t;

      const first = siteAt(1);
      const log1 = collect();
      const [r1] = await runWatch(config(dir), { fetch: first.fetch, clock, sleep: noSleep, logger: log1 });
      assert.equal(r1!.ok, true, r1!.error);
      assert.equal(r1!.urlCount, 4);
      assert.equal(r1!.diff, undefined, 'first run has nothing to compare');
      assert.equal(r1!.alert!.fired, false);
      assert.ok(log1.lines.some((l) => /discovered 1 sitemap\(s\) via robots/.test(l)));
      assert.equal(first.calls.filter((c) => c.url.endsWith('robots.txt')).length, 1, 'robots.txt is fetched once and reused');

      t = Date.parse('2026-11-08T06:00:00Z');
      const second = siteAt(2);
      const [r2] = await runWatch(config(dir), { fetch: second.fetch, clock, sleep: noSleep, logger: collect() });
      assert.equal(r2!.ok, true, r2!.error);
      assert.equal(r2!.urlCount, 7);
      assert.deepEqual({ added: r2!.diff!.added, removed: r2!.diff!.removed }, { added: 4, removed: 1 });
      assert.ok(r2!.validation!.error >= 1, 'the /private/ URL is blocked by robots.txt');
      assert.equal(r2!.alert!.fired, true);
      assert.deepEqual(r2!.alert!.results.map((x) => [x.channel, x.ok]), [['slack', true], ['telegram', true], ['webhook', true]]);

      const slack = JSON.parse(second.calls.find((c) => c.url.includes('slack'))!.body);
      assert.match(slack.text, /4 URLs added; 1 URLs removed/);
      const hook = second.calls.find((c) => c.url.includes('hooks.example.com'))!;
      assert.ok(hook.headers['x-signature-256']!.startsWith('sha256='));
      assert.equal(JSON.parse(hook.body).reportUrl, 'https://reports.example.com/watch/example/report.html');

      const snaps = (await readdir(join(dir, 'snapshots', 'example'))).sort();
      assert.deepEqual(snaps, ['20261101T060000000Z.json.gz', '20261108T060000000Z.json.gz', 'index.json']);
      const reports = (await readdir(join(dir, 'reports', 'example'))).sort();
      assert.deepEqual(reports, ['new-urls.xml', 'report.html', 'report.json', 'report.md']);
      const md = await readFile(join(dir, 'reports', 'example', 'report.md'), 'utf8');
      assert.match(md, /4 added, 1 removed/);
      assert.match(md, /blocked-by-robots/);
      const rss = await readFile(join(dir, 'reports', 'example', 'new-urls.xml'), 'utf8');
      assert.equal((rss.match(/<item>/g) ?? []).length, 4);
      assert.match(rss, /<atom:link href="https:\/\/reports\.example\.com\/watch\/example\/new-urls\.xml"/);
      const html = await readFile(join(dir, 'reports', 'example', 'report.html'), 'utf8');
      assert.equal((html.match(/<circle /g) ?? []).length, 2, 'the chart shows both snapshots');
      const json = JSON.parse(await readFile(join(dir, 'reports', 'example', 'report.json'), 'utf8'));
      assert.equal(json.velocity.history.total, 4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not send alerts in a dry run, and skips channels without secrets', async () => {
    const dir = await tempDir();
    try {
      const cfg = config(dir, { alerts: { channels: [{ type: 'slack', url: '' }, { type: 'webhook', url: 'https://hooks.example.com/sitemaps' }] }, keep: 1 });
      const log = collect();
      let t = Date.parse('2026-11-01T00:00:00Z');
      await runWatch(cfg, { fetch: siteAt(1).fetch, clock: () => t, sleep: noSleep, logger: log });
      t += 86_400_000;
      const mock = siteAt(2);
      const [r] = await runWatch(cfg, { fetch: mock.fetch, clock: () => t, sleep: noSleep, logger: log, dryRun: true });
      assert.equal(r!.alert!.fired, false);
      assert.ok(r!.alert!.reasons.length > 0);
      assert.equal(mock.calls.filter((c) => c.method === 'POST').length, 0);
      assert.ok(log.lines.some((l) => /slack alert skipped/.test(l)));
      assert.ok(log.lines.some((l) => /dry run/.test(l)));
      assert.ok(log.lines.some((l) => /pruned 1 old snapshot/.test(l)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps going when one site fails, and can run selected sites', async () => {
    const dir = await tempDir();
    try {
      const cfg = config(dir, {
        alerts: {},
        reports: { formats: [] },
        sites: [
          { name: 'broken', discover: 'https://broken.example/' },
          { name: 'example', sitemaps: [`${O}/sitemap_index.xml`], validate: { enabled: false } },
        ],
      });
      const results = await runWatch(cfg, { fetch: siteAt(1).fetch, sleep: noSleep });
      assert.equal(results[0]!.ok, false);
      assert.match(results[0]!.error!, /no sitemap found/);
      assert.equal(results[1]!.ok, true);
      assert.equal(results[1]!.validation, undefined);
      assert.deepEqual(results[1]!.reports, []);
      const only = await runWatch(cfg, { fetch: siteAt(1).fetch, sleep: noSleep, only: ['example'] });
      assert.deepEqual(only.map((r) => r.site), ['example']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
