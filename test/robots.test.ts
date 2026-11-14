import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchRobotsTxt, RobotsCache } from '../src/robots/fetch-robots.js';
import { isAllowed, matchPattern, parseRobotsTxt, pathForMatching, productToken } from '../src/robots/robots.js';
import { fixture } from './helpers/fixtures.js';
import { MockFetch, noSleep } from './helpers/mock-fetch.js';

const robots = parseRobotsTxt(fixture('robots.txt'));
const allowed = (url: string, ua: string): boolean => isAllowed(robots, url, ua).allowed;

describe('parseRobotsTxt', () => {
  it('groups consecutive user-agent lines and collects sitemaps', () => {
    assert.equal(robots.groups.length, 3);
    assert.deepEqual(robots.groups[1]!.agents, ['googlebot', 'bingbot']);
    assert.deepEqual(robots.sitemaps, ['https://www.example.com/sitemap_index.xml', 'https://www.example.com/news-sitemap.xml']);
  });

  it('ignores comments, unknown fields and an empty Disallow', () => {
    const r = parseRobotsTxt('User-agent: *  # all\nCrawl-delay: 10\nDisallow:\nnonsense line\n');
    assert.deepEqual(r.groups, [{ agents: ['*'], rules: [] }]);
    assert.equal(r.invalidLines, 1);
  });

  it('accepts CR, LF and CRLF line endings and a BOM', () => {
    const r = parseRobotsTxt('\uFEFFUser-agent: *\r\nDisallow: /a\rDisallow: /b\n');
    assert.deepEqual(r.groups[0]!.rules.map((x) => x.pattern), ['/a', '/b']);
  });
});

describe('isAllowed (RFC 9309)', () => {
  it('applies the * group to unknown crawlers', () => {
    assert.equal(allowed('https://www.example.com/private/x', 'SomeBot/1.0'), false);
    assert.equal(allowed('https://www.example.com/public', 'SomeBot/1.0'), true);
  });

  it('uses only the most specific group (Googlebot ignores the * rules)', () => {
    assert.equal(allowed('https://www.example.com/private/x', 'Googlebot'), true);
    assert.equal(allowed('https://www.example.com/search?q=a', 'Googlebot/2.1 (+http://www.google.com/bot.html)'), false);
    assert.equal(allowed('https://www.example.com/search?q=a', 'bingbot'), false);
  });

  it('lets the longest match win and allow win ties', () => {
    assert.equal(allowed('https://www.example.com/private/public-report', 'AnyBot'), true);
    assert.equal(allowed('https://www.example.com/search/about', 'Googlebot'), true);
    const tie = parseRobotsTxt('User-agent: *\nDisallow: /page\nAllow: /page\n');
    assert.equal(isAllowed(tie, '/page', 'x').allowed, true);
  });

  it('supports * wildcards and the $ anchor', () => {
    assert.equal(allowed('https://www.example.com/files/report.pdf', 'AnyBot'), false);
    assert.equal(allowed('https://www.example.com/files/report.pdf?download=1', 'AnyBot'), true);
    assert.equal(allowed('https://www.example.com/', 'BadBot'), false);
  });

  it('combines groups that name the same agent', () => {
    const r = parseRobotsTxt('User-agent: a\nDisallow: /x\n\nUser-agent: b\nDisallow: /y\n\nUser-agent: a\nDisallow: /z\n');
    assert.equal(isAllowed(r, '/x', 'a').allowed, false);
    assert.equal(isAllowed(r, '/z', 'a').allowed, false);
    assert.equal(isAllowed(r, '/y', 'a').allowed, true);
  });

  it('always allows /robots.txt and everything when there are no rules', () => {
    assert.equal(isAllowed(parseRobotsTxt('User-agent: *\nDisallow: /'), 'https://a.example/robots.txt', 'x').allowed, true);
    assert.equal(isAllowed(parseRobotsTxt(''), '/anything', 'x').allowed, true);
  });

  it('matches percent-encoded and non-ASCII paths alike', () => {
    const r = parseRobotsTxt('User-agent: *\nDisallow: /ঢাকা/\n');
    assert.equal(isAllowed(r, 'https://a.example/%E0%A6%A2%E0%A6%BE%E0%A6%95%E0%A6%BE/x', 'x').allowed, false);
    assert.equal(pathForMatching('https://a.example/a%2fb?x=1#frag'), '/a%2Fb?x=1');
  });

  it('returns the deciding rule', () => {
    assert.deepEqual(isAllowed(robots, 'https://www.example.com/private/a', 'x').rule, { allow: false, pattern: '/private/' });
  });
});

describe('matchPattern', () => {
  const cases: Array<[string, string, boolean]> = [
    ['/fish', '/fish', true],
    ['/fish', '/fish.html', true],
    ['/fish', '/Fish.asp', false],
    ['/fish*', '/fishheads/yummy.html', true],
    ['/fish/', '/fish', false],
    ['/*.php', '/folder/filename.php?parameters', true],
    ['/*.php$', '/filename.php', true],
    ['/*.php$', '/filename.php?parameters', false],
    ['/fish*.php', '/fishheads/catfish.php?parameters', true],
    ['/fish*.php', '/Fish.PHP', false],
    ['/a*b*c', '/aXbYc', true],
    ['/a*b*c', '/aXcYb', false],
    ['/*', '/', true],
  ];
  for (const [pattern, path, expected] of cases) {
    it(`${pattern} ${expected ? 'matches' : 'does not match'} ${path}`, () => assert.equal(matchPattern(pattern, path), expected));
  }
  it('extracts the product token', () => assert.equal(productToken('Googlebot/2.1 (+http://www.google.com/bot.html)'), 'googlebot'));
});

describe('fetchRobotsTxt', () => {
  it('parses a 200 response', async () => {
    const mock = new MockFetch().get('https://www.example.com/robots.txt', fixture('robots.txt'), { 'content-type': 'text/plain' });
    const r = await fetchRobotsTxt('https://www.example.com/some/page', { fetch: mock.fetch });
    assert.equal(r.status, 'ok');
    assert.equal(r.robots.sitemaps.length, 2);
  });

  it('treats 4xx as "unavailable" (allow all) and 5xx or errors as "unreachable" (disallow all)', async () => {
    const mock = new MockFetch()
      .get('https://a.example/robots.txt', 'gone', {}, 404)
      .get('https://b.example/robots.txt', 'down', {}, 503)
      .on('GET', 'https://c.example/robots.txt', new Error('ECONNREFUSED'));
    const http = { fetch: mock.fetch, sleep: noSleep };
    assert.equal((await fetchRobotsTxt('https://a.example/', http)).status, 'unavailable');
    assert.equal((await fetchRobotsTxt('https://b.example/', http)).status, 'unreachable');
    const c = await fetchRobotsTxt('https://c.example/', http);
    assert.equal(c.status, 'unreachable');
    assert.match(c.error!, /ECONNREFUSED/);
  });

  it('RobotsCache fetches each origin once', async () => {
    const mock = new MockFetch().get('https://www.example.com/robots.txt', fixture('robots.txt'));
    const cache = new RobotsCache({ fetch: mock.fetch }, 'Googlebot');
    const [a, b] = await Promise.all([cache.check('https://www.example.com/search'), cache.check('https://www.example.com/ok')]);
    assert.equal(a.allowed, false);
    assert.equal(b.allowed, true);
    assert.equal(mock.calls.length, 1);
  });
});
