import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_COUNTER_OPTIONS,
  computeCounterDelta,
  consumptionOverSeries,
  detectGap,
  detectRollover,
} from '../src/iot/telemetry/energy.js';

const at = (minutes: number): string => new Date(Date.UTC(2026, 8, 14, 10, minutes, 0)).toISOString();

test('the first reading is a baseline, not consumption', () => {
  const result = computeCounterDelta(null, { value: 14582.3, time: at(0) });
  assert.equal(result.delta, 0);
  assert.equal(result.quality, 'GOOD');
  assert.equal(result.event, null);
});

test('consumption is the difference between readings', () => {
  const result = computeCounterDelta(
    { value: 14582.3, time: at(0) },
    { value: 14584.8, time: at(60) },
  );
  assert.ok(Math.abs(result.delta - 2.5) < 1e-9);
  assert.equal(result.event, null);
});

test('a register wrap is credited, not read as a reset', () => {
  const result = computeCounterDelta(
    { value: 999998.0, time: at(0) },
    { value: 3.5, time: at(60) },
    { ...DEFAULT_COUNTER_OPTIONS, rolloverCeilings: [999999.9] },
  );
  assert.equal(result.event, 'ROLLOVER');
  // (999999.9 - 999998.0) + 3.5
  assert.ok(Math.abs(result.delta - 5.4) < 1e-6);
});

test('a meter reset credits nothing and is flagged', () => {
  const result = computeCounterDelta(
    { value: 48000, time: at(0) },
    { value: 12, time: at(60) },
  );
  assert.equal(result.event, 'RESET');
  assert.equal(result.delta, 0, 'a reset must not be credited as 12 kWh of use');
  assert.equal(result.quality, 'SUSPECT');
  assert.ok(result.note?.includes('backwards'));
});

test('a small backward step is float noise, not an event', () => {
  const result = computeCounterDelta(
    { value: 100.0005, time: at(0) },
    { value: 100.0, time: at(1) },
  );
  assert.equal(result.delta, 0);
  assert.equal(result.event, null);
  assert.equal(result.quality, 'GOOD');
});

test('an implausible jump is flagged but still recorded', () => {
  const result = computeCounterDelta(
    { value: 100, time: at(0) },
    { value: 500_000, time: at(1) },
    { ...DEFAULT_COUNTER_OPTIONS, maxDeltaPerHour: 1000 },
  );
  assert.equal(result.event, 'SPIKE');
  assert.equal(result.quality, 'SUSPECT');
  // Flagged, not discarded: losing a real event is worse than carrying a
  // suspect one (spec section 13).
  assert.ok(result.delta > 0);
});

test('rollover detection needs both a near-ceiling and a near-zero reading', () => {
  assert.equal(detectRollover(999_998, 3, [999_999.9]), 999_999.9);
  // A reset from mid-range is not a wrap.
  assert.equal(detectRollover(500_000, 3, [999_999.9]), null);
  // Nor is a small decrease near the ceiling.
  assert.equal(detectRollover(999_998, 900_000, [999_999.9]), null);
});

test('consumption over a series sums the steps, not the readings', () => {
  const series = [
    { value: 1000, time: at(0) },
    { value: 1002, time: at(15) },
    { value: 1005, time: at(30) },
    { value: 1009, time: at(45) },
  ];
  const result = consumptionOverSeries(series);
  assert.equal(result.total, 9);
  // The mistake this guards against: 1000+1002+1005+1009 = 4016.
  assert.notEqual(result.total, 4016);
  assert.equal(result.quality, 'GOOD');
});

test('a reset inside a series is isolated to that step', () => {
  const series = [
    { value: 1000, time: at(0) },
    { value: 1005, time: at(15) },
    { value: 2, time: at(30) },    // meter replaced
    { value: 7, time: at(45) },
  ];
  const result = consumptionOverSeries(series);
  assert.equal(result.total, 10, 'the 5 before and the 5 after count; the reset itself does not');
  assert.equal(result.quality, 'SUSPECT');
  assert.ok(result.events.includes('RESET'));
});

test('gaps are detected against the expected poll interval', () => {
  const previous = { value: 1, time: at(0) };
  assert.equal(detectGap(previous, { value: 2, time: at(1) }, 60), false);
  assert.equal(detectGap(previous, { value: 2, time: at(10) }, 60), true);
  assert.equal(detectGap(null, { value: 2, time: at(10) }, 60), false);
});
