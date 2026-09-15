import { env } from '../../config/env.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import { bucketEnd } from '../../core/time.js';
import type { BucketInterval } from '../../core/time.js';
import { getMeter } from '../../db/repositories/meters.js';
import { loadMetricDefinitions } from '../../db/repositories/metrics.js';
import type { DirtyBucket, RollupUpsert } from '../../db/repositories/rollups.js';
import { claimDirty, clearDirty, countDirty, upsertRollups } from '../../db/repositories/rollups.js';
import { siteTimezone } from '../../db/repositories/sites.js';
import { samplesInWindow, valueAtOrBefore } from '../../db/repositories/telemetry.js';
import type { Quality } from '../adapters/types.js';
import { DEFAULT_COUNTER_OPTIONS, consumptionOverSeries } from './energy.js';
import { worseQuality } from './quality.js';

const log = createLogger('telemetry:aggregation');

/**
 * Rollup maintenance (spec section 12).
 *
 * Buckets are recomputed from raw telemetry rather than accumulated forward.
 * That costs a little more work per bucket and buys the one property that
 * matters here: when the gateway replays an hour of buffered readings, the
 * affected buckets are simply marked dirty and rebuilt, and history comes out
 * correct instead of double-counted.
 */

const counterOptions = {
  rolloverCeilings: env.ENERGY_COUNTER_ROLLOVER_VALUES.map(Number).filter(Number.isFinite),
  maxDeltaPerHour: env.ENERGY_MAX_DELTA_PER_HOUR,
  backwardTolerance: Number(env.ENERGY_BACKWARD_TOLERANCE) || DEFAULT_COUNTER_OPTIONS.backwardTolerance,
};

export async function rebuildBucket(dirty: DirtyBucket): Promise<RollupUpsert[]> {
  const meter = await getMeter(dirty.meterId);
  if (!meter) return [];

  const timezone = await siteTimezone(meter.siteId);
  const end = bucketEnd(dirty.bucketStart, dirty.bucket, timezone).toISOString();
  const samples = await samplesInWindow(dirty.meterId, dirty.bucketStart, end);
  if (samples.length === 0) return [];

  const definitions = await loadMetricDefinitions();
  const byMetric = new Map<string, typeof samples>();
  for (const sample of samples) {
    const list = byMetric.get(sample.metric);
    if (list) list.push(sample);
    else byMetric.set(sample.metric, [sample]);
  }

  const rows: RollupUpsert[] = [];

  for (const [metric, values] of byMetric) {
    const ordered = [...values].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    if (!first || !last) continue;

    const numbers = ordered.map((sample) => sample.value);
    const sum = numbers.reduce((total, value) => total + value, 0);
    let quality: Quality = 'GOOD';
    for (const sample of ordered) quality = worseQuality(quality, sample.quality);

    const definition = definitions.get(metric);
    let delta: number | null = null;

    if (definition?.kind === 'cumulative') {
      // Consumption inside the bucket has to start from the last reading
      // *before* the boundary, otherwise every bucket silently loses the
      // energy used between its first sample and the bucket start.
      const opening = await valueAtOrBefore(
        dirty.meterId,
        metric,
        new Date(Date.parse(dirty.bucketStart) - 1).toISOString(),
      );
      const series = opening
        ? [{ value: opening.value, time: opening.time }, ...ordered.map((s) => ({ value: s.value, time: s.time }))]
        : ordered.map((s) => ({ value: s.value, time: s.time }));

      const consumption = consumptionOverSeries(series, counterOptions);
      delta = consumption.total;
      quality = worseQuality(quality, consumption.quality);
    }

    rows.push({
      bucket: dirty.bucket,
      meterId: dirty.meterId,
      metric,
      bucketStart: dirty.bucketStart,
      bucketEnd: end,
      siteId: meter.siteId,
      gatewayId: meter.gatewayId,
      sampleCount: ordered.length,
      sum,
      avg: sum / ordered.length,
      min: Math.min(...numbers),
      max: Math.max(...numbers),
      first: first.value,
      last: last.value,
      firstTime: first.time,
      lastTime: last.time,
      delta,
      unit: last.unit,
      quality,
    });
  }

  return rows;
}

/** Process one batch of dirty buckets. Returns how many were rebuilt. */
export async function runAggregationPass(batchSize = env.AGGREGATION_BATCH): Promise<number> {
  const dirty = await claimDirty(batchSize);
  if (dirty.length === 0) return 0;

  const rows: RollupUpsert[] = [];
  for (const bucket of dirty) {
    try {
      rows.push(...(await rebuildBucket(bucket)));
    } catch (error) {
      log.error('failed to rebuild a rollup bucket', { bucket, error });
    }
  }

  if (rows.length) await upsertRollups(rows);
  await clearDirty(dirty);

  log.debug('aggregation pass complete', {
    event: LogEvent.AGGREGATION_RUN,
    buckets: dirty.length,
    rows: rows.length,
    remaining: await countDirty(),
  });
  return dirty.length;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startAggregationScheduler(): void {
  if (!env.AGGREGATION_ENABLED || timer) return;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // Keep going while there is a backlog - a buffered replay can dirty
      // thousands of buckets at once and should not trickle out one tick at a time.
      let processed = 0;
      for (let pass = 0; pass < 20; pass += 1) {
        const done = await runAggregationPass();
        processed += done;
        if (done === 0) break;
      }
      if (processed > 0) log.info('rollups refreshed', { event: LogEvent.AGGREGATION_RUN, buckets: processed });
    } catch (error) {
      log.error('aggregation scheduler error', { error });
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => void tick(), env.AGGREGATION_INTERVAL_SECONDS * 1000);
  timer.unref?.();
  void tick();
  log.info('aggregation scheduler started', { everySeconds: env.AGGREGATION_INTERVAL_SECONDS });
}

export function stopAggregationScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Drain the entire dirty backlog. Used by tests and the e2e verifier. */
export async function flushAggregation(maxPasses = 200): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const done = await runAggregationPass();
    total += done;
    if (done === 0) break;
  }
  return total;
}

export const AGGREGATION_BUCKETS: BucketInterval[] = ['1m', '5m', '15m', '1h', '1d', '1mo'];
