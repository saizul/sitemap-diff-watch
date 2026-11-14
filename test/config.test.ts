import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { interpolateEnv, loadConfig, validateConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { tempDir } from './helpers/fixtures.js';

describe('interpolateEnv', () => {
  it('replaces ${VAR} recursively and records missing variables', () => {
    const missing = new Set<string>();
    const out = interpolateEnv({ a: 'x-${ONE}-y', b: ['${TWO}', 3, true], c: { d: '${NOPE}' } }, { ONE: '1', TWO: '2' }, missing);
    assert.deepEqual(out, { a: 'x-1-y', b: ['2', 3, true], c: { d: '' } });
    assert.deepEqual([...missing], ['NOPE']);
  });
});

describe('validateConfig', () => {
  const site = { name: 'a', sitemaps: ['https://a.example/sitemap.xml'] };
  const bad: Array<[unknown, RegExp]> = [
    [null, /JSON object/],
    [{}, /"sites" must be a non-empty array/],
    [{ sites: [{ sitemaps: ['https://a.example/s.xml'] }] }, /name is required/],
    [{ sites: [site, site] }, /used twice/],
    [{ sites: [{ name: 'a', sitemaps: ['not a url'] }] }, /list of http\(s\) URLs/],
    [{ sites: [{ name: 'a' }] }, /needs "sitemaps" or a "discover" URL/],
    [{ sites: [{ ...site, sectionDepth: 0 }] }, /sectionDepth/],
    [{ sites: [site], alerts: { channels: [{ type: 'email' }] } }, /slack, telegram or webhook/],
    [{ sites: [site], alerts: { channels: [{ type: 'telegram', botToken: 'x' }] } }, /botToken" and "chatId"/],
    [{ sites: [{ ...site, alerts: { channels: [{ type: 'slack' }] } }] }, /sites\[0\]\.alerts\.channels\[0\]: "url" is required/],
    [{ sites: [site], store: { type: 'redis' } }, /store\.type/],
    [{ sites: [site], reports: { formats: ['pdf'] } }, /unknown format "pdf"/],
    [{ sites: [site], keep: -1 }, /keep must be/],
  ];
  for (const [config, message] of bad) {
    it(`rejects ${JSON.stringify(config)}`, () => assert.throws(() => validateConfig(config), (e: unknown) => e instanceof ConfigError && message.test(e.message)));
  }
  it('accepts a minimal config and a discover-only site', () => {
    assert.doesNotThrow(() => validateConfig({ sites: [site, { name: 'b', discover: 'https://b.example/' }] }));
  });
});

describe('loadConfig', () => {
  it('reads, interpolates and validates a file', async () => {
    const dir = await tempDir();
    try {
      const path = join(dir, 'watch.json');
      await writeFile(path, JSON.stringify({ sites: [{ name: 'a', sitemaps: ['https://a.example/sitemap.xml'] }], alerts: { channels: [{ type: 'slack', url: '${SLACK_URL}' }] } }));
      const loaded = await loadConfig(path, {});
      assert.equal(loaded.baseDir, dir);
      assert.deepEqual(loaded.missingEnv, ['SLACK_URL']);
      const withEnv = await loadConfig(path, { SLACK_URL: 'https://hooks.slack.com/x' });
      assert.deepEqual(withEnv.config.alerts?.channels, [{ type: 'slack', url: 'https://hooks.slack.com/x' }]);
      await writeFile(path, '{ nope');
      await assert.rejects(loadConfig(path, {}), /not valid JSON/);
      await assert.rejects(loadConfig(join(dir, 'missing.json'), {}), /cannot read config/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads the example configs', async () => {
    for (const name of ['config.example.json', 'config.minimal.json']) {
      const loaded = await loadConfig(new URL(`../../examples/${name}`, import.meta.url).pathname, {});
      assert.ok(loaded.config.sites.length >= 1, name);
    }
  });
});
