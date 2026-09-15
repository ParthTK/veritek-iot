import { badRequest } from '../../core/errors.js';
import { bucketEnd, bucketStart, isBucketInterval, toSiteIso } from '../../core/time.js';
import type { BucketInterval } from '../../core/time.js';
import { listMeters } from '../../db/repositories/meters.js';
import { loadMetricDefinitions } from '../../db/repositories/metrics.js';
import { listRollups } from '../../db/repositories/rollups.js';
import { siteTimezone } from '../../db/repositories/sites.js';
import { latestByMeter, listTelemetry, valueAtOrBefore } from '../../db/repositories/telemetry.js';
import type { Quality } from '../adapters/types.js';
import { DEFAULT_COUNTER_OPTIONS, consumptionOverSeries } from './energy.js';

/**
 * Read models for the dashboard APIs (spec section 14).
 *
 * The rule that keeps the dashboard fast: anything longer than a short live
 * window is answered from `telemetry_rollups`, never by scanning raw rows
 * (section 12). Raw is available explicitly, for diagnostics and export.
 */

export type HistoryInterval = 'raw' | BucketInterval;

export function parseInterval(value: string | undefined, fallback: HistoryInterval = '15m'): HistoryInterval {
  if (!value) return fallback;
  const normalised = value.trim().toLowerCase();
  if (normalised === 'raw' || normalised === 'none') return 'raw';

  const aliases: Record<string, BucketInterval> = {
    '1min': '1m', '1m': '1m', minute: '1m',
    '5min': '5m', '5m': '5m',
    '15min': '15m', '15m': '15m',
    '1hour': '1h', '1h': '1h', hour: '1h', hourly: '1h', '60m': '1h',
    '1day': '1d', '1d': '1d', day: '1d', daily: '1d', '24h': '1d',
    '1month': '1mo', '1mo': '1mo', month: '1mo', monthly: '1mo',
  };
  const mapped = aliases[normalised];
  if (mapped) return mapped;
  if (isBucketInterval(normalised)) return normalised;
  throw badRequest('Unsupported interval "' + value + '". Use raw, 1m, 5m, 15m, 1h, 1d or 1mo.');
}

export interface HistoryPoint {
  /** Bucket start (or sample time) in UTC. */
  t: string;
  /** The same instant rendered in the site's timezone, for display. */
  tLocal: string;
  values: Record<string, number>;
  /** Consumption within the bucket, for cumulative metrics only. */
  consumption?: Record<string, number>;
  quality?: Record<string, Quality>;
  /** True when any sample in the bucket arrived from the gateway's buffer. */
  buffered?: boolean;
  sampleCount?: number;
}

export interface HistoryResult {
  from: string;
  to: string;
  interval: HistoryInterval;
  timezone: string;
  meterIds: string[];
  metrics: string[];
  points: HistoryPoint[];
  /** True when the answer came from rollups rather than raw rows. */
  aggregated: boolean;
}

export interface HistoryRequest {
  meterIds: string[];
  siteId?: string | null;
  metrics?: string[];
  from: string;
  to: string;
  interval?: string;
  limit?: number;
}

export async function queryHistory(request: HistoryRequest): Promise<HistoryResult> {
  const interval = parseInterval(request.interval);
  const timezone = await siteTimezone(request.siteId ?? null);

  if (Date.parse(request.from) > Date.parse(request.to)) {
    throw badRequest('`from` must be earlier than `to`.');
  }
  if (request.meterIds.length === 0) {
    return {
      from: request.from, to: request.to, interval, timezone,
      meterIds: [], metrics: [], points: [], aggregated: interval !== 'raw',
    };
  }

  if (interval === 'raw') return rawHistory(request, timezone);
  return aggregatedHistory(request, interval, timezone);
}

async function rawHistory(request: HistoryRequest, timezone: string): Promise<HistoryResult> {
  const rows = await listTelemetry({
    meterIds: request.meterIds,
    metrics: request.metrics,
    from: request.from,
    to: request.to,
    limit: request.limit,
  });

  const byTime = new Map<string, HistoryPoint>();
  const metrics = new Set<string>();

  for (const row of rows) {
    metrics.add(row.metric);
    let point = byTime.get(row.time);
    if (!point) {
      point = { t: row.time, tLocal: toSiteIso(row.time, timezone), values: {}, quality: {}, buffered: false };
      byTime.set(row.time, point);
    }
    point.values[row.metric] = row.value;
    if (point.quality) point.quality[row.metric] = row.quality;
    if (row.isBuffered) point.buffered = true;
  }

  return {
    from: request.from,
    to: request.to,
    interval: 'raw',
    timezone,
    meterIds: request.meterIds,
    metrics: [...metrics].sort(),
    points: [...byTime.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t)),
    aggregated: false,
  };
}

async function aggregatedHistory(
  request: HistoryRequest,
  interval: BucketInterval,
  timezone: string,
): Promise<HistoryResult> {
  // Snap the window to bucket edges so the first and last buckets are whole.
  const from = bucketStart(request.from, interval, timezone).toISOString();
  const to = bucketEnd(request.to, interval, timezone).toISOString();

  const rows = await listRollups({
    meterIds: request.meterIds,
    metrics: request.metrics,
    bucket: interval,
    from,
    to,
    limit: request.limit,
  });

  const definitions = await loadMetricDefinitions();
  const byBucket = new Map<string, HistoryPoint>();
  const metrics = new Set<string>();
  const multiMeter = request.meterIds.length > 1;

  for (const row of rows) {
    metrics.add(row.metric);
    let point = byBucket.get(row.bucketStart);
    if (!point) {
      point = {
        t: row.bucketStart,
        tLocal: toSiteIso(row.bucketStart, timezone),
        values: {},
        consumption: {},
        quality: {},
        sampleCount: 0,
      };
      byBucket.set(row.bucketStart, point);
    }

    const definition = definitions.get(row.metric);
    const representative = pickRepresentative(row, definition?.aggregation ?? 'avg');

    // Several meters in one series are summed for additive quantities and
    // averaged for intensive ones - adding three voltages is meaningless.
    if (multiMeter && point.values[row.metric] !== undefined) {
      const additive = definition?.aggregation === 'sum' || definition?.kind === 'cumulative';
      point.values[row.metric] = additive
        ? (point.values[row.metric] ?? 0) + representative
        : ((point.values[row.metric] ?? 0) + representative) / 2;
    } else {
      point.values[row.metric] = representative;
    }

    if (row.delta !== null && row.delta !== undefined && point.consumption) {
      point.consumption[row.metric] = (point.consumption[row.metric] ?? 0) + row.delta;
    }
    if (point.quality) {
      point.quality[row.metric] = (row.quality as Quality) ?? 'GOOD';
    }
    point.sampleCount = (point.sampleCount ?? 0) + row.sampleCount;
  }

  return {
    from,
    to,
    interval,
    timezone,
    meterIds: request.meterIds,
    metrics: [...metrics].sort(),
    points: [...byBucket.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t)),
    aggregated: true,
  };
}

function pickRepresentative(
  row: { avg: number | null; last: number | null; max: number | null; min: number | null; sum: number | null },
  aggregation: string,
): number {
  switch (aggregation) {
    case 'last': return row.last ?? row.avg ?? 0;
    case 'max': return row.max ?? row.avg ?? 0;
    case 'min': return row.min ?? row.avg ?? 0;
    case 'sum': return row.sum ?? 0;
    case 'delta': return row.last ?? 0;
    default: return row.avg ?? row.last ?? 0;
  }
}

/* ------------------------------------------------------------------- live -- */

export interface LiveReading {
  meterId: string;
  meterUid: string;
  meterName: string;
  gatewayId: string | null;
  siteId: string | null;
  slaveId: number | null;
  status: string;
  lastDataAt: string | null;
  lastDataAtLocal: string | null;
  /** Seconds since the most recent measurement. */
  ageSeconds: number | null;
  measurements: Record<
    string,
    { value: number; unit: string | null; quality: Quality; at: string; buffered: boolean }
  >;
}

export async function queryLive(meterIds: string[], timezone: string): Promise<LiveReading[]> {
  const meters = await listMeters();
  const wanted = new Set(meterIds);
  const now = Date.now();
  const out: LiveReading[] = [];

  for (const meter of meters) {
    if (!wanted.has(meter.id)) continue;
    const readings = await latestByMeter(meter.id);

    const measurements: LiveReading['measurements'] = {};
    let newest: string | null = null;

    for (const reading of readings) {
      measurements[reading.metric] = {
        value: reading.value,
        unit: reading.unit,
        quality: reading.quality,
        at: reading.time,
        buffered: reading.isBuffered,
      };
      if (!newest || Date.parse(reading.time) > Date.parse(newest)) newest = reading.time;
    }

    out.push({
      meterId: meter.id,
      meterUid: meter.meterUid,
      meterName: meter.meterName,
      gatewayId: meter.gatewayId,
      siteId: meter.siteId,
      slaveId: meter.slaveId,
      status: meter.status,
      lastDataAt: newest,
      lastDataAtLocal: newest ? toSiteIso(newest, timezone) : null,
      ageSeconds: newest ? Math.round((now - Date.parse(newest)) / 1000) : null,
      measurements,
    });
  }
  return out;
}

/* ------------------------------------------------------------ consumption -- */

export interface ConsumptionResult {
  meterId: string;
  metric: string;
  from: string;
  to: string;
  startReading: number | null;
  endReading: number | null;
  consumption: number;
  quality: Quality;
  events: string[];
  note: string | null;
}

/**
 * Energy used between two instants (spec section 13).
 *
 * `end - start`, walked reading by reading so that a rollover is credited and a
 * meter reset is not. Summing the cumulative readings themselves would be the
 * classic mistake, and this is the one place the arithmetic is centralised.
 */
export async function queryConsumption(
  meterId: string,
  metric: string,
  from: string,
  to: string,
): Promise<ConsumptionResult> {
  const opening = await valueAtOrBefore(meterId, metric, from);
  const rows = await listTelemetry({ meterId, metrics: [metric], from, to });

  const series = [
    ...(opening ? [{ value: opening.value, time: opening.time }] : []),
    ...rows.map((row) => ({ value: row.value, time: row.time })),
  ];

  if (series.length < 2) {
    return {
      meterId,
      metric,
      from,
      to,
      startReading: series[0]?.value ?? null,
      endReading: series[series.length - 1]?.value ?? null,
      consumption: 0,
      quality: 'GOOD',
      events: [],
      note: 'Not enough readings in this window to compute consumption.',
    };
  }

  const result = consumptionOverSeries(series, DEFAULT_COUNTER_OPTIONS);
  return {
    meterId,
    metric,
    from,
    to,
    startReading: series[0]?.value ?? null,
    endReading: series[series.length - 1]?.value ?? null,
    consumption: result.total,
    quality: result.quality,
    events: result.events,
    note: result.events.length
      ? 'Counter anomalies were detected in this window: ' + [...new Set(result.events)].join(', ') + '.'
      : null,
  };
}
