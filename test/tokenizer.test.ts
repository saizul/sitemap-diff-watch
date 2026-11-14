import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ParseError } from '../src/errors.js';
import { decodeEntities, escapeHtml, escapeXml } from '../src/xml/entities.js';
import { XmlTokenizer, type XmlElement } from '../src/xml/tokenizer.js';

type Event = [string, string, ...unknown[]];

function events(xml: string, chunkSize = xml.length): Event[] {
  const out: Event[] = [];
  let text = '';
  const flush = (): void => {
    if (text.trim()) out.push(['text', text.trim()]);
    text = '';
  };
  const t = new XmlTokenizer({
    open: (el: XmlElement, self) => {
      flush();
      out.push(['open', el.qname, el.ns, { ...el.attrs }, self]);
    },
    close: (el) => {
      flush();
      out.push(['close', el.qname]);
    },
    text: (s) => {
      text += s;
    },
  });
  for (let i = 0; i < xml.length; i += chunkSize) t.write(xml.slice(i, i + chunkSize));
  t.end();
  return out;
}

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE urlset [ <!ENTITY boom "BOOM"> ]>
<!-- a comment with <tags> & stuff -->
<root xmlns="urn:default" xmlns:p="urn:p" a="1 &gt; 0" b='single "quoted"'>
  <p:item id="x">Fish &amp; chips &#169; &#x263A; &boom; &nbsp;</p:item>
  <empty/>
  <![CDATA[<raw> & text]]>
  <nested><p:deep xmlns:p="urn:other"/></nested>
</root>`;

describe('XmlTokenizer', () => {
  it('reports elements, attributes, namespaces and decoded text', () => {
    const ev = events(SAMPLE);
    assert.deepEqual(ev[0], ['open', 'root', 'urn:default', { xmlns: 'urn:default', 'xmlns:p': 'urn:p', a: '1 > 0', b: 'single "quoted"' }, false]);
    assert.deepEqual(ev[1], ['open', 'p:item', 'urn:p', { id: 'x' }, false]);
    // Custom and HTML entities are not expanded.
    assert.deepEqual(ev[2], ['text', 'Fish & chips © ☺ &boom; &nbsp;']);
    assert.deepEqual(ev[4], ['open', 'empty', 'urn:default', {}, true]);
    assert.deepEqual(ev[6], ['text', '<raw> & text']);
    const deep = ev.find((e) => e[1] === 'p:deep');
    assert.equal(deep?.[2], 'urn:other', 'inner xmlns:p overrides the outer one');
  });

  it('gives the same events however the input is chunked', () => {
    const whole = events(SAMPLE);
    for (const size of [1, 2, 3, 5, 7, 13, 64]) assert.deepEqual(events(SAMPLE, size), whole, `chunk size ${size}`);
  });

  it('keeps ">" inside quoted attribute values', () => {
    const ev = events('<a href="x>y" title=\'a>b\'/>');
    assert.deepEqual(ev[0], ['open', 'a', '', { href: 'x>y', title: 'a>b' }, true]);
  });

  it('passes the XML declaration to the handler', () => {
    let decl: Record<string, string> | undefined;
    const t = new XmlTokenizer({ open() {}, close() {}, text() {}, declaration: (d) => (decl = d) });
    t.write('<?xml version="1.0" encoding="ISO-8859-1"?><r/>');
    t.end();
    assert.deepEqual(decl, { version: '1.0', encoding: 'ISO-8859-1' });
  });

  it('flags undeclared prefixes', () => {
    let el: XmlElement | undefined;
    const t = new XmlTokenizer({ open: (e) => (e.qname === 'image:loc' ? (el = e) : undefined), close() {}, text() {} });
    t.write('<r><image:loc>x</image:loc></r>');
    t.end();
    assert.equal(el?.undeclaredPrefix, true);
    assert.equal(el?.local, 'loc');
    assert.equal(el?.prefix, 'image');
  });

  const bad: Array<[string, RegExp]> = [
    ['<a><b></a>', /mismatched closing tag: expected <\/b>/],
    ['<a><b>', /not closed/],
    ['text<a/>', /text outside the root/],
    ['<a/><b/>', /content after the root/],
    ['<a x="1" x="2"/>', /duplicate attribute/],
    ['<a x=1/>', /malformed attribute/],
    ['', /no root element/],
    ['<a><!-- never closed', /unexpected end/],
    ['</a>', /unexpected closing tag/],
  ];
  for (const [xml, message] of bad) {
    it(`rejects ${JSON.stringify(xml)}`, () => {
      assert.throws(() => events(xml), (err: unknown) => err instanceof ParseError && message.test(err.message));
    });
  }

  it('reports line and column of errors', () => {
    try {
      events('<a>\n  <b>\n  </c>\n</a>');
      assert.fail('expected an error');
    } catch (error) {
      assert.ok(error instanceof ParseError);
      assert.equal(error.line, 3);
      assert.equal(error.column, 3);
    }
  });

  it('limits nesting depth', () => {
    const t = new XmlTokenizer({ open() {}, close() {}, text() {} }, { maxDepth: 3 });
    assert.throws(() => t.write('<a><b><c><d>'), /nested deeper than 3/);
  });

  it('limits the size of a single token', () => {
    const t = new XmlTokenizer({ open() {}, close() {}, text() {} }, { maxTokenLength: 100 });
    t.write('<a>');
    t.write('long text is streamed, not held: '.repeat(20));
    assert.throws(() => t.write(`<b title="${'x'.repeat(200)}`), /maximum token length/);
  });

  it('refuses writes after end', () => {
    const t = new XmlTokenizer({ open() {}, close() {}, text() {} });
    t.write('<a/>');
    t.end();
    assert.throws(() => t.write('<b/>'), /after end/);
  });
});

describe('entities', () => {
  it('decodes predefined and numeric references only', () => {
    assert.equal(decodeEntities('&lt;&gt;&amp;&quot;&apos;&#65;&#x42;'), '<>&"\'AB');
    // XML only allows a lower-case x in hexadecimal character references.
    assert.equal(decodeEntities('&#X43;'), '&#X43;');
    assert.equal(decodeEntities('&copy; &#0; &#xD800; &#1114112;'), '&copy; &#0; &#xD800; &#1114112;');
  });
  it('escapes for XML and HTML', () => {
    assert.equal(escapeXml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;');
    assert.equal(escapeHtml(`'"<>&`), '&#39;&quot;&lt;&gt;&amp;');
  });
});
