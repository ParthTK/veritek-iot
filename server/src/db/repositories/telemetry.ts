import { nowIso } from '../../core/time.js';
import { db } from '../index.js';
import type { SqlParam } from '../types.js';
import { toBool, toInt, toIso, toNum, toStr } from '../types.js';
import type { Quality } from '../../iot/adapters/types.js';

export interface TelemetryRow {
  time: string;
  meterId: string;
  metric: string;
  value: number;
  gatewayId: string | null;
  siteId: string | null;
  unit: string | null;
  quality: Quality;
  sourceTimestamp: string | null;
  serverReceivedAt: string;
  isBuffered: boolean;
  rawMessageId: string | null;
  fingerprint: string | null;
}

export interface TelemetryInsert {
  time: string;
  meterId: string;
  metric: string;
  value: number;
  gatewayId: string | null;
  siteId: string | null;
  unit: string | null;
  quality: Quality;
  sourceTimestamp: string | null;
  serverReceivedAt: string;
  isBuffered: boolean;
  rawMessageId: string | null;
  fingerprint: string | null;
}

function map(row: Record<string, unknown>): TelemetryRow {
  return {
    time: toIso(row.time) ?? '',
    meterId: String(row.meter_id),
    metric: String(row.metric),
    value: toNum(row.value) ?? 0,
    gatewayId: toStr(row.gateway_id),
    siteId: toStr(row.site_id),
    unit: toStr(row.unit),
    quality: (toStr(row.quality) as Quality) ?? 'GOOD',
    sourceTimestamp: toIso(row.source_timestamp),
    serverReceivedAt: toIso(row.server_received_at) ?? '',
    isBuffered: toBool(row.is_buffered),
    rawMessageId: toStr(row.raw_message_id),
    fingerprint: toStr(row.fingerprint),
  };
}

const COLUMNS_PER_ROW = 13;
/** Kept well under SQLite's bound-parameter ceiling. */
const MAX_ROWS_PER_STATEMENT = 60;

/**
 * Insert samples idempotently.
 *
 * `(meter_id, metric, time)` is the primary key, so a buffered packet replayed
 * after the cellular link recovers cannot create a second reading at the same
 * measurement instant - which is what stops replays double-counting energy
 * (spec section 9).
 *
 * @returns how many rows were genuinely new
 */
export async function insertTelemetry(samples: TelemetryInsert[]): Promise<number> {
  if (samples.length === 0) return 0;

  let inserted = 0;
  for (let start = 0; start < samples.length; start += MAX_ROWS_PER_STATEMENT) {
    const chunk = samples.slice(start, start + MAX_ROWS_PER_STATEMENT);
    const params: SqlParam[] = [];
    const tuples: string[] = [];

    for (const sample of chunk) {
      const base = params.length;
      const placeholders = Array.from({ length: COLUMNS_PER_ROW }, (_unused, index) => '$' + (base + index + 1));
      tuples.push('(' + placeholders.join(',') + ')');
      params.push(
        sample.time, sample.meterId, sample.metric, sample.value, sample.gatewayId, sample.siteId,
        sample.unit, sample.quality, sample.sourceTimestamp, sample.serverReceivedAt,
        sample.isBuffered, sample.rawMessageId, sample.fingerprint,
      );
    }

    inserted += await db().execute(
      'INSERT INTO telemetry (time, meter_id, metric, value, gateway_id, site_id, unit, quality, ' +
        'source_timestamp, server_received_at, is_buffered, raw_message_id, fingerprint) VALUES ' +
        tuples.join(',') +
        ' ON CONFLICT (meter_id, metric, time) DO NOTHING',
      params,
    );
  }
  return inserted;
}

/* ---------------------------------------------------------- fingerprints -- */

export interface FingerprintRecord {
  fingerprint: string;
  gatewayUid: string;
  meterId: string | null;
  slaveId: number | null;
  sourceTime: string | null;
  rawMessageId: string | null;
}

/**
 * Record a packet fingerprint.
 *
 * @returns true when this exact packet has been seen before (a duplicate)
 */
export async function recordFingerprint(record: FingerprintRecord): Promise<boolean> {
  // The upsert returns the post-increment counter, so one round trip both
  // records the sighting and reports whether it is a repeat.
  const row = await db().one<{ seen_count: number }>(
    'INSERT INTO telemetry_fingerprints (fingerprint, gateway_uid, meter_id, slave_id, source_time, ' +
      'first_seen_at, seen_count, raw_message_id) VALUES ($1,$2,$3,$4,$5,$6,1,$7) ' +
      'ON CONFLICT (fingerprint) DO UPDATE SET seen_count = telemetry_fingerprints.seen_count + 1 ' +
      'RETURNING seen_count',
    [
      record.fingerprint, record.gatewayUid, record.meterId ?? null, record.slaveId ?? null,
      record.sourceTime ?? null, nowIso(), record.rawMessageId ?? null,
    ],
  );
  return (toInt(row?.seen_count) ?? 1) > 1;
}

export async function pruneFingerprints(olderThanIso: string): Promise<number> {
  return db().execute('DELETE FROM telemetry_fingerprints WHERE first_seen_at < $1', [olderThanIso]);
}

/* ------------------------------------------------------------------ reads -- */

export interface LatestReading {
  metric: string;
  value: number;
  unit: string | null;
  time: string;
  quality: Quality;
  sourceTimestamp: string | null;
  serverReceivedAt: string;
  isBuffered: boolean;
}

/** Most recent value of every metric a meter has ever reported. */
export async function latestByMeter(meterId: string): Promise<LatestReading[]> {
  const rows = await db().rows<Record<string, unknown>>(
    'SELECT t.metric, t.value, t.unit, t.time, t.quality, t.source_timestamp, t.server_received_at, t.is_buffered ' +
      'FROM telemetry t JOIN (SELECT metric, MAX(time) AS max_time FROM telemetry WHERE meter_id = $1 GROUP BY metric) m ' +
      'ON t.metric = m.metric AND t.time = m.max_time WHERE t.meter_id = $1 ORDER BY t.metric',
    [meterId],
  );
  return rows.map((row) => ({
    metric: String(row.metric),
    value: toNum(row.value) ?? 0,
    unit: toStr(row.unit),
    time: toIso(row.time) ?? '',
    quality: (toStr(row.quality) as Quality) ?? 'GOOD',
    sourceTimestamp: toIso(row.source_timestamp),
    serverReceivedAt: toIso(row.server_received_at) ?? '',
    isBuffered: toBool(row.is_buffered),
  }));
}

export interface HistoryQuery {
  meterId?: string;
  meterIds?: string[];
  siteId?: string;
  metrics?: string[];
  from: string;
  to: string;
  limit?: number;
}

export async function listTelemetry(query: HistoryQuery): Promise<TelemetryRow[]> {
  const clauses = ['time >= $1', 'time <= $2'];
  const params: SqlParam[] = [query.from, query.to];

  if (query.meterId) {
    params.push(query.meterId);
    clauses.push('meter_id = $' + params.length);
  }
  if (query.meterIds?.length) {
    const placeholders = query.meterIds.map((id) => {
      params.push(id);
      return '$' + params.length;
    });
    clauses.push('meter_id IN (' + placeholders.join(',') + ')');
  }
  if (query.siteId) {
    params.push(query.siteId);
    clauses.push('site_id = $' + params.length);
  }
  if (query.metrics?.length) {
    const placeholders = query.metrics.map((metric) => {
      params.push(metric);
      return '$' + params.length;
    });
    clauses.push('metric IN (' + placeholders.join(',') + ')');
  }

  params.push(Math.min(Math.max(query.limit ?? 50000, 1), 200000));
  const rows = await db().rows(
    'SELECT * FROM telemetry WHERE ' + clauses.join(' AND ') +
      ' ORDER BY time ASC LIMIT $' + params.length,
    params,
  );
  return rows.map(map);
}

/** Metric keys this meter has actually reported, for dynamic dashboards. */
export async function listMeterMetrics(meterId: string): Promise<string[]> {
  const rows = await db().rows<{ metric: string }>(
    'SELECT DISTINCT metric FROM telemetry WHERE meter_id = $1 ORDER BY metric',
    [meterId],
  );
  return rows.map((row) => row.metric);
}

/** Raw samples inside one bucket, used by the rollup recompute. */
export async function samplesInWindow(
  meterId: string,
  from: string,
  toExclusive: string,
): Promise<TelemetryRow[]> {
  const rows = await db().rows(
    'SELECT * FROM telemetry WHERE meter_id = $1 AND time >= $2 AND time < $3 ORDER BY metric, time',
    [meterId, from, toExclusive],
  );
  return rows.map(map);
}

export async function countTelemetry(): Promise<number> {
  const row = await db().one<{ total: number }>('SELECT COUNT(*) AS total FROM telemetry');
  return toInt(row?.total) ?? 0;
}

/**
 * Value at or immediately before `at` - the opening reading for a consumption
 * window when the meter did not happen to report exactly on the boundary.
 */
export async function valueAtOrBefore(
  meterId: string,
  metric: string,
  at: string,
): Promise<TelemetryRow | null> {
  const row = await db().one(
    'SELECT * FROM telemetry WHERE meter_id = $1 AND metric = $2 AND time <= $3 ORDER BY time DESC LIMIT 1',
    [meterId, metric, at],
  );
  return row ? map(row) : null;
}
