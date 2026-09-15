import type { ConsumptionBucket, Meter, Reading } from '@/types';
import { clamp, hashString, mulberry32, roundTo } from '@/utils/random';

/**
 * Synthesises the reading history behind every chart and table.
 *
 * Values are tuned to the figures visible in the reference recording for
 * MFM443TX: line-to-line voltage averaging ~405 V across a 368–444 V band,
 * current averaging ~32 A with peaks near 151 A, and power factor averaging
 * ~0.74. Each meter gets its own deterministic seed so its series are stable
 * but distinguishable.
 */

export const READINGS_PER_METER = 500;
/** Minutes between consecutive samples. 500 × 3 min ≈ 25 h of history. */
const SAMPLE_INTERVAL_MIN = 3;

/**
 * Relative load for each hour of the day, indexed 0–23. Mirrors the shape of
 * the "Hourly Energy Consumption" bars in the reference: a broad daytime
 * plateau, an evening step down, and a deep overnight trough.
 */
const HOUR_LOAD = [
  0.24, 0.2, 0.22, 0.18, 0.12, 0.08, 0.06, 0.07, 0.34, 0.52, 0.66, 0.72, 1.0, 0.98, 0.96, 0.97,
  0.88, 0.7, 0.36, 0.34, 0.33, 0.35, 0.32, 0.28,
];

function loadFactor(date: Date, jitter: number): number {
  const hour = date.getHours();
  const next = HOUR_LOAD[(hour + 1) % 24];
  const base = HOUR_LOAD[hour];
  // Blend into the next hour so the curve does not step at hour boundaries.
  const blend = base + (next - base) * (date.getMinutes() / 60);
  return clamp(blend * (0.88 + jitter * 0.24), 0.03, 1.15);
}

export function generateReadings(meter: Meter): Reading[] {
  const rand = mulberry32(hashString(meter.id));
  const end = new Date(meter.lastReadingAt).getTime();
  const rows: Reading[] = [];

  // Walk backwards from the latest reading so cumulative energy decreases
  // into the past, exactly as the reference Meter Data Logs table shows.
  let kwh = meter.kwh;
  let kvah = meter.kvah;
  let kvarh = meter.kvarh;

  for (let i = 0; i < READINGS_PER_METER; i += 1) {
    const at = new Date(end - i * SAMPLE_INTERVAL_MIN * 60_000);
    const factor = loadFactor(at, rand());

    // Occasional events, so the demo actually exercises the threshold logic:
    // brief load surges push current toward its ceiling, and supply swells
    // push line voltage past the configured maximum.
    const surge = rand() > 0.965 ? 2.8 + rand() * 1.1 : 1;
    const swell = rand() > 0.975 ? 1.085 : 1;

    // Line-to-neutral voltages hover around 230 V and sag slightly under load.
    const sag = (factor - 0.5) * 9;
    const vrn = roundTo((229.8 - sag + (rand() - 0.5) * 4.2) * swell, 2);
    const vyn = roundTo((224.1 - sag + (rand() - 0.5) * 4.2) * swell, 2);
    const vbn = roundTo((229.4 - sag + (rand() - 0.5) * 4.2) * swell, 2);

    // Line-to-line ≈ √3 × line-to-neutral, with a little per-pair imbalance.
    const vry = roundTo(clamp(vrn * 1.7062 + (rand() - 0.5) * 9, 368.5, 443.7), 2);
    const vyb = roundTo(clamp(vyn * 1.7386 + (rand() - 0.5) * 9, 368.5, 443.7), 2);
    const vbr = roundTo(clamp(vbn * 1.7248 + (rand() - 0.5) * 9, 368.5, 443.7), 2);

    // Currents scale with load; phase B runs lighter than R and Y.
    const ir = roundTo(clamp(38 * factor * surge + (rand() - 0.5) * 9, 0, 151.45), 2);
    const iy = roundTo(clamp(44 * factor * surge + (rand() - 0.5) * 9, 0, 151.45), 2);
    const ib = roundTo(clamp(19 * factor * surge + (rand() - 0.5) * 7, 0, 151.45), 2);

    const pfR = roundTo(clamp(0.82 + (rand() - 0.45) * 0.5, 0, 1.97), 3);
    const pfY = roundTo(clamp(0.74 + (rand() - 0.45) * 0.5, 0, 1.97), 3);
    const pfB = roundTo(clamp(0.68 + (rand() - 0.45) * 0.55, 0, 1.97), 3);

    const kwR = roundTo((vrn * ir * pfR) / 1000, 2);
    const kwY = roundTo((vyn * iy * pfY) / 1000, 2);
    const kwB = roundTo((vbn * ib * pfB) / 1000, 2);

    rows.push({
      id: `${meter.id}-r${String(i).padStart(4, '0')}`,
      meterId: meter.id,
      deviceId: meter.deviceId,
      timestamp: at.toISOString(),
      kwh: roundTo(kwh, 2),
      kvah: roundTo(kvah, 2),
      kvarh: roundTo(kvarh, 2),
      vrn,
      vyn,
      vbn,
      vry,
      vyb,
      vbr,
      ir,
      iy,
      ib,
      kwR,
      kwY,
      kwB,
      pfR,
      pfY,
      pfB,
      frequency: roundTo(50 + (rand() - 0.5) * 0.42, 2),
    });

    // Energy consumed during this interval, subtracted as we step back in time.
    const intervalKwh = ((kwR + kwY + kwB) * SAMPLE_INTERVAL_MIN) / 60;
    kwh -= intervalKwh;
    kvah -= intervalKwh * 1.062;
    kvarh -= intervalKwh * 0.284;
  }

  return rows;
}

/** Newest-first is the order the logs table and charts expect. */
export function sortByTimeDesc(rows: Reading[]): Reading[] {
  return [...rows].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

export interface SeriesStats {
  maximum: number;
  minimum: number;
  average: number;
}

export function statsFor(rows: Reading[], pick: (r: Reading) => number): SeriesStats {
  return statsForPhases(rows, [pick]);
}

/**
 * Min/max/average across several accessors at once.
 *
 * The reference's Statistical Summary reports the extremes of the individual
 * phases (voltage max 443.67 V, current max 151.45 A), not of the three-phase
 * average — averaging first collapses the spread and understates both ends.
 */
export function statsForPhases(
  rows: Reading[],
  picks: Array<(r: Reading) => number>,
): SeriesStats {
  if (rows.length === 0 || picks.length === 0) {
    return { maximum: 0, minimum: 0, average: 0 };
  }
  let max = -Infinity;
  let min = Infinity;
  let sum = 0;
  let count = 0;
  for (const row of rows) {
    for (const pick of picks) {
      const v = pick(row);
      if (v > max) max = v;
      if (v < min) min = v;
      sum += v;
      count += 1;
    }
  }
  return {
    maximum: roundTo(max, 2),
    minimum: roundTo(min, 2),
    average: roundTo(sum / count, 2),
  };
}

/** Average of the three phases for a reading, used by the overview gauges. */
export const avgVoltageLL = (r: Reading) => (r.vry + r.vyb + r.vbr) / 3;
export const avgCurrent = (r: Reading) => (r.ir + r.iy + r.ib) / 3;
export const avgPowerFactor = (r: Reading) => (r.pfR + r.pfY + r.pfB) / 3;
export const totalPower = (r: Reading) => r.kwR + r.kwY + r.kwB;

/**
 * Buckets readings into the last 24 hourly slots, producing both the energy
 * (green bars) and average-current (blue bars) series.
 */
export function hourlyBuckets(rows: Reading[]): ConsumptionBucket[] {
  if (rows.length === 0) return [];
  const sorted = sortByTimeDesc(rows);
  const latest = new Date(sorted[0].timestamp);
  const buckets: ConsumptionBucket[] = [];

  for (let back = 23; back >= 0; back -= 1) {
    const slot = new Date(latest);
    slot.setMinutes(0, 0, 0);
    slot.setHours(slot.getHours() - back);
    const slotEnd = new Date(slot.getTime() + 3_600_000);

    const inSlot = rows.filter((r) => {
      const t = Date.parse(r.timestamp);
      return t >= slot.getTime() && t < slotEnd.getTime();
    });

    const kwh = inSlot.reduce(
      (sum, r) => sum + (totalPower(r) * SAMPLE_INTERVAL_MIN) / 60,
      0,
    );
    const current =
      inSlot.length > 0 ? inSlot.reduce((sum, r) => sum + avgCurrent(r), 0) / inSlot.length : 0;

    buckets.push({
      label: slot.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }),
      at: slot.toISOString(),
      kwh: roundTo(kwh, 2),
      avgCurrent: roundTo(current, 2),
    });
  }

  return buckets;
}

/**
 * Daily consumption for the last `days` days. The reading history only spans
 * ~25 h, so earlier days are extrapolated from the same seeded profile to keep
 * the 7-day and 30-day views populated.
 */
export function dailyBuckets(meter: Meter, rows: Reading[], days = 7): ConsumptionBucket[] {
  const dayTotal = rows.reduce((sum, r) => sum + (totalPower(r) * SAMPLE_INTERVAL_MIN) / 60, 0);
  const base = dayTotal > 0 ? dayTotal / 1.04 : 120;
  const latest = new Date(rows[0]?.timestamp ?? meter.lastReadingAt);
  const out: ConsumptionBucket[] = [];

  for (let back = days - 1; back >= 0; back -= 1) {
    const day = new Date(latest);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - back);

    // Seed from the calendar date, not the loop index, so a given day yields
    // the same figure regardless of how wide a window asked for it. Seeding
    // from the index made "last 7 days" and the preceding 7 days identical,
    // which pinned the period-over-period comparison at 0%.
    const daySeed = hashString(`${meter.id}-${day.toISOString().slice(0, 10)}`);
    const jitter = mulberry32(daySeed)();

    // Weekends run lighter, matching a typical industrial duty cycle.
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const factor = (weekend ? 0.52 : 1) * (0.86 + jitter * 0.3);

    out.push({
      label: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      at: day.toISOString(),
      kwh: roundTo(base * factor, 2),
      avgCurrent: roundTo(32 * factor, 2),
    });
  }

  return out;
}
