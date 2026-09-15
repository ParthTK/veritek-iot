import { newId } from '../../core/hash.js';
import { nowIso } from '../../core/time.js';
import { db } from '../index.js';
import type { SqlParam } from '../types.js';
import { toBool, toInt, toIso, toJson, toNum, toStr } from '../types.js';

export type AlertScope = 'global' | 'site' | 'gateway' | 'meter';
export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertStatus = 'active' | 'acknowledged' | 'resolved';

/**
 * Conditions the engine understands.
 *
 * `no_data` and `device_offline` are evaluated on a timer rather than per
 * sample, because their trigger is the *absence* of a message.
 */
export type AlertCondition =
  | 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  | 'outside' | 'inside'
  | 'no_data' | 'device_offline';

export interface AlertRule {
  id: string;
  name: string;
  scope: AlertScope;
  siteId: string | null;
  gatewayId: string | null;
  meterId: string | null;
  metric: string | null;
  condition: AlertCondition;
  threshold: number | null;
  thresholdHigh: number | null;
  durationSeconds: number;
  severity: AlertSeverity;
  enabled: boolean;
  cooldownSeconds: number;
  notify: Record<string, unknown>;
  messageTemplate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AlertEvent {
  id: string;
  ruleId: string | null;
  siteId: string | null;
  gatewayId: string | null;
  meterId: string | null;
  metric: string | null;
  severity: AlertSeverity;
  status: AlertStatus;
  message: string;
  value: number | null;
  threshold: number | null;
  unit: string | null;
  openedAt: string;
  lastSeenAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  occurrenceCount: number;
}

function mapRule(row: Record<string, unknown>): AlertRule {
  return {
    id: String(row.id),
    name: String(row.name),
    scope: (toStr(row.scope) as AlertScope) ?? 'meter',
    siteId: toStr(row.site_id),
    gatewayId: toStr(row.gateway_id),
    meterId: toStr(row.meter_id),
    metric: toStr(row.metric),
    condition: String(row.condition) as AlertCondition,
    threshold: toNum(row.threshold),
    thresholdHigh: toNum(row.threshold_high),
    durationSeconds: toInt(row.duration_seconds) ?? 0,
    severity: (toStr(row.severity) as AlertSeverity) ?? 'warning',
    enabled: toBool(row.enabled),
    cooldownSeconds: toInt(row.cooldown_seconds) ?? 300,
    notify: toJson<Record<string, unknown>>(row.notify, {}),
    messageTemplate: toStr(row.message_template),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapEvent(row: Record<string, unknown>): AlertEvent {
  return {
    id: String(row.id),
    ruleId: toStr(row.rule_id),
    siteId: toStr(row.site_id),
    gatewayId: toStr(row.gateway_id),
    meterId: toStr(row.meter_id),
    metric: toStr(row.metric),
    severity: (toStr(row.severity) as AlertSeverity) ?? 'warning',
    status: (toStr(row.status) as AlertStatus) ?? 'active',
    message: String(row.message),
    value: toNum(row.value),
    threshold: toNum(row.threshold),
    unit: toStr(row.unit),
    openedAt: toIso(row.opened_at) ?? '',
    lastSeenAt: toIso(row.last_seen_at),
    acknowledgedAt: toIso(row.acknowledged_at),
    acknowledgedBy: toStr(row.acknowledged_by),
    resolvedAt: toIso(row.resolved_at),
    occurrenceCount: toInt(row.occurrence_count) ?? 1,
  };
}

/* ------------------------------------------------------------------ rules -- */

let ruleCache: AlertRule[] | null = null;

export async function listAlertRules(force = false): Promise<AlertRule[]> {
  if (ruleCache && !force) return ruleCache;
  ruleCache = (await db().rows('SELECT * FROM alert_rules ORDER BY name')).map(mapRule);
  return ruleCache;
}

export function invalidateRuleCache(): void {
  ruleCache = null;
}

export async function getAlertRule(id: string): Promise<AlertRule | null> {
  const row = await db().one('SELECT * FROM alert_rules WHERE id = $1', [id]);
  return row ? mapRule(row) : null;
}

export interface AlertRuleInput {
  id?: string;
  name: string;
  scope?: AlertScope;
  siteId?: string | null;
  gatewayId?: string | null;
  meterId?: string | null;
  metric?: string | null;
  condition: AlertCondition;
  threshold?: number | null;
  thresholdHigh?: number | null;
  durationSeconds?: number;
  severity?: AlertSeverity;
  enabled?: boolean;
  cooldownSeconds?: number;
  notify?: Record<string, unknown>;
  messageTemplate?: string | null;
}

export async function upsertAlertRule(input: AlertRuleInput): Promise<AlertRule> {
  const id = input.id ?? newId('rule');
  const now = nowIso();
  await db().execute(
    'INSERT INTO alert_rules (id, name, scope, site_id, gateway_id, meter_id, metric, condition, threshold, ' +
      'threshold_high, duration_seconds, severity, enabled, cooldown_seconds, notify, message_template, ' +
      'created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17) ' +
      'ON CONFLICT (id) DO UPDATE SET name = excluded.name, scope = excluded.scope, site_id = excluded.site_id, ' +
      'gateway_id = excluded.gateway_id, meter_id = excluded.meter_id, metric = excluded.metric, ' +
      'condition = excluded.condition, threshold = excluded.threshold, threshold_high = excluded.threshold_high, ' +
      'duration_seconds = excluded.duration_seconds, severity = excluded.severity, enabled = excluded.enabled, ' +
      'cooldown_seconds = excluded.cooldown_seconds, notify = excluded.notify, ' +
      'message_template = excluded.message_template, updated_at = excluded.updated_at',
    [
      id, input.name, input.scope ?? 'meter', input.siteId ?? null, input.gatewayId ?? null,
      input.meterId ?? null, input.metric ?? null, input.condition, input.threshold ?? null,
      input.thresholdHigh ?? null, input.durationSeconds ?? 0, input.severity ?? 'warning',
      input.enabled ?? true, input.cooldownSeconds ?? 300, input.notify ?? {},
      input.messageTemplate ?? null, now,
    ],
  );
  invalidateRuleCache();
  const rule = await getAlertRule(id);
  if (!rule) throw new Error('Failed to persist alert rule');
  return rule;
}

export async function deleteAlertRule(id: string): Promise<boolean> {
  const deleted = await db().execute('DELETE FROM alert_rules WHERE id = $1', [id]);
  invalidateRuleCache();
  return deleted > 0;
}

/* ----------------------------------------------------------------- events -- */

export async function findOpenAlert(
  ruleId: string,
  meterId: string | null,
  metric: string | null,
): Promise<AlertEvent | null> {
  const row = await db().one(
    "SELECT * FROM alert_events WHERE rule_id = $1 AND status = 'active' " +
      'AND (meter_id = $2 OR ($2 IS NULL AND meter_id IS NULL)) ' +
      'AND (metric = $3 OR ($3 IS NULL AND metric IS NULL)) LIMIT 1',
    [ruleId, meterId, metric],
  );
  return row ? mapEvent(row) : null;
}

export interface OpenAlertInput {
  ruleId: string;
  siteId: string | null;
  gatewayId: string | null;
  meterId: string | null;
  metric: string | null;
  severity: AlertSeverity;
  message: string;
  value: number | null;
  threshold: number | null;
  unit: string | null;
  at: string;
}

export async function openAlert(input: OpenAlertInput): Promise<AlertEvent> {
  const id = newId('alrt');
  await db().execute(
    'INSERT INTO alert_events (id, rule_id, site_id, gateway_id, meter_id, metric, severity, status, message, ' +
      'value, threshold, unit, opened_at, last_seen_at, occurrence_count) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$12,$12,1)",
    [
      id, input.ruleId, input.siteId, input.gatewayId, input.meterId, input.metric,
      input.severity, input.message, input.value, input.threshold, input.unit, input.at,
    ],
  );
  const row = await db().one('SELECT * FROM alert_events WHERE id = $1', [id]);
  if (!row) throw new Error('Failed to open alert');
  return mapEvent(row);
}

export async function touchAlert(id: string, value: number | null, at: string): Promise<void> {
  await db().execute(
    'UPDATE alert_events SET last_seen_at = $2, value = COALESCE($3, value), ' +
      'occurrence_count = occurrence_count + 1 WHERE id = $1',
    [id, at, value],
  );
}

export async function setAlertStatus(
  id: string,
  status: AlertStatus,
  actor?: string | null,
): Promise<AlertEvent | null> {
  const now = nowIso();
  if (status === 'acknowledged') {
    await db().execute(
      'UPDATE alert_events SET status = $2, acknowledged_at = $3, acknowledged_by = $4 WHERE id = $1',
      [id, status, now, actor ?? null],
    );
  } else if (status === 'resolved') {
    await db().execute(
      'UPDATE alert_events SET status = $2, resolved_at = $3, ' +
        'acknowledged_at = COALESCE(acknowledged_at, $3) WHERE id = $1',
      [id, status, now],
    );
  } else {
    await db().execute('UPDATE alert_events SET status = $2 WHERE id = $1', [id, status]);
  }
  const row = await db().one('SELECT * FROM alert_events WHERE id = $1', [id]);
  return row ? mapEvent(row) : null;
}

export interface AlertQuery {
  status?: AlertStatus;
  severity?: AlertSeverity;
  siteId?: string;
  meterId?: string;
  gatewayId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function listAlerts(query: AlertQuery = {}): Promise<{ rows: AlertEvent[]; total: number }> {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  const add = (column: string, value: string): void => {
    params.push(value);
    clauses.push(column + ' = $' + params.length);
  };

  if (query.status) add('status', query.status);
  if (query.severity) add('severity', query.severity);
  if (query.siteId) add('site_id', query.siteId);
  if (query.meterId) add('meter_id', query.meterId);
  if (query.gatewayId) add('gateway_id', query.gatewayId);
  if (query.from) {
    params.push(query.from);
    clauses.push('opened_at >= $' + params.length);
  }
  if (query.to) {
    params.push(query.to);
    clauses.push('opened_at <= $' + params.length);
  }

  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const totalRow = await db().one<{ total: number }>('SELECT COUNT(*) AS total FROM alert_events' + where, params);

  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
  const offset = Math.max(query.offset ?? 0, 0);
  params.push(limit, offset);
  const rows = await db().rows(
    'SELECT * FROM alert_events' + where + ' ORDER BY opened_at DESC LIMIT $' +
      (params.length - 1) + ' OFFSET $' + params.length,
    params,
  );
  return { rows: rows.map(mapEvent), total: toInt(totalRow?.total) ?? 0 };
}

export async function listActiveAlerts(): Promise<AlertEvent[]> {
  const rows = await db().rows("SELECT * FROM alert_events WHERE status = 'active' ORDER BY opened_at DESC");
  return rows.map(mapEvent);
}
