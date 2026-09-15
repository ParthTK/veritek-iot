import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bucketEnd,
  bucketStart,
  offsetMinutesAt,
  parseOffsetMinutes,
  parseTimestamp,
  toSiteIso,
  zonedToUtc,
} from '../src/core/time.js';

const IST = 'Asia/Kolkata';

test('ISO timestamps with an offset are taken at face value', () => {
  const parsed = parseTimestamp('2026-09-14T10:30:00+05:30');
  assert.ok(parsed);
  assert.equal(parsed.date.toISOString(), '2026-09-14T05:00:00.000Z');
  assert.equal(parsed.hadOffset, true);
});

test('a naive timestamp is read in the configured device timezone', () => {
  // The gateway has an RTC but may not stamp a zone - so the assumption is
  // explicit and recorded, never silently UTC (spec section 10).
  const parsed = parseTimestamp('2026-09-14 10:30:00', 'auto', 330);
  assert.ok(parsed);
  assert.equal(parsed.date.toISOString(), '2026-09-14T05:00:00.000Z');
  assert.equal(parsed.hadOffset, false);
  assert.equal(parsed.assumedOffsetMinutes, 330);
});

test('epoch seconds and milliseconds are both understood', () => {
  const seconds = parseTimestamp(1789000000);
  const millis = parseTimestamp(1789000000000);
  assert.ok(seconds && millis);
  assert.equal(seconds.date.toISOString(), millis.date.toISOString());
  assert.equal(seconds.format, 'epoch_s');
  assert.equal(millis.format, 'epoch_ms');
});

test('a 14-digit stamp is a date, not an epoch', () => {
  const parsed = parseTimestamp('20260914103000', 'auto', 0);
  assert.ok(parsed);
  assert.equal(parsed.date.toISOString(), '2026-09-14T10:30:00.000Z');
  assert.equal(parsed.format, 'yyyymmddhhmmss');
});

test('unparseable timestamps return null rather than throwing', () => {
  assert.equal(parseTimestamp('not a time'), null);
  assert.equal(parseTimestamp(null), null);
  assert.equal(parseTimestamp({}), null);
});

test('offset strings in several shapes resolve to minutes', () => {
  assert.equal(parseOffsetMinutes('+05:30'), 330);
  assert.equal(parseOffsetMinutes('+0530'), 330);
  assert.equal(parseOffsetMinutes('-08:00'), -480);
  assert.equal(parseOffsetMinutes(5.5), 330);
  assert.equal(parseOffsetMinutes(330), 330);
  assert.equal(parseOffsetMinutes('UTC'), 0);
  assert.equal(parseOffsetMinutes('rubbish'), null);
});

test('sub-daily buckets are plain UTC arithmetic', () => {
  const at = '2026-09-14T10:37:42.500Z';
  assert.equal(bucketStart(at, '1m').toISOString(), '2026-09-14T10:37:00.000Z');
  assert.equal(bucketStart(at, '5m').toISOString(), '2026-09-14T10:35:00.000Z');
  assert.equal(bucketStart(at, '15m').toISOString(), '2026-09-14T10:30:00.000Z');
  assert.equal(bucketStart(at, '1h').toISOString(), '2026-09-14T10:00:00.000Z');
});

test('daily buckets follow the site calendar, not UTC', () => {
  // 20:00 UTC is already the next day in IST (01:30), so a daily bucket keyed
  // on UTC would put this reading in the wrong day's kWh total.
  const start = bucketStart('2026-09-14T20:00:00Z', '1d', IST);
  assert.equal(start.toISOString(), '2026-09-14T18:30:00.000Z', 'IST midnight on the 15th');

  const end = bucketEnd('2026-09-14T20:00:00Z', '1d', IST);
  assert.equal(end.toISOString(), '2026-09-15T18:30:00.000Z');
  assert.equal(end.getTime() - start.getTime(), 86_400_000);
});

test('monthly buckets align to the local first of the month', () => {
  const start = bucketStart('2026-09-14T10:00:00Z', '1mo', IST);
  assert.equal(start.toISOString(), '2026-08-31T18:30:00.000Z', 'IST midnight on 1 September');
  assert.equal(bucketEnd('2026-09-14T10:00:00Z', '1mo', IST).toISOString(), '2026-09-30T18:30:00.000Z');
});

test('monthly buckets roll over the year correctly', () => {
  assert.equal(bucketEnd('2026-12-20T10:00:00Z', '1mo', IST).toISOString(), '2026-12-31T18:30:00.000Z');
});

test('timezone conversions round-trip', () => {
  assert.equal(offsetMinutesAt(new Date('2026-09-14T10:00:00Z'), IST), 330);
  const utc = zonedToUtc({ year: 2026, month: 9, day: 14, hour: 0, minute: 0, second: 0 }, IST);
  assert.equal(utc.toISOString(), '2026-09-13T18:30:00.000Z');
  assert.equal(toSiteIso('2026-09-14T05:00:00Z', IST), '2026-09-14T10:30:00+05:30');
});

test('daylight saving is handled where sites have it', () => {
  const summer = offsetMinutesAt(new Date('2026-07-01T12:00:00Z'), 'Europe/London');
  const winter = offsetMinutesAt(new Date('2026-01-01T12:00:00Z'), 'Europe/London');
  assert.equal(summer, 60);
  assert.equal(winter, 0);
});
