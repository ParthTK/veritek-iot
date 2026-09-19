import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleFingerprint } from '../src/core/hash.js';
import type { ProfileSpec } from '../src/db/repositories/profiles.js';
import { flattenPaths, getByPathLoose, topicMatches } from '../src/iot/adapters/jsonPath.js';
import { parseWithProfile } from '../src/iot/adapters/profileParser.js';

/**
 * The adapter has to cope with a payload shape nobody has seen yet, so these
 * tests deliberately use several *different* invented shapes. None of them
 * claims to be the vendor's format.
 */

const options = { defaultOffsetMinutes: 330 };

test('a flat keyed payload maps through the profile', () => {
  const spec: ProfileSpec = {
    gatewayIdPaths: ['gateway_id'],
    slaveIdPaths: ['slave_id'],
    timestampPaths: ['timestamp'],
    measurementPaths: ['registers'],
  };
  const { packets } = parseWithProfile(
    {
      gateway_id: 'GW001',
      slave_id: 3,
      timestamp: '2026-09-14T10:30:00+05:30',
      registers: { voltage_l1: 231.6, current_l1: 13.2 },
    },
    spec,
    options,
  );

  assert.equal(packets.length, 1);
  const packet = packets[0]!;
  assert.equal(packet.gatewayUid, 'GW001');
  assert.equal(packet.slaveId, 3);
  assert.equal(packet.sourceTimestamp, '2026-09-14T05:00:00.000Z');
  assert.equal(packet.values.voltage_l1, 231.6);
});

test('a different vendor shape needs only a different profile', () => {
  // Nested envelope, vendor key names, epoch seconds, an array of slaves.
  const spec: ProfileSpec = {
    gatewayIdPaths: ['header.dev'],
    slaveIdPaths: ['addr'],
    timestampPaths: ['header.ts'],
    batchPaths: ['body.readings'],
    measurementPaths: ['vals'],
    keyMap: { u1: 'voltage_l1', i1: 'current_l1', p: 'active_power_kw' },
  };
  const { packets } = parseWithProfile(
    {
      header: { dev: 'IMEI-864000000000000', ts: 1789000000 },
      body: {
        readings: [
          { addr: 1, vals: { u1: 230.1, i1: 10.2, p: 2.3 } },
          { addr: 2, vals: { u1: 229.4, i1: 8.8, p: 1.9 } },
        ],
      },
    },
    spec,
    options,
  );

  assert.equal(packets.length, 2, 'one packet per Modbus slave');
  assert.equal(packets[0]!.gatewayUid, 'IMEI-864000000000000', 'envelope fields reach every sample');
  assert.equal(packets[0]!.slaveId, 1);
  assert.equal(packets[0]!.values.voltage_l1, 230.1, 'vendor key u1 mapped to our metric');
  assert.equal(packets[1]!.values.active_power_kw, 1.9);
});

test('a buffered batch becomes one packet per measurement time', () => {
  // The offline-buffer flush: several readings in one transmission, each with
  // its own timestamp (spec section 21).
  const spec: ProfileSpec = {
    gatewayIdPaths: ['gw'],
    batchPaths: ['samples'],
    timestampPaths: ['t'],
    slaveIdPaths: ['sid'],
    measurementPaths: ['m'],
  };
  const { packets } = parseWithProfile(
    {
      gw: 'GW001',
      samples: [
        { t: '2026-09-14T12:01:00+05:30', sid: 1, m: { voltage_l1: 230 } },
        { t: '2026-09-14T12:02:00+05:30', sid: 1, m: { voltage_l1: 231 } },
        { t: '2026-09-14T12:03:00+05:30', sid: 1, m: { voltage_l1: 232 } },
      ],
    },
    spec,
    options,
  );

  assert.equal(packets.length, 3);
  const times = packets.map((packet) => packet.sourceTimestamp);
  assert.deepEqual(times, [
    '2026-09-14T06:31:00.000Z',
    '2026-09-14T06:32:00.000Z',
    '2026-09-14T06:33:00.000Z',
  ], 'three distinct measurement times, not three copies of the arrival time');
});

test('name/value arrays are accepted as well as objects', () => {
  const { packets } = parseWithProfile(
    {
      gateway_id: 'GW001',
      data: [
        { name: 'voltage_l1', value: 230.5 },
        { name: 'frequency_hz', value: 50.01 },
      ],
    },
    { gatewayIdPaths: ['gateway_id'], measurementPaths: ['data'] },
    options,
  );
  assert.equal(packets[0]!.values.voltage_l1, 230.5);
  assert.equal(packets[0]!.values.frequency_hz, 50.01);
});

test('raw register blocks and address/value pairs survive parsing', () => {
  const { packets } = parseWithProfile(
    {
      gateway_id: 'GW001',
      blocks: [{ start: 40001, fc: 3, words: [0x4367, 0x999a] }],
      regs: { '40010': 1234, '40011': 5678 },
    },
    {
      gatewayIdPaths: ['gateway_id'],
      registerBlockPaths: ['blocks'],
      registerArrayPaths: ['regs'],
    },
    options,
  );

  const packet = packets[0]!;
  assert.equal(packet.registerBlocks.length, 1);
  assert.equal(packet.registerBlocks[0]!.startAddress, 40001);
  assert.deepEqual(packet.registerBlocks[0]!.words, [0x4367, 0x999a]);
  assert.equal(packet.registerValues.length, 2);
  assert.deepEqual(packet.registerValues[0], { address: 40010, value: 1234 });
});

test('key lookup ignores case and separators', () => {
  const source = { Gateway_ID: 'GW001', nested: { SlaveId: 7 } };
  assert.equal(getByPathLoose(source, 'gateway_id'), 'GW001');
  assert.equal(getByPathLoose(source, 'nested.slave_id'), 7);
  assert.equal(getByPathLoose(source, 'missing'), undefined);
});

test('MQTT wildcards match as the spec defines', () => {
  assert.equal(topicMatches('veritek/#', 'veritek/GW1/telemetry'), true);
  assert.equal(topicMatches('veritek/+/telemetry', 'veritek/GW1/telemetry'), true);
  assert.equal(topicMatches('veritek/+/telemetry', 'veritek/GW1/status'), false);
  assert.equal(topicMatches('veritek/+/telemetry', 'other/GW1/telemetry'), false);
  assert.equal(topicMatches('a/b', 'a/b/c'), false);
});

test('every leaf path is recorded for commissioning', () => {
  const paths = flattenPaths({ a: 1, b: { c: 'x' }, d: [{ e: true }] });
  const names = paths.map((path) => path.path);
  assert.ok(names.includes('a'));
  assert.ok(names.includes('b.c'));
  assert.ok(names.includes('d[0].e'));
});

test('fingerprints are stable across key order and unstable across values', () => {
  const base = {
    gatewayUid: 'GW001',
    slaveId: 1,
    sourceTimestamp: '2026-09-14T05:00:00.000Z',
    measurements: { voltage_l1: 231.6, current_l1: 13.2 },
  };
  const reordered = { ...base, measurements: { current_l1: 13.2, voltage_l1: 231.6 } };
  const changed = { ...base, measurements: { voltage_l1: 231.7, current_l1: 13.2 } };
  const laterTime = { ...base, sourceTimestamp: '2026-09-14T05:01:00.000Z' };

  assert.equal(sampleFingerprint(base), sampleFingerprint(reordered), 'a replay must collapse onto the original');
  assert.notEqual(sampleFingerprint(base), sampleFingerprint(changed));
  assert.notEqual(sampleFingerprint(base), sampleFingerprint(laterTime));
});

test('an empty or alien payload yields no packets instead of throwing', () => {
  assert.doesNotThrow(() => parseWithProfile({}, {}, options));
  assert.doesNotThrow(() => parseWithProfile({ totally: { unexpected: [1, 2, 3] } }, {}, options));
  assert.doesNotThrow(() => parseWithProfile(null, {}, options));
});
