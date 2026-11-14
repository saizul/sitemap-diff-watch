import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isoWeekLabel, parseW3cDatetime, rfc822ToIso, utcWeekStart } from '../src/util/w3c-datetime.js';

describe('parseW3cDatetime', () => {
  // The six forms of https://www.w3.org/TR/NOTE-datetime
  const valid: Array<[string, string, string]> = [
    ['1997', '1997-01-01T00:00:00.000Z', 'year'],
    ['1997-07', '1997-07-01T00:00:00.000Z', 'month'],
    ['1997-07-16', '1997-07-16T00:00:00.000Z', 'day'],
    ['1997-07-16T19:20+01:00', '1997-07-16T18:20:00.000Z', 'minute'],
    ['1997-07-16T19:20:30+01:00', '1997-07-16T18:20:30.000Z', 'second'],
    ['1997-07-16T19:20:30.45+01:00', '1997-07-16T18:20:30.450Z', 'second'],
    ['2026-11-14T10:00:00Z', '2026-11-14T10:00:00.000Z', 'second'],
    ['2026-11-14T10:00:00-05:30', '2026-11-14T15:30:00.000Z', 'second'],
    ['2024-02-29', '2024-02-29T00:00:00.000Z', 'day'],
  ];
  for (const [input, iso, precision] of valid) {
    it(`accepts ${input}`, () => {
      const r = parseW3cDatetime(input);
      assert.ok(r.valid, input);
      assert.equal(r.iso, iso);
      assert.equal(r.precision, precision);
    });
  }

  const invalid: Array<[string, RegExp]> = [
    ['2026-11-14 10:00:00', /"T", not a space/],
    ['2026-11-14T10:00:00', /time zone designator/],
    ['2026-11-14T10:00:00+0000', /\+hh:mm/],
    ['2026-13-01', /month 13/],
    ['2025-02-29', /day 29/],
    ['2026-11-14T24:00Z', /hour 24/],
    ['2026-11-14T10:60Z', /minute 60/],
    ['2026-11-14T10:00:61Z', /second 61/],
    ['14/11/2026', /YYYY-MM-DD/],
    ['Sat, 14 Nov 2026 10:00:00 GMT', /RFC 822/],
    ['1763114400', /Unix timestamps/],
    ['', /empty/],
    ['2026-11-14T10Z', /not in W3C/],
  ];
  for (const [input, reason] of invalid) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      const r = parseW3cDatetime(input);
      assert.equal(r.valid, false);
      if (!r.valid) assert.match(r.reason, reason);
    });
  }
});

describe('date helpers', () => {
  it('converts RFC 822 dates', () => {
    assert.equal(rfc822ToIso('Fri, 13 Nov 2026 09:30:00 GMT'), '2026-11-13T09:30:00.000Z');
    assert.equal(rfc822ToIso('garbage'), undefined);
  });
  it('finds the Monday of the ISO week', () => {
    assert.equal(utcWeekStart(Date.parse('2026-11-14T12:00:00Z')), '2026-11-09');
    assert.equal(utcWeekStart(Date.parse('2026-11-09T00:00:00Z')), '2026-11-09');
    assert.equal(utcWeekStart(Date.parse('2026-11-15T23:59:59Z')), '2026-11-09');
  });
  it('labels ISO weeks, including year boundaries', () => {
    assert.equal(isoWeekLabel(Date.parse('2026-11-14T00:00:00Z')), '2026-W46');
    assert.equal(isoWeekLabel(Date.parse('2027-01-01T00:00:00Z')), '2026-W53');
    assert.equal(isoWeekLabel(Date.parse('2024-12-30T00:00:00Z')), '2025-W01');
  });
});
