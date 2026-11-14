import { Readable, pipeline } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import { SitemapWatchError } from '../errors.js';
import { SITEMAP_LIMITS } from '../limits.js';
import type { ParseWarning, SitemapRef, UrlEntry } from '../types.js';
import { SitemapParser, type DocumentKind, type ParseSummary } from './sitemap-parser.js';
import { TextSitemapParser } from './text-sitemap.js';

export interface StreamParseOptions {
  source?: string;
  onUrl?(entry: UrlEntry): void;
  onSitemap?(ref: SitemapRef): void;
  onWarning?(warning: ParseWarning): void;
  /**
   * Hard cap on uncompressed bytes (default 100 MiB). Reading stops with an error past it,
   * which also protects against gzip bombs. Going over the protocol's 50 MB limit only
   * produces a `sitemap-too-large` warning.
   */
  maxBytes?: number;
}

export interface StreamParseResult extends Omit<ParseSummary, 'kind'> {
  kind: DocumentKind | 'text';
  /** Uncompressed size in bytes. */
  bytes: number;
  /** Size as received, before gunzip. */
  compressedBytes: number;
  gzip: boolean;
}

/** Thrown when a document is bigger than `maxBytes` after decompression. */
export class TooLargeError extends SitemapWatchError {
  constructor(readonly limit: number) {
    super(`document is larger than ${limit} bytes uncompressed`);
    this.name = 'TooLargeError';
  }
}

export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

type ByteSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

function toAsyncIterable(source: ByteSource): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in source) return source as AsyncIterable<Uint8Array>;
  return Readable.fromWeb(source as NodeReadableStream<Uint8Array>);
}

/**
 * Parse a sitemap from a byte stream: XML urlset, sitemap index, RSS/Atom feed or a plain
 * text list of URLs. Gzip is detected from the magic bytes (`1f 8b`), so `.xml.gz` files
 * work whatever their `Content-Type`. Nothing but the current chunk is held in memory.
 */
export async function parseSitemapStream(source: ByteSource, options: StreamParseOptions = {}): Promise<StreamParseResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const input = toAsyncIterable(source);
  let compressedBytes = 0;

  const iterator = input[Symbol.asyncIterator]();
  // Peek at least two bytes to detect gzip.
  const head: Uint8Array[] = [];
  let headLength = 0;
  let done = false;
  while (headLength < 2) {
    const next = await iterator.next();
    if (next.done) {
      done = true;
      break;
    }
    const chunk = toUint8(next.value);
    head.push(chunk);
    headLength += chunk.length;
  }
  const first = concat(head);
  const gzip = first.length >= 2 && first[0] === 0x1f && first[1] === 0x8b;

  async function* raw(): AsyncGenerator<Uint8Array> {
    if (first.length) {
      compressedBytes += first.length;
      yield first;
    }
    if (done) return;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        const chunk = toUint8(next.value);
        compressedBytes += chunk.length;
        yield chunk;
      }
    } finally {
      // Stop the underlying body when parsing stops early (size limit, parse error).
      await iterator.return?.();
    }
  }

  let bytesIterable: AsyncIterable<Uint8Array>;
  if (gzip) {
    const gunzip = createGunzip();
    pipeline(Readable.from(raw()), gunzip, () => {});
    bytesIterable = gunzip;
  } else {
    bytesIterable = raw();
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  let bytes = 0;
  let warnedSize = false;
  let parser: SitemapParser | TextSitemapParser | undefined;
  let pending = '';
  let sawReplacement = false;

  const feed = (text: string): void => {
    if (!sawReplacement && text.includes('�')) {
      sawReplacement = true;
      options.onWarning?.({
        code: 'invalid-utf8',
        message: 'the document contains bytes that are not valid UTF-8',
        ...(options.source ? { sitemap: options.source } : {}),
      });
    }
    if (!parser) {
      pending += text;
      const trimmed = pending.trimStart();
      if (trimmed.length === 0) return;
      parser = trimmed.startsWith('<')
        ? new SitemapParser(options)
        : new TextSitemapParser(options);
      text = pending;
      pending = '';
    }
    parser.write(text);
  };

  for await (const chunk of bytesIterable) {
    const buf = toUint8(chunk);
    bytes += buf.length;
    if (bytes > maxBytes) {
      if (gzip) (bytesIterable as ReturnType<typeof createGunzip>).destroy();
      throw new TooLargeError(maxBytes);
    }
    if (!warnedSize && bytes > SITEMAP_LIMITS.maxBytes) {
      warnedSize = true;
      options.onWarning?.({
        code: 'sitemap-too-large',
        message: `uncompressed size is over the ${SITEMAP_LIMITS.maxBytes.toLocaleString('en-US')} byte (50 MB) limit`,
        ...(options.source ? { sitemap: options.source } : {}),
      });
    }
    feed(decoder.decode(buf, { stream: true }));
  }
  feed(decoder.decode());
  if (!parser) parser = new TextSitemapParser(options);
  const summary = parser.end();
  return { ...summary, bytes, compressedBytes, gzip };
}

/** Parse a complete document held in memory (string, Buffer or Uint8Array; gzip allowed). */
export async function parseSitemapBuffer(
  data: string | Uint8Array,
  options: Omit<StreamParseOptions, 'onUrl' | 'onSitemap' | 'onWarning'> = {},
): Promise<{ result: StreamParseResult; urls: UrlEntry[]; sitemaps: SitemapRef[]; warnings: ParseWarning[] }> {
  const urls: UrlEntry[] = [];
  const sitemaps: SitemapRef[] = [];
  const warnings: ParseWarning[] = [];
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  async function* once(): AsyncGenerator<Uint8Array> {
    // Feed in 64 KiB slices, like a network stream would.
    for (let i = 0; i < bytes.length; i += 65536) yield bytes.subarray(i, i + 65536);
  }
  const result = await parseSitemapStream(once(), {
    ...options,
    onUrl: (u) => urls.push(u),
    onSitemap: (s) => sitemaps.push(s),
    onWarning: (w) => warnings.push(w),
  });
  return { result, urls, sitemaps, warnings };
}

function toUint8(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw new TypeError('expected a byte stream');
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
