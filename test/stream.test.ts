import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSitemapBuffer, parseSitemapStream, TooLargeError } from '../src/parse/stream.js';
import { bigUrlset, fixture, gz } from './helpers/fixtures.js';

async function* chunks(data: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}

describe('parseSitemapStream', () => {
  it('detects gzip from the magic bytes, even when split across chunks', async () => {
    const data = gz(fixture('urlset-basic.xml'));
    let count = 0;
    const result = await parseSitemapStream(chunks(data, 1), { onUrl: () => count++ });
    assert.equal(result.gzip, true);
    assert.equal(result.kind, 'urlset');
    assert.equal(count, 5);
    assert.equal(result.compressedBytes, data.length);
    assert.equal(result.bytes, Buffer.byteLength(fixture('urlset-basic.xml')));
  });

  it('reads a web ReadableStream (a fetch body)', async () => {
    const response = new Response(gz(fixture('sitemap-index.xml')));
    const refs: string[] = [];
    const result = await parseSitemapStream(response.body!, { onSitemap: (s) => refs.push(s.loc) });
    assert.equal(result.kind, 'sitemapindex');
    assert.equal(refs.length, 2);
  });

  it('streams a 50,000 URL sitemap of about 4 MB', async () => {
    const xml = bigUrlset(50_000);
    const data = gz(xml);
    let count = 0;
    let last = '';
    const started = Date.now();
    const result = await parseSitemapStream(chunks(data, 16 * 1024), {
      onUrl: (u) => {
        count++;
        last = u.loc;
      },
    });
    assert.equal(count, 50_000);
    assert.equal(last, 'https://www.example.com/products/item-49999');
    assert.equal(result.bytes, Buffer.byteLength(xml));
    assert.ok(Date.now() - started < 15_000, 'parses in reasonable time');
  });

  it('warns past the 50 MB protocol limit and stops at the hard cap', async () => {
    // Pretend: a 70 MB document of whitespace inside the root, generated lazily.
    async function* huge(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
      const pad = new Uint8Array(1024 * 1024).fill(0x20);
      for (let i = 0; i < 70; i++) yield pad;
      yield new TextEncoder().encode('</urlset>');
    }
    const warnings: string[] = [];
    const result = await parseSitemapStream(huge(), { onWarning: (w) => warnings.push(w.code) });
    assert.deepEqual(warnings, ['sitemap-too-large']);
    assert.ok(result.bytes > 52_428_800);
    await assert.rejects(parseSitemapStream(huge(), { maxBytes: 10 * 1024 * 1024 }), TooLargeError);
  });

  it('stops a gzip bomb at the hard cap', async () => {
    const bomb = gz(`<urlset>${' '.repeat(20 * 1024 * 1024)}</urlset>`);
    assert.ok(bomb.length < 100 * 1024, 'the compressed bomb is small');
    await assert.rejects(parseSitemapStream(chunks(bomb, 4096), { maxBytes: 1024 * 1024 }), TooLargeError);
  });

  it('parses text sitemaps and warns about invalid lines', async () => {
    const { result, urls, warnings } = await parseSitemapBuffer(fixture('text-sitemap.txt'));
    assert.equal(result.kind, 'text');
    assert.deepEqual(urls.map((u) => u.loc), ['https://www.example.com/', 'https://www.example.com/about', 'https://www.example.com/contact']);
    assert.deepEqual(warnings.map((w) => w.code), ['invalid-text-line']);
  });

  it('handles a UTF-8 BOM and leading whitespace', async () => {
    const { result, urls } = await parseSitemapBuffer(`\uFEFF\n  ${fixture('urlset-basic.xml')}`);
    assert.equal(result.kind, 'urlset');
    assert.equal(urls.length, 5);
  });

  it('decodes multi-byte UTF-8 split across chunks', async () => {
    const xml = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.example/ঢাকা</loc></url></urlset>';
    const urls: string[] = [];
    await parseSitemapStream(chunks(new TextEncoder().encode(xml), 1), { onUrl: (u) => urls.push(u.loc) });
    assert.deepEqual(urls, ['https://a.example/ঢাকা']);
  });

  it('warns about invalid UTF-8', async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('<urlset><url><loc>https://a.example/'), 0xff, 0xfe, ...new TextEncoder().encode('</loc></url></urlset>')]);
    const { warnings } = await parseSitemapBuffer(bytes);
    assert.ok(warnings.some((w) => w.code === 'invalid-utf8'));
  });

  it('treats an empty body as an empty text sitemap', async () => {
    const { result, urls } = await parseSitemapBuffer('');
    assert.equal(result.kind, 'text');
    assert.equal(urls.length, 0);
  });
});
