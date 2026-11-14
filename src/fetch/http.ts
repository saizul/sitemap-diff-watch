import { FetchError } from '../errors.js';
import { realSleep, type FetchLike, type SleepFn } from '../types.js';
import { DEFAULT_USER_AGENT } from '../version.js';

export interface HttpOptions {
  /** Injectable `fetch`; defaults to the global one. */
  fetch?: FetchLike;
  userAgent?: string;
  /** Per-request timeout in milliseconds, body included (default 60 s). */
  timeoutMs?: number;
  /** Retries for network errors, 429 and 5xx (default 2). */
  retries?: number;
  /** Base delay for exponential backoff in milliseconds (default 500). */
  retryDelayMs?: number;
  sleep?: SleepFn;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface HttpRequest {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * `fetch` with a User-Agent, a timeout and retries with exponential backoff for network
 * errors, 408/425/429 and 5xx. `Retry-After` (seconds) is honoured, capped at 60 s.
 * Non-2xx responses are returned, not thrown, so callers can look at the status.
 */
export async function httpRequest(url: string, request: HttpRequest = {}, options: HttpOptions = {}): Promise<Response> {
  const doFetch = options.fetch ?? (globalThis.fetch as FetchLike);
  const retries = options.retries ?? 2;
  const baseDelay = options.retryDelayMs ?? 500;
  const sleep = options.sleep ?? realSleep;
  const timeoutMs = options.timeoutMs ?? 60_000;
  let attempt = 0;
  for (;;) {
    // AbortSignal.timeout covers the whole exchange, body included. Its timer does not keep
    // the event loop alive, so a second, ordinary timer guards the wait for the headers.
    const timeout = AbortSignal.timeout(timeoutMs);
    const headers = new AbortController();
    const timer = setTimeout(() => headers.abort(new DOMException('timed out', 'TimeoutError')), timeoutMs);
    const signals = [timeout, headers.signal, ...(options.signal ? [options.signal] : [])];
    const signal = AbortSignal.any(signals);
    const timedOut = (): boolean => timeout.aborted || headers.signal.aborted;
    try {
      const response = await doFetch(url, {
        method: request.method ?? 'GET',
        headers: {
          'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
          ...options.headers,
          ...request.headers,
        },
        ...(request.body !== undefined ? { body: request.body } : {}),
        redirect: request.redirect ?? 'follow',
        signal,
      });
      if (RETRYABLE.has(response.status) && attempt < retries) {
        const wait = retryAfterMs(response.headers.get('retry-after')) ?? backoff(baseDelay, attempt);
        await response.body?.cancel().catch(() => {});
        attempt++;
        await sleep(wait);
        continue;
      }
      return response;
    } catch (error) {
      if (options.signal?.aborted) throw new FetchError(`request to ${url} was aborted`, url, undefined, { cause: error });
      if (attempt >= retries) {
        const reason = timedOut() ? `timed out after ${timeoutMs} ms` : error instanceof Error ? error.message : String(error);
        throw new FetchError(`request to ${url} failed: ${reason}`, url, undefined, { cause: error });
      }
      attempt++;
      await sleep(backoff(baseDelay, attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

function backoff(base: number, attempt: number): number {
  return base * 2 ** attempt;
}

export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 60) * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  return undefined;
}

/** GET a URL and return the body as text, throwing {@link FetchError} on non-2xx. */
export async function fetchText(url: string, options: HttpOptions = {}, maxBytes = 10 * 1024 * 1024): Promise<{ text: string; status: number; finalUrl: string }> {
  const response = await httpRequest(url, {}, options);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new FetchError(`GET ${url} returned HTTP ${response.status}`, url, response.status);
  }
  const text = await readLimited(response, maxBytes, url);
  return { text, status: response.status, finalUrl: response.url || url };
}

/** Read a response body as UTF-8, stopping at `maxBytes` (the rest is discarded, not an error). */
export async function readLimited(response: Response, maxBytes: number, _url: string): Promise<string> {
  if (!response.body) return '';
  const decoder = new TextDecoder();
  let total = 0;
  let out = '';
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - total;
      if (value.length >= room) {
        out += decoder.decode(value.subarray(0, room));
        total = maxBytes;
        await reader.cancel().catch(() => {});
        break;
      }
      total += value.length;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return out + decoder.decode();
}
