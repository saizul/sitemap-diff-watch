import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FetchError } from '../src/errors.js';
import { fetchText, httpRequest, readLimited, retryAfterMs } from '../src/fetch/http.js';
import { DEFAULT_USER_AGENT } from '../src/version.js';
import { MockFetch, noSleep } from './helpers/mock-fetch.js';

describe('httpRequest', () => {
  it('sends a User-Agent', async () => {
    const mock = new MockFetch().get('https://a.example/', 'ok');
    await httpRequest('https://a.example/', {}, { fetch: mock.fetch });
    assert.equal(mock.calls[0]!.headers['user-agent'], DEFAULT_USER_AGENT);
    await httpRequest('https://a.example/', {}, { fetch: mock.fetch, userAgent: 'MyBot/1.0' });
    assert.equal(mock.calls[1]!.headers['user-agent'], 'MyBot/1.0');
  });

  it('retries 503 and 429 with backoff and Retry-After', async () => {
    const waits: number[] = [];
    const mock = new MockFetch().on(
      'GET',
      'https://a.example/',
      { status: 503 },
      { status: 429, headers: { 'retry-after': '3' } },
      { status: 200, body: 'ok' },
    );
    const res = await httpRequest('https://a.example/', {}, { fetch: mock.fetch, retries: 2, retryDelayMs: 100, sleep: async (ms) => void waits.push(ms) });
    assert.equal(res.status, 200);
    assert.deepEqual(waits, [100, 3000]);
  });

  it('returns the last response when retries run out, and does not retry 404', async () => {
    const mock = new MockFetch().get('https://a.example/x', '', {}, 500).get('https://a.example/y', '', {}, 404);
    assert.equal((await httpRequest('https://a.example/x', {}, { fetch: mock.fetch, retries: 1, sleep: noSleep })).status, 500);
    assert.equal(mock.calls.length, 2);
    assert.equal((await httpRequest('https://a.example/y', {}, { fetch: mock.fetch, retries: 3, sleep: noSleep })).status, 404);
    assert.equal(mock.calls.length, 3);
  });

  it('retries network errors and then throws FetchError', async () => {
    const mock = new MockFetch().on('GET', 'https://a.example/', new Error('socket hang up'));
    await assert.rejects(httpRequest('https://a.example/', {}, { fetch: mock.fetch, retries: 2, sleep: noSleep }), (e: unknown) => e instanceof FetchError && /socket hang up/.test(e.message));
    assert.equal(mock.calls.length, 3);
  });

  it('times out', async () => {
    const slow = (_: string | URL, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    await assert.rejects(httpRequest('https://a.example/', {}, { fetch: slow, timeoutMs: 20, retries: 0 }), /timed out after 20 ms/);
  });

  it('parses Retry-After seconds and dates', () => {
    assert.equal(retryAfterMs('5'), 5000);
    assert.equal(retryAfterMs('600'), 60_000);
    assert.equal(retryAfterMs(null), undefined);
    assert.ok((retryAfterMs(new Date(Date.now() + 10_000).toUTCString()) ?? 0) > 5000);
  });
});

describe('fetchText and readLimited', () => {
  it('throws on non-2xx', async () => {
    const mock = new MockFetch().get('https://a.example/', 'nope', {}, 403);
    await assert.rejects(fetchText('https://a.example/', { fetch: mock.fetch }), (e: unknown) => e instanceof FetchError && e.status === 403);
  });
  it('truncates at maxBytes', async () => {
    const text = await readLimited(new Response('abcdefghij'), 4, 'x');
    assert.equal(text, 'abcd');
  });
});
