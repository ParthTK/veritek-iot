import { db } from '../index.js';
import { toInt, toNum, toStr } from '../types.js';

/**
 * The platform's metric catalogue (spec section 11).
 *
 * This is *our* vocabulary, not any vendor's. An adapter's job is to land a
 * value on one of these keys; how the meter names or encodes it is the
 * adapter's problem, not the platform's.
 */

export type MetricKind = 'instant' | 'cumulative' | 'demand' | 'status';
export type MetricAggregation = 'avg' | 'sum' | 'last' | 'max' | 'min' | 'delta';

export interface MetricDefinition {
  metricKey: string;
  displayName: string;
  unit: string | null;
  category: string | null;
  kind: MetricKind;
  aggregation: MetricAggregation;
  decimals: number;
  minValid: number | null;
  maxValid: number | null;
  sortOrder: number;
}

function map(row: Record<string, unknown>): MetricDefinition {
  return {
    metricKey: String(row.metric_key),
    displayName: String(row.display_name),
    unit: toStr(row.unit),
    category: toStr(row.category),
    kind: (toStr(row.kind) as MetricKind) ?? 'instant',
    aggregation: (toStr(row.aggregation) as MetricAggregation) ?? 'avg',
    decimals: toInt(row.decimals) ?? 2,
    minValid: toNum(row.min_valid),
    maxValid: toNum(row.max_valid),
    sortOrder: toInt(row.sort_order) ?? 100,
  };
}

let cache: Map<string, MetricDefinition> | null = null;

export async function loadMetricDefinitions(force = false): Promise<Map<string, MetricDefinition>> {
  if (cache && !force) return cache;
  const rows = await db().rows('SELECT * FROM metric_definitions ORDER BY sort_order, metric_key');
  cache = new Map(rows.map((row) => {
    const definition = map(row);
    return [definition.metricKey, definition] as const;
  }));
  return cache;
}

export function invalidateMetricCache(): void {
  cache = null;
}

export async function listMetricDefinitions(): Promise<MetricDefinition[]> {
  return [...(await loadMetricDefinitions()).values()].sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function getMetricDefinition(metricKey: string): Promise<MetricDefinition | null> {
  return (await loadMetricDefinitions()).get(metricKey) ?? null;
}

export interface MetricDefinitionInput {
  metricKey: string;
  displayName: string;
  unit?: string | null;
  category?: string | null;
  kind?: MetricKind;
  aggregation?: MetricAggregation;
  decimals?: number;
  minValid?: number | null;
  maxValid?: number | null;
  sortOrder?: number;
}

export async function upsertMetricDefinition(input: MetricDefinitionInput): Promise<void> {
  await db().execute(
    'INSERT INTO metric_definitions (metric_key, display_name, unit, category, kind, aggregation, decimals, ' +
      'min_valid, max_valid, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ' +
      'ON CONFLICT (metric_key) DO UPDATE SET display_name = excluded.display_name, unit = excluded.unit, ' +
      'category = excluded.category, kind = excluded.kind, aggregation = excluded.aggregation, ' +
      'decimals = excluded.decimals, min_valid = excluded.min_valid, max_valid = excluded.max_valid, ' +
      'sort_order = excluded.sort_order',
    [
      input.metricKey, input.displayName, input.unit ?? null, input.category ?? null,
      input.kind ?? 'instant', input.aggregation ?? 'avg', input.decimals ?? 2,
      input.minValid ?? null, input.maxValid ?? null, input.sortOrder ?? 100,
    ],
  );
  invalidateMetricCache();
}
