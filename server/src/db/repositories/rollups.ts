import { nowIso } from '../../core/time.js';
import type { BucketInterval } from '../../core/time.js';
import { db } from '../index.js';
import type { SqlParam } from '../types.js';
import { toInt, toIso, toNum, toStr } from '../types.js';

export interface RollupRow {
  bucket: BucketInterval;
  meterId: string;
  metric: string;
  bucketStart: string;
  bucketEnd: string;
  siteId: string | null;
  gatewayId: string | null;
  sampleCount: number;
  sum: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  first: number | null;
  last: number | null;
  firstTime: string | null;
  lastTime: string | null;
  /** last - first for cumulative counters, i.e. consumption over the bucket. */
  delta: number | null;
  unit: string | null;
  quality: string;
}

function map(row: Record<string, unknown>): RollupRow {
  return {
    bucket: String(row.bucket) as BucketInterval,
    meterId: String(row.meter_id),
    metric: String(row.metric),
    bucketStart: toIso(row.bucket_start) ?? '',
    bucketEnd: toIso(row.bucket_end) ?? '',
    siteId: toStr(row.site_id),
    gatewayId: toStr(row.gateway_id),
    sampleCount: toInt(row.sample_count) ?? 0,
    sum: toNum(row.sum_value),
    avg: toNum(row.avg_value),
    min: toNum(row.min_value),
    max: toNum(row.max_value),
    first: toNum(row.first_value),
    last: toNum(row.last_value),
    firstTime: toIso(row.first_time),
    lastTime: toIso(row.last_time),
    delta: toNum(row.delta_value),
    unit: toStr(row.unit),
    quality: toStr(row.quality) ?? 'GOOD',
  };
}

export interface RollupUpsert {
  bucket: BucketInterval;
  meterId: string;
  metric: string;
  bucketStart: string;
  bucketEnd: string;
  siteId: string | null;
  gatewayId: string | null;
  sampleCount: number;
  sum: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  first: number | null;
  last: number | null;
  firstTime: string | null;
  lastTime: string | null;
  delta: number | null;
  unit: string | null;
  quality: string;
}

const ROLLUP_COLUMNS = 20;

export async function upsertRollups(rows: RollupUpsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;

  for (let start = 0; start < rows.length; start += 40) {
    const chunk = rows.slice(start, start + 40);
    const params: SqlParam[] = [];
    const tuples: string[] = [];
    const updatedAt = nowIso();

    for (const row of chunk) {
      const base = params.length;
      tuples.push(
        '(' + Array.from({ length: ROLLUP_COLUMNS }, (_u, i) => '$' + (base + i + 1)).join(',') + ')',
      );
      params.push(
        row.bucket, row.meterId, row.metric, row.bucketStart, row.bucketEnd, row.siteId, row.gatewayId,
        row.sampleCount, row.sum, row.avg, row.min, row.max, row.first, row.last,
        row.firstTime, row.lastTime, row.delta, row.unit, row.quality, updatedAt,
      );
    }

    written += await db().execute(
      'INSERT INTO telemetry_rollups (bucket, meter_id, metric, bucket_start, bucket_end, site_id, gateway_id, ' +
        'sample_count, sum_value, avg_value, min_value, max_value, first_value, last_value, first_time, ' +
        'last_time, delta_value, unit, quality, updated_at) VALUES ' + tuples.join(',') +
        ' ON CONFLICT (bucket, meter_id, metric, bucket_start) DO UPDATE SET ' +
        'bucket_end = excluded.bucket_end, site_id = excluded.site_id, gateway_id = excluded.gateway_id, ' +
        'sample_count = excluded.sample_count, sum_value = excluded.sum_value, avg_value = excluded.avg_value, ' +
        'min_value = excluded.min_value, max_value = excluded.max_value, first_value = excluded.first_value, ' +
        'last_value = excluded.last_value, first_time = excluded.first_time, last_time = excluded.last_time, ' +
        'delta_value = excluded.delta_value, unit = excluded.unit, quality = excluded.quality, ' +
        'updated_at = excluded.updated_at',
      params,
    );
  }
  return written;
}

export interface RollupQuery {
  meterIds: string[];
  metrics?: string[];
  bucket: BucketInterval;
  from: string;
  to: string;
  limit?: number;
}

export async function listRollups(query: RollupQuery): Promise<RollupRow[]> {
  if (query.meterIds.length === 0) return [];
  const params: SqlParam[] = [query.bucket, query.from, query.to];
  const clauses = ['bucket = $1', 'bucket_start >= $2', 'bucket_start < $3'];

  const meterPlaceholders = query.meterIds.map((id) => {
    params.push(id);
    return '$' + params.length;
  });
  clauses.push('meter_id IN (' + meterPlaceholders.join(',') + ')');

  if (query.metrics?.length) {
    const metricPlaceholders = query.metrics.map((metric) => {
      params.push(metric);
      return '$' + params.length;
    });
    clauses.push('metric IN (' + metricPlaceholders.join(',') + ')');
  }

  params.push(Math.min(Math.max(query.limit ?? 20000, 1), 200000));
  const rows = await db().rows(
    'SELECT * FROM telemetry_rollups WHERE ' + clauses.join(' AND ') +
      ' ORDER BY bucket_start ASC, meter_id, metric LIMIT $' + params.length,
    params,
  );
  return rows.map(map);
}

export async function deleteRollupsForBucket(
  bucket: BucketInterval,
  meterId: string,
  bucketStart: string,
): Promise<number> {
  return db().execute(
    'DELETE FROM telemetry_rollups WHERE bucket = $1 AND meter_id = $2 AND bucket_start = $3',
    [bucket, meterId, bucketStart],
  );
}

/* ------------------------------------------------------------ dirty set -- */

export interface DirtyBucket {
  bucket: BucketInterval;
  meterId: string;
  bucketStart: string;
}

/**
 * Mark buckets for recompute.
 *
 * Late data is the normal case here, not an exception: the gateway buffers
 * readings through a cellular outage and replays them minutes later. Marking
 * the *measurement-time* bucket dirty is what makes yesterday's chart correct
 * after today's replay.
 */
export async function markDirty(buckets: DirtyBucket[]): Promise<void> {
  if (buckets.length === 0) return;
  const seen = new Set<string>();
  const unique = buckets.filter((b) => {
    const key = b.bucket + '|' + b.meterId + '|' + b.bucketStart;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const markedAt = nowIso();
  for (let start = 0; start < unique.length; start += 100) {
    const chunk = unique.slice(start, start + 100);
    const params: SqlParam[] = [];
    const tuples = chunk.map((b) => {
      const base = params.length;
      params.push(b.bucket, b.meterId, b.bucketStart, markedAt);
      return '($' + (base + 1) + ',$' + (base + 2) + ',$' + (base + 3) + ',$' + (base + 4) + ')';
    });
    await db().execute(
      'INSERT INTO rollup_dirty (bucket, meter_id, bucket_start, marked_at) VALUES ' + tuples.join(',') +
        ' ON CONFLICT (bucket, meter_id, bucket_start) DO NOTHING',
      params,
    );
  }
}

export async function claimDirty(limit: number): Promise<DirtyBucket[]> {
  const rows = await db().rows<Record<string, unknown>>(
    'SELECT bucket, meter_id, bucket_start FROM rollup_dirty ORDER BY marked_at LIMIT $1',
    [limit],
  );
  return rows.map((row) => ({
    bucket: String(row.bucket) as BucketInterval,
    meterId: String(row.meter_id),
    bucketStart: toIso(row.bucket_start) ?? '',
  }));
}

export async function clearDirty(buckets: DirtyBucket[]): Promise<void> {
  for (const bucket of buckets) {
    await db().execute(
      'DELETE FROM rollup_dirty WHERE bucket = $1 AND meter_id = $2 AND bucket_start = $3',
      [bucket.bucket, bucket.meterId, bucket.bucketStart],
    );
  }
}

export async function countDirty(): Promise<number> {
  const row = await db().one<{ total: number }>('SELECT COUNT(*) AS total FROM rollup_dirty');
  return toInt(row?.total) ?? 0;
}
