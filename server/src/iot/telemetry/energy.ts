import type { CounterEventType } from '../../db/repositories/energy.js';
import type { Quality } from '../adapters/types.js';

/**
 * Cumulative-counter arithmetic (spec section 13).
 *
 * An energy register is a running total. Consumption over a window is
 * `end - start`, never the sum of the readings. Three things break that
 * subtraction in the field, and all three have to be detected rather than
 * smoothed away:
 *
 *   rollover  the register hits its ceiling and wraps to zero
 *   reset     the meter is replaced or its totals are cleared
 *   spike     a corrupt read produces an impossible jump
 *
 * Nothing here silently rewrites a reading. The raw value is always stored as
 * it arrived; what changes is the `quality` flag and the counter event that
 * gets recorded alongside it.
 */

export interface CounterReading {
  value: number;
  /** Measurement time, not arrival time. */
  time: string;
}

export interface CounterOptions {
  /** Register ceilings to test for wrap-around, e.g. 999999.9 or 2^32 - 1. */
  rolloverCeilings: number[];
  /** Largest believable increase per hour, in the metric's own unit. */
  maxDeltaPerHour: number;
  /** Decreases smaller than this are float noise, not a real step backwards. */
  backwardTolerance: number;
}

export interface CounterDelta {
  /** Consumption to attribute to the interval. Never negative. */
  delta: number;
  quality: Quality;
  event: CounterEventType | null;
  note: string | null;
}

export const DEFAULT_COUNTER_OPTIONS: CounterOptions = {
  rolloverCeilings: [999999.9, 999999, 4294967295, 99999999],
  maxDeltaPerHour: 100000,
  backwardTolerance: 0.001,
};

/**
 * Consumption between two readings of the same cumulative register.
 *
 * @param previous the last reading we trust, or null for the first ever sample
 */
export function computeCounterDelta(
  previous: CounterReading | null,
  current: CounterReading,
  options: CounterOptions = DEFAULT_COUNTER_OPTIONS,
): CounterDelta {
  if (!previous) {
    // The first reading only establishes the baseline - attributing its whole
    // absolute value as consumption is the classic way to invent a giant spike.
    return { delta: 0, quality: 'GOOD', event: null, note: 'Baseline reading; no consumption attributed.' };
  }

  const diff = current.value - previous.value;
  const hours = Math.max(
    (Date.parse(current.time) - Date.parse(previous.time)) / 3_600_000,
    1 / 3600,
  );

  if (diff >= 0) {
    const ratePerHour = diff / hours;
    if (diff > 0 && ratePerHour > options.maxDeltaPerHour) {
      return {
        delta: diff,
        quality: 'SUSPECT',
        event: 'SPIKE',
        note:
          'Increase of ' + round(diff) + ' over ' + round(hours, 3) + ' h is ' +
          round(ratePerHour) + '/h, above the configured ceiling of ' + options.maxDeltaPerHour + '/h.',
      };
    }
    return { delta: diff, quality: 'GOOD', event: null, note: null };
  }

  /* The counter went backwards. */

  if (Math.abs(diff) <= options.backwardTolerance) {
    return { delta: 0, quality: 'GOOD', event: null, note: null };
  }

  const ceiling = detectRollover(previous.value, current.value, options.rolloverCeilings);
  if (ceiling !== null) {
    const wrapped = ceiling - previous.value + current.value;
    const ratePerHour = wrapped / hours;
    return {
      delta: wrapped,
      quality: ratePerHour > options.maxDeltaPerHour ? 'SUSPECT' : 'GOOD',
      event: 'ROLLOVER',
      note:
        'Register wrapped at ' + ceiling + ': ' + round(previous.value) + ' -> ' +
        round(current.value) + ', crediting ' + round(wrapped) + '.',
    };
  }

  // Not a wrap. Either the meter was reset/replaced, or the read was bad. We
  // credit nothing to the interval and flag it, because guessing here is how
  // phantom consumption ends up on a bill.
  return {
    delta: 0,
    quality: 'SUSPECT',
    event: current.value < previous.value * 0.5 ? 'RESET' : 'BACKWARD',
    note:
      'Counter moved backwards ' + round(previous.value) + ' -> ' + round(current.value) +
      ' with no matching rollover ceiling. No consumption attributed; verify the meter.',
  };
}

/**
 * Ceiling the register appears to have wrapped at, or null if this does not
 * look like a wrap.
 *
 * A genuine wrap has the previous reading close under a ceiling and the new one
 * close above zero. Requiring both keeps a meter reset from being credited as a
 * full register's worth of energy.
 */
export function detectRollover(
  previousValue: number,
  currentValue: number,
  ceilings: number[],
): number | null {
  for (const ceiling of [...ceilings].sort((a, b) => a - b)) {
    if (previousValue > ceiling) continue;
    const nearCeiling = previousValue >= ceiling * 0.9;
    const nearZero = currentValue <= ceiling * 0.1;
    if (nearCeiling && nearZero) return ceiling;
  }
  return null;
}

/** Did the meter stop reporting for long enough to leave a hole? */
export function detectGap(
  previous: CounterReading | null,
  current: CounterReading,
  expectedIntervalSeconds: number,
  toleranceFactor = 3,
): boolean {
  if (!previous || expectedIntervalSeconds <= 0) return false;
  const gapSeconds = (Date.parse(current.time) - Date.parse(previous.time)) / 1000;
  return gapSeconds > expectedIntervalSeconds * toleranceFactor;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Consumption across an ordered run of readings of one cumulative register.
 * Used by the history API and the rollup recompute.
 */
export function consumptionOverSeries(
  readings: CounterReading[],
  options: CounterOptions = DEFAULT_COUNTER_OPTIONS,
): { total: number; quality: Quality; events: CounterEventType[] } {
  let total = 0;
  let quality: Quality = 'GOOD';
  const events: CounterEventType[] = [];

  for (let index = 1; index < readings.length; index += 1) {
    const previous = readings[index - 1];
    const current = readings[index];
    if (!previous || !current) continue;

    const step = computeCounterDelta(previous, current, options);
    total += step.delta;
    if (step.event) events.push(step.event);
    if (step.quality === 'SUSPECT' && quality === 'GOOD') quality = 'SUSPECT';
  }
  return { total, quality, events };
}
