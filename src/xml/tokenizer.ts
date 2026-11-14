import { ParseError } from '../errors.js';
import { decodeEntities } from './entities.js';

export interface XmlElement {
  /** Qualified name as written, e.g. `image:loc`. */
  qname: string;
  /** Local part, e.g. `loc`. */
  local: string;
  /** Prefix, or `''` for none. */
  prefix: string;
  /** Resolved namespace URI, or `''` when no namespace applies. */
  ns: string;
  /** True when the prefix is not declared anywhere in scope (`ns` is then `''`). */
  undeclaredPrefix: boolean;
  /** Attributes by qualified name, entity-decoded. */
  attrs: Record<string, string>;
}

export interface XmlHandler {
  open(element: XmlElement, selfClosing: boolean): void;
  close(element: XmlElement): void;
  /** Character data, entity-decoded. Called possibly several times per text node. */
  text(text: string): void;
  /** The `<?xml ...?>` declaration, if any. */
  declaration?(attrs: Record<string, string>): void;
}

export interface TokenizerOptions {
  /** Maximum element nesting depth (default 64). Deeper documents are rejected. */
  maxDepth?: number;
  /** Maximum length of an unfinished tag, comment or CDATA section held in memory (default 1 MiB). */
  maxTokenLength?: number;
}

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/**
 * An incremental, non-validating XML tokenizer with namespace resolution.
 *
 * Feed it text in chunks of any size with `write()` and finish with `end()`; only the
 * unfinished token at the end of a chunk is kept in memory, so a 50 MB sitemap is parsed
 * without ever holding the whole document. DOCTYPE declarations are skipped and custom
 * entities are never expanded (no XXE, no entity expansion bombs).
 */
export class XmlTokenizer {
  private buf = '';
  private ended = false;
  private line = 1;
  private column = 1;
  private readonly stack: XmlElement[] = [];
  private readonly nsStack: Array<Map<string, string>> = [new Map([['xml', XML_NS]])];
  private readonly maxDepth: number;
  private readonly maxTokenLength: number;
  private sawRoot = false;
  private rootClosed = false;

  constructor(
    private readonly handler: XmlHandler,
    options: TokenizerOptions = {},
  ) {
    this.maxDepth = options.maxDepth ?? 64;
    this.maxTokenLength = options.maxTokenLength ?? 1024 * 1024;
  }

  /** Current nesting depth. */
  get depth(): number {
    return this.stack.length;
  }

  write(chunk: string): void {
    if (this.ended) throw new ParseError('write() after end()');
    this.buf += chunk;
    this.process();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.process();
    if (this.buf.trim().length > 0) this.fail('unexpected end of document inside a tag or comment');
    if (!this.sawRoot) this.fail('document has no root element');
    if (this.stack.length > 0) this.fail(`unexpected end of document: <${this.stack[this.stack.length - 1]!.qname}> is not closed`);
  }

  private process(): void {
    const buf = this.buf;
    const len = buf.length;
    let pos = 0;
    while (pos < len) {
      if (buf.charCodeAt(pos) !== 60 /* < */) {
        const lt = buf.indexOf('<', pos);
        if (lt === -1) {
          if (!this.ended) {
            // Emit what we have, but hold back a possibly unfinished entity reference
            // ("&am" + "p;") so it still decodes when the next chunk arrives.
            const amp = buf.lastIndexOf('&');
            let cut = len;
            if (amp >= pos && buf.indexOf(';', amp) === -1 && len - amp <= 12) cut = amp;
            if (cut > pos) {
              this.emitText(buf.slice(pos, cut));
              pos = cut;
            }
            break;
          }
          this.emitText(buf.slice(pos));
          pos = len;
          break;
        }
        this.emitText(buf.slice(pos, lt));
        pos = lt;
        continue;
      }
      const next = buf.charCodeAt(pos + 1);
      if (Number.isNaN(next)) break;
      let end: number;
      if (next === 33 /* ! */) {
        if (len - pos < 9 && !this.ended) break;
        if (buf.startsWith('<!--', pos)) {
          end = buf.indexOf('-->', pos + 4);
          if (end === -1) break;
          end += 3;
        } else if (buf.startsWith('<![CDATA[', pos)) {
          end = buf.indexOf(']]>', pos + 9);
          if (end === -1) break;
          this.emitRaw(buf.slice(pos + 9, end));
          end += 3;
        } else if (buf.startsWith('<!DOCTYPE', pos) || buf.startsWith('<!doctype', pos)) {
          end = findDoctypeEnd(buf, pos);
          if (end === -1) break;
          if (this.sawRoot) this.fail('DOCTYPE after the root element', pos);
        } else {
          this.fail('unsupported markup declaration', pos);
        }
      } else if (next === 63 /* ? */) {
        end = buf.indexOf('?>', pos + 2);
        if (end === -1) break;
        const body = buf.slice(pos + 2, end);
        end += 2;
        if (body.startsWith('xml') && /^xml(\s|$)/.test(body)) this.handler.declaration?.(parseAttributes(body.slice(3), this));
      } else if (next === 47 /* / */) {
        end = buf.indexOf('>', pos + 2);
        if (end === -1) break;
        this.closeTag(buf.slice(pos + 2, end).trim(), pos);
        end += 1;
      } else {
        end = findTagEnd(buf, pos + 1);
        if (end === -2) this.fail('"<" inside a tag', pos);
        if (end === -1) break;
        this.openTag(buf.slice(pos + 1, end), pos);
        end += 1;
      }
      this.advance(buf, pos, end);
      pos = end;
    }
    if (pos < len && len - pos > this.maxTokenLength) this.fail('token exceeds the maximum token length', pos);
    if (pos > 0) {
      this.buf = buf.slice(pos);
    }
  }

  /** Track line and column of consumed input, for error messages. */
  private advance(buf: string, from: number, to: number): void {
    let nl = buf.indexOf('\n', from);
    if (nl === -1 || nl >= to) {
      this.column += to - from;
      return;
    }
    let last = nl;
    while (nl !== -1 && nl < to) {
      this.line += 1;
      last = nl;
      nl = buf.indexOf('\n', nl + 1);
    }
    this.column = to - last;
  }

  private emitText(raw: string): void {
    if (raw.length === 0) return;
    this.advance(raw, 0, raw.length);
    if (this.stack.length === 0) {
      if (raw.trim().length > 0) this.fail('text outside the root element');
      return;
    }
    this.handler.text(raw.includes('&') ? decodeEntities(raw) : raw);
  }

  private emitRaw(raw: string): void {
    if (this.stack.length === 0) this.fail('CDATA outside the root element');
    if (raw.length > 0) this.handler.text(raw);
  }

  private openTag(body: string, offset: number): void {
    let selfClosing = false;
    if (body.endsWith('/')) {
      selfClosing = true;
      body = body.slice(0, -1);
    }
    const match = /^[^\s/>]+/.exec(body);
    if (!match) this.fail('element without a name', offset);
    const qname = match[0];
    if (this.rootClosed) this.fail(`content after the root element: <${qname}>`, offset);
    if (this.stack.length >= this.maxDepth) this.fail(`elements nested deeper than ${this.maxDepth}`, offset);
    const attrs = parseAttributes(body.slice(qname.length), this);

    const scope = new Map<string, string>();
    for (const [name, value] of Object.entries(attrs)) {
      if (name === 'xmlns') scope.set('', value);
      else if (name.startsWith('xmlns:')) scope.set(name.slice(6), value);
    }
    this.nsStack.push(scope);
    const element = this.makeElement(qname, attrs);
    this.sawRoot = true;
    this.stack.push(element);
    this.handler.open(element, selfClosing);
    if (selfClosing) this.pop(element);
  }

  private closeTag(qname: string, offset: number): void {
    const top = this.stack[this.stack.length - 1];
    if (!top) this.fail(`unexpected closing tag </${qname}>`, offset);
    if (top.qname !== qname) this.fail(`mismatched closing tag: expected </${top.qname}>, found </${qname}>`, offset);
    this.pop(top);
  }

  private pop(element: XmlElement): void {
    this.stack.pop();
    this.handler.close(element);
    this.nsStack.pop();
    if (this.stack.length === 0) this.rootClosed = true;
  }

  private makeElement(qname: string, attrs: Record<string, string>): XmlElement {
    const colon = qname.indexOf(':');
    const prefix = colon === -1 ? '' : qname.slice(0, colon);
    const local = colon === -1 ? qname : qname.slice(colon + 1);
    const ns = this.resolve(prefix);
    return { qname, local, prefix, ns: ns ?? '', undeclaredPrefix: ns === undefined && prefix !== '', attrs };
  }

  private resolve(prefix: string): string | undefined {
    for (let i = this.nsStack.length - 1; i >= 0; i--) {
      const uri = this.nsStack[i]!.get(prefix);
      if (uri !== undefined) return uri;
    }
    return prefix === '' ? '' : undefined;
  }

  /** @internal Line and column point at the start of the token being processed. */
  fail(message: string, _offset?: number): never {
    throw new ParseError(message, { line: this.line, column: this.column });
  }
}

/** Index of the `>` that ends the tag starting at `from`, skipping quoted attribute values. */
function findTagEnd(buf: string, from: number): number {
  let quote = 0;
  for (let i = from; i < buf.length; i++) {
    const c = buf.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return i;
    } else if (c === 60) {
      return -2;
    }
  }
  return -1;
}

function findDoctypeEnd(buf: string, from: number): number {
  let depth = 0;
  let quote = 0;
  for (let i = from + 2; i < buf.length; i++) {
    const c = buf.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) quote = c;
    else if (c === 91) depth++;
    else if (c === 93) depth--;
    else if (c === 62 && depth <= 0) return i + 1;
  }
  return -1;
}

const ATTR_RE = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

function parseAttributes(source: string, tokenizer: Pick<XmlTokenizer, 'fail'>): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let index = 0;
  while (index < source.length) {
    if (/^\s*$/.test(source.slice(index))) break;
    ATTR_RE.lastIndex = index;
    const m = ATTR_RE.exec(source);
    if (!m) tokenizer.fail(`malformed attribute near "${source.slice(index, index + 30).trim()}"`);
    const value = m[2] ?? m[3] ?? '';
    if (Object.prototype.hasOwnProperty.call(attrs, m[1]!)) tokenizer.fail(`duplicate attribute ${m[1]}`);
    attrs[m[1]!] = value.includes('&') ? decodeEntities(value) : value;
    index = ATTR_RE.lastIndex;
  }
  return attrs;
}
