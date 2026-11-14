import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { sendAlerts, signBody, SlackChannel, slackEscape, slackPayload, TELEGRAM_MAX_LENGTH, TelegramChannel, telegramText, WebhookChannel } from '../src/alerts/channels.js';
import { alertText, buildAlertMessage, type AlertMessage } from '../src/alerts/message.js';
import { evaluateAlert } from '../src/alerts/rules.js';
import { diffSnapshots } from '../src/diff/diff.js';
import { buildReport } from '../src/report/model.js';
import { MockFetch, noSleep } from './helpers/mock-fetch.js';
import { snap } from './helpers/snapshots.js';

const O = 'https://www.example.com';
const a = snap('shop', '2026-11-01T00:00:00Z', [`${O}/`, `${O}/p/1`, `${O}/p/2`, `${O}/p/3`]);
const b = snap('shop', '2026-11-08T00:00:00Z', [`${O}/`, `${O}/p/4`, `${O}/p/<5>&`]);
const report = buildReport({ snapshot: b, previous: a, diff: diffSnapshots(a, b), now: Date.parse('2026-11-08T00:00:00Z') });

describe('evaluateAlert', () => {
  it('fires on added and removed URLs by default', () => {
    assert.deepEqual(evaluateAlert(report), { fire: true, reasons: ['2 URLs added', '3 URLs removed'] });
  });

  it('respects thresholds', () => {
    assert.equal(evaluateAlert(report, { minAdded: 5, minRemoved: 5 }).fire, false);
    assert.deepEqual(evaluateAlert(report, { minAdded: 0, minRemoved: 0, minRemovedPct: 50 }).reasons, ['75% of URLs removed']);
    assert.deepEqual(evaluateAlert(buildReport({ snapshot: a }), { always: true }).reasons, ['scheduled report']);
    assert.equal(evaluateAlert(buildReport({ snapshot: a })).fire, false, 'a first snapshot has no diff');
  });

  it('fires on validation and fetch errors', () => {
    const withErrors = { ...report, validation: { checkedAt: '', urlCount: 1, issues: [], counts: {}, bySeverity: { error: 2, warning: 0, info: 0 } }, snapshot: { ...report.snapshot, stats: { ...report.snapshot.stats, errorCount: 1 } } };
    assert.deepEqual(evaluateAlert(withErrors, { minAdded: 0, minRemoved: 0 }).reasons, ['2 validation errors', '1 sitemaps failed']);
    assert.equal(evaluateAlert(withErrors, { minAdded: 0, minRemoved: 0, onErrors: false, onFetchErrors: false }).fire, false);
  });
});

describe('alert message', () => {
  const m = buildAlertMessage(report, ['2 URLs added'], { maxUrls: 1, reportUrl: 'https://r.example/shop/report.html' });

  it('carries facts, URL samples and totals', () => {
    assert.equal(m.title, 'Sitemap change: shop');
    assert.deepEqual(m.added, [`${O}/p/4`]);
    assert.equal(m.addedTotal, 2);
    assert.equal(m.removedTotal, 3);
    assert.ok(m.facts.some(([k, v]) => k === 'Change' && v === '-1 (-25%)'));
    const text = alertText(m);
    assert.match(text, /\+ https:\/\/www\.example\.com\/p\/4\n {2}and 1 more/);
    assert.match(text, /Report: https:\/\/r\.example/);
  });

  it('renders Slack Block Kit with escaped mrkdwn', () => {
    const payload = slackPayload(m) as { text: string; blocks: Array<{ type: string; text?: { text: string } }> };
    assert.equal(payload.text, 'Sitemap change: shop: 2 URLs added');
    assert.equal(payload.blocks[0]!.type, 'header');
    const all = JSON.stringify(payload);
    assert.ok(!all.includes('<5>'), 'angle brackets in URLs are encoded');
    assert.equal(slackEscape('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  });

  it('renders Telegram HTML within the length limit', () => {
    const text = telegramText(m);
    assert.match(text, /^<b>Sitemap change: shop<\/b>/);
    assert.match(text, /<a href="https:\/\/r\.example\/shop\/report\.html">Full report<\/a>/);
    const long: AlertMessage = { ...m, added: Array.from({ length: 400 }, (_, i) => `${O}/very/long/path/${i}`), addedTotal: 400 };
    const cut = telegramText(long);
    assert.ok(cut.length <= TELEGRAM_MAX_LENGTH);
    assert.match(cut, /\(truncated\)<\/i>$/);
  });
});

describe('channels', () => {
  const m = buildAlertMessage(report, ['test']);

  it('posts to a Slack webhook', async () => {
    const mock = new MockFetch().on('POST', 'https://hooks.slack.com/services/T0/B0/XYZ', { status: 200, body: 'ok' });
    await new SlackChannel('https://hooks.slack.com/services/T0/B0/XYZ', { fetch: mock.fetch }).send(m);
    const call = mock.calls[0]!;
    assert.equal(call.headers['content-type'], 'application/json');
    assert.ok(Array.isArray(JSON.parse(call.body).blocks));
  });

  it('throws on Slack errors', async () => {
    const mock = new MockFetch().on('POST', /slack/, { status: 404, body: 'no_service' });
    await assert.rejects(new SlackChannel('https://hooks.slack.com/x', { fetch: mock.fetch, retries: 0 }).send(m), /HTTP 404: no_service/);
  });

  it('sends a Telegram message, waiting on retry_after', async () => {
    const waits: number[] = [];
    const url = 'https://api.telegram.org/bot123:SECRET/sendMessage';
    const mock = new MockFetch().on('POST', url, { status: 429, json: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 2 } } }, { status: 200, json: { ok: true } });
    await new TelegramChannel({ botToken: '123:SECRET', chatId: '-100123', messageThreadId: 7, http: { fetch: mock.fetch }, sleep: async (ms) => void waits.push(ms) }).send(m);
    assert.deepEqual(waits, [2000]);
    const body = JSON.parse(mock.calls[1]!.body);
    assert.equal(body.chat_id, '-100123');
    assert.equal(body.parse_mode, 'HTML');
    assert.equal(body.message_thread_id, 7);
  });

  it('never leaks the Telegram bot token in errors', async () => {
    const failing = new MockFetch().on('POST', /telegram/, new Error('connect ECONNREFUSED https://api.telegram.org/bot123:SECRET/sendMessage'));
    await assert.rejects(new TelegramChannel({ botToken: '123:SECRET', chatId: 1, http: { fetch: failing.fetch, sleep: noSleep } }).send(m), (e: unknown) => e instanceof Error && !e.message.includes('SECRET'));
    const denied = new MockFetch().on('POST', /telegram/, { status: 403, json: { ok: false, description: 'Forbidden: bot was blocked by the user' } });
    await assert.rejects(new TelegramChannel({ botToken: '123:SECRET', chatId: 1, http: { fetch: denied.fetch } }).send(m), /403: Forbidden/);
  });

  it('signs generic webhooks with HMAC-SHA256', async () => {
    const mock = new MockFetch().on('POST', 'https://hooks.example.com/sitemaps', { status: 204 });
    await new WebhookChannel({ url: 'https://hooks.example.com/sitemaps', secret: 's3cret', headers: { authorization: 'Bearer abc' }, http: { fetch: mock.fetch } }).send(m);
    const call = mock.calls[0]!;
    assert.equal(call.headers['x-signature-256'], `sha256=${createHmac('sha256', 's3cret').update(call.body).digest('hex')}`);
    assert.equal(call.headers['authorization'], 'Bearer abc');
    const body = JSON.parse(call.body);
    assert.equal(body.event, 'sitemap.changed');
    assert.equal(body.site, 'shop');
    assert.match(body.text, /Sitemap change: shop/);
    assert.equal(signBody('x', 'k'), `sha256=${createHmac('sha256', 'k').update('x').digest('hex')}`);
  });

  it('sendAlerts collects failures instead of throwing', async () => {
    const mock = new MockFetch().on('POST', 'https://ok.example/', { status: 200 }).on('POST', 'https://bad.example/', { status: 500 });
    const results = await sendAlerts(
      [new WebhookChannel({ url: 'https://ok.example/', http: { fetch: mock.fetch } }), new WebhookChannel({ url: 'https://bad.example/', http: { fetch: mock.fetch, retries: 0 } })],
      m,
    );
    assert.deepEqual(results, [{ channel: 'webhook', ok: true }, { channel: 'webhook', ok: false, error: 'webhook returned HTTP 500' }]);
  });
});
