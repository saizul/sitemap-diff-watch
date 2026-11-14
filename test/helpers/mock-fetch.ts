import type { FetchLike } from '../../src/types.js';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export type Reply =
  | { status?: number; body?: string | Uint8Array; json?: unknown; headers?: Record<string, string> }
  | Error
  | ((call: RecordedCall) => Reply | Promise<Reply>);

interface Route {
  method: string;
  match: (url: string) => boolean;
  replies: Reply[];
}

/**
 * A scripted `fetch`. Register routes with `on()`; each call takes the next reply of the
 * first matching route (the last reply repeats). Unmatched requests get a 404. Every call
 * is recorded.
 */
export class MockFetch {
  readonly calls: RecordedCall[] = [];
  private readonly routes: Route[] = [];

  on(method: string, pattern: string | RegExp, ...replies: Reply[]): this {
    this.routes.push({
      method: method.toUpperCase(),
      match: (url) => (typeof pattern === 'string' ? url === pattern : pattern.test(url)),
      replies,
    });
    return this;
  }

  /** Shorthand for a GET route that always returns `body`. */
  get(url: string, body: string | Uint8Array, headers: Record<string, string> = { 'content-type': 'application/xml' }, status = 200): this {
    return this.on('GET', url, { status, body, headers });
  }

  callsTo(pattern: string | RegExp): RecordedCall[] {
    return this.calls.filter((c) => (typeof pattern === 'string' ? c.url === pattern : pattern.test(c.url)));
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: RecordedCall = { url, method, headers, body: init?.body ? String(init.body) : '' };
    this.calls.push(call);
    if (init?.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
    const route = this.routes.find((r) => (r.method === method || (r.method === 'GET' && method === 'HEAD')) && r.match(url));
    if (!route) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    let reply = route.replies.length > 1 ? route.replies.shift()! : route.replies[0]!;
    while (typeof reply === 'function') reply = await reply(call);
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    const nullBody = status === 204 || status === 304 || method === 'HEAD' || (status >= 300 && status < 400 && reply.body === undefined);
    const body = reply.json !== undefined ? JSON.stringify(reply.json) : reply.body ?? '';
    return new Response(nullBody ? null : (body as BodyInit), { status, headers: reply.headers ?? {} });
  };
}

export const noSleep = async (): Promise<void> => {};

/** A clock that only moves when `sleep` is called, for rate limiter tests. */
export function fakeTime(start = Date.parse('2026-11-14T12:00:00Z')): { clock: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    clock: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    slept,
  };
}
