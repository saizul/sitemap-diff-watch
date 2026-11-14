import { createHmac } from 'node:crypto';
import { AlertError, errorMessage } from '../errors.js';
import { httpRequest, type HttpOptions } from '../fetch/http.js';
import { realSleep, type SleepFn } from '../types.js';
import { alertText, type AlertMessage } from './message.js';

export interface AlertChannel {
  readonly name: string;
  send(message: AlertMessage): Promise<void>;
}

export interface ChannelResult {
  channel: string;
  ok: boolean;
  error?: string;
}

/** Slack mrkdwn needs `&`, `<` and `>` escaped. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slackLink(url: string): string {
  return `<${url.replace(/[<>|]/g, encodeURIComponent)}|${slackEscape(url.length > 120 ? `${url.slice(0, 117)}...` : url)}>`;
}

/** Slack Block Kit payload. Also accepted by Mattermost, Rocket.Chat and Discord's `/slack` endpoint, which read `text`. */
export function slackPayload(m: AlertMessage): Record<string, unknown> {
  const fields = m.facts.map(([k, v]) => ({ type: 'mrkdwn', text: `*${slackEscape(k)}*\n${slackEscape(v)}` }));
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: m.title.slice(0, 150), emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: slackEscape(m.reasons.join(' · ')) }, ...(fields.length ? { fields: fields.slice(0, 10) } : {}) },
  ];
  const list = (label: string, urls: string[], total: number, sign: string): void => {
    if (!urls.length) return;
    const extra = total > urls.length ? `\n_and ${total - urls.length} more_` : '';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${label}*\n${urls.map((u) => `${sign} ${slackLink(u)}`).join('\n')}${extra}`.slice(0, 3000) } });
  };
  list('Added', m.added, m.addedTotal, '+');
  list('Removed', m.removed, m.removedTotal, '−');
  if (m.topSections.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: slackEscape(`Sections: ${m.topSections.join(', ')}`) }] });
  if (m.reportUrl) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: slackLink(m.reportUrl) } });
  return { text: `${m.title}: ${m.reasons.join('; ')}`, blocks };
}

export class SlackChannel implements AlertChannel {
  readonly name = 'slack';
  constructor(
    private readonly webhookUrl: string,
    private readonly http: HttpOptions = {},
  ) {}

  async send(m: AlertMessage): Promise<void> {
    const response = await httpRequest(this.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(slackPayload(m)) }, this.http);
    const body = await response.text().catch(() => '');
    // Slack answers "ok"; other implementations answer JSON or nothing.
    if (!response.ok) throw new AlertError(`Slack webhook returned HTTP ${response.status}: ${body.slice(0, 200)}`, response.status);
  }
}

function htmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Telegram limits a message to 4,096 characters after entity parsing. */
export const TELEGRAM_MAX_LENGTH = 4096;

export function telegramText(m: AlertMessage): string {
  const lines = [`<b>${htmlEscape(m.title)}</b>`, htmlEscape(m.reasons.join('; ')), ''];
  for (const [k, v] of m.facts) lines.push(`${htmlEscape(k)}: <b>${htmlEscape(v)}</b>`);
  if (m.topSections.length) lines.push(`Sections: ${htmlEscape(m.topSections.join(', '))}`);
  const urls = (label: string, list: string[], total: number, sign: string): void => {
    if (!list.length) return;
    lines.push('', `<b>${label}</b>`, ...list.map((u) => `${sign} ${htmlEscape(u)}`));
    if (total > list.length) lines.push(`<i>and ${total - list.length} more</i>`);
  };
  urls('Added', m.added, m.addedTotal, '+');
  urls('Removed', m.removed, m.removedTotal, '−');
  if (m.reportUrl) lines.push('', `<a href="${htmlEscape(m.reportUrl).replace(/"/g, '&quot;')}">Full report</a>`);
  let text = lines.join('\n');
  if (text.length > TELEGRAM_MAX_LENGTH) {
    // Cut on a line boundary so no tag is left open.
    const cut = text.lastIndexOf('\n', TELEGRAM_MAX_LENGTH - 20);
    text = `${text.slice(0, cut > 0 ? cut : TELEGRAM_MAX_LENGTH - 20)}\n<i>(truncated)</i>`;
  }
  return text;
}

export interface TelegramOptions {
  botToken: string;
  chatId: string | number;
  /** Forum topic id. */
  messageThreadId?: number;
  /** Override the API base, e.g. for a local Bot API server. */
  apiBase?: string;
  http?: HttpOptions;
  sleep?: SleepFn;
}

export class TelegramChannel implements AlertChannel {
  readonly name = 'telegram';
  constructor(private readonly options: TelegramOptions) {}

  async send(m: AlertMessage): Promise<void> {
    const base = (this.options.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
    const url = `${base}/bot${this.options.botToken}/sendMessage`;
    const payload = {
      chat_id: this.options.chatId,
      text: telegramText(m),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(this.options.messageThreadId !== undefined ? { message_thread_id: this.options.messageThreadId } : {}),
    };
    const sleep = this.options.sleep ?? realSleep;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, { retries: 0, ...this.options.http });
      } catch (error) {
        // Never surface the URL: it contains the bot token.
        throw new AlertError(`Telegram request failed: ${errorMessage(error).replaceAll(this.options.botToken, '<token>')}`);
      }
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string; parameters?: { retry_after?: number } };
      if (response.ok && data.ok !== false) return;
      const retryAfter = data.parameters?.retry_after;
      if (response.status === 429 && retryAfter !== undefined && attempt < 2) {
        await sleep(Math.min(retryAfter, 60) * 1000);
        continue;
      }
      throw new AlertError(`Telegram returned HTTP ${response.status}: ${(data.description ?? '').slice(0, 200)}`, response.status);
    }
  }
}

export interface WebhookOptions {
  url: string;
  /** Extra headers, e.g. an Authorization header for your endpoint. */
  headers?: Record<string, string>;
  /** When set, the body is signed: `X-Signature-256: sha256=<hex HMAC-SHA256>`. */
  secret?: string;
  http?: HttpOptions;
}

/** Sign a webhook body the way {@link WebhookChannel} does. */
export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export class WebhookChannel implements AlertChannel {
  readonly name = 'webhook';
  constructor(private readonly options: WebhookOptions) {}

  async send(m: AlertMessage): Promise<void> {
    const body = JSON.stringify({ event: 'sitemap.changed', sentAt: new Date().toISOString(), ...m, text: alertText(m) });
    const headers: Record<string, string> = { 'content-type': 'application/json', ...this.options.headers };
    if (this.options.secret) headers['x-signature-256'] = signBody(body, this.options.secret);
    const response = await httpRequest(this.options.url, { method: 'POST', headers, body }, this.options.http);
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new AlertError(`webhook returned HTTP ${response.status}`, response.status);
  }
}

/** Send to every channel; failures are collected, never thrown. */
export async function sendAlerts(channels: AlertChannel[], message: AlertMessage): Promise<ChannelResult[]> {
  return Promise.all(
    channels.map(async (ch) => {
      try {
        await ch.send(message);
        return { channel: ch.name, ok: true };
      } catch (error) {
        return { channel: ch.name, ok: false, error: errorMessage(error) };
      }
    }),
  );
}
