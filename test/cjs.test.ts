import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type * as Api from '../src/index.js';

const require = createRequire(import.meta.url);

describe('CommonJS build', () => {
  it('can be required and exposes the same API', async () => {
    // dist/test/cjs.test.js -> dist/cjs/index.js
    const cjs = require('../cjs/index.js') as typeof Api;
    const esm = await import('../src/index.js');
    assert.equal(cjs.VERSION, esm.VERSION);
    assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort());
    const { urls } = cjs.parseSitemapXml('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.example/</loc></url></urlset>');
    assert.equal(urls[0]!.loc, 'https://a.example/');
  });

  it('loads node:sqlite lazily from CommonJS too', async () => {
    const cjs = require('../cjs/index.js') as typeof Api;
    assert.equal(typeof (await cjs.sqliteAvailable()), 'boolean');
  });
});
