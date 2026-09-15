import { newId } from '../../core/hash.js';
import { nowIso } from '../../core/time.js';
import { db } from '../index.js';
import { toInt, toIso, toNum, toStr } from '../types.js';

export interface CounterState {
  meterId: string;
  metric: string;
  lastValue: number | null;
  lastTime: string | null;
  accumulated: number;
  resetCount: number;
  rolloverCount: number;
  updatedAt: string | null;
}

export type CounterEventType = 'RESET' | 'ROLLOVER' | 'BACKWARD' | 'SPIKE' | 'GAP';

export interface CounterEvent {
  id: string;
  meterId: string;
  metric: string;
  eventType: CounterEventType;
  previousValue: number | null;
  newValue: number | null;
  deltaApplied: number | null;
  sourceTime: string | null;
  detectedAt: string | null;
  note: string | null;
}

function mapState(row: Record<string, unknown>): CounterState {
  return {
    meterId: String(row.meter_id),
    metric: String(row.metric),
    lastValue: toNum(row.last_value),
    lastTime: toIso(row.last_time),
    accumulated: toNum(row.accumulated) ?? 0,
    resetCount: toInt(row.reset_count) ?? 0,
    rolloverCount: toInt(row.rollover_count) ?? 0,
    updatedAt: toIso(row.updated_at),
  };
}

function mapEvent(row: Record<string, unknown>): CounterEvent {
  return {
    id: String(row.id),
    meterId: String(row.meter_id),
    metric: String(row.metric),
    eventType: String(row.event_type) as CounterEventType,
    previousValue: toNum(row.previous_value),
    newValue: toNum(row.new_value),
    deltaApplied: toNum(row.delta_applied),
    sourceTime: toIso(row.source_time),
    detectedAt: toIso(row.detected_at),
    note: toStr(row.note),
  };
}

export async function getCounterState(meterId: string, metric: string): Promise<CounterState | null> {
  const row = await db().one(
    'SELECT * FROM energy_counter_state WHERE meter_id = $1 AND metric = $2',
    [meterId, metric],
  );
  return row ? mapState(row) : null;
}

export async function listCounterStates(meterId: string): Promise<CounterState[]> {
  return (await db().rows('SELECT * FROM energy_counter_state WHERE meter_id = $1', [meterId])).map(mapState);
}

export interface CounterStateUpdate {
  meterId: string;
  metric: string;
  lastValue: number;
  lastTime: string;
  accumulatedDelta: number;
  resetIncrement?: number;
  rolloverIncrement?: number;
}

/**
 * Advance a cumulative counter.
 *
 * The guard on `last_time` matters: a buffered replay can deliver a reading
 * *older* than the one already stored, and that must not drag the counter
 * backwards. Accumulated consumption still moves forward by the computed delta.
 */
export async function advanceCounter(update: CounterStateUpdate): Promise<void> {
  const now = nowIso();
  await db().execute(
    'INSERT INTO energy_counter_state (meter_id, metric, last_value, last_time, accumulated, reset_count, ' +
      'rollover_count, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ' +
      'ON CONFLICT (meter_id, metric) DO UPDATE SET ' +
      'last_value = CASE WHEN energy_counter_state.last_time IS NULL OR energy_counter_state.last_time <= $4 ' +
      '  THEN excluded.last_value ELSE energy_counter_state.last_value END, ' +
      'last_time = CASE WHEN energy_counter_state.last_time IS NULL OR energy_counter_state.last_time <= $4 ' +
      '  THEN excluded.last_time ELSE energy_counter_state.last_time END, ' +
      'accumulated = energy_counter_state.accumulated + $5, ' +
      'reset_count = energy_counter_state.reset_count + $6, ' +
      'rollover_count = energy_counter_state.rollover_count + $7, ' +
      'updated_at = $8',
    [
      update.meterId, update.metric, update.lastValue, update.lastTime,
      update.accumulatedDelta, update.resetIncrement ?? 0, update.rolloverIncrement ?? 0, now,
    ],
  );
}

export async function recordCounterEvent(event: Omit<CounterEvent, 'id' | 'detectedAt'>): Promise<void> {
  await db().execute(
    'INSERT INTO energy_counter_events (id, meter_id, metric, event_type, previous_value, new_value, ' +
      'delta_applied, source_time, detected_at, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      newId('cev'), event.meterId, event.metric, event.eventType, event.previousValue,
      event.newValue, event.deltaApplied, event.sourceTime, nowIso(), event.note,
    ],
  );
}

export async function listCounterEvents(
  filter: { meterId?: string; limit?: number } = {},
): Promise<CounterEvent[]> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
  if (filter.meterId) {
    const rows = await db().rows(
      'SELECT * FROM energy_counter_events WHERE meter_id = $1 ORDER BY detected_at DESC LIMIT $2',
      [filter.meterId, limit],
    );
    return rows.map(mapEvent);
  }
  const rows = await db().rows(
    'SELECT * FROM energy_counter_events ORDER BY detected_at DESC LIMIT $1',
    [limit],
  );
  return rows.map(mapEvent);
}
