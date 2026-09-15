import { env } from '../../config/env.js';
import { bus } from '../../core/events.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import { nowIso } from '../../core/time.js';
import type { AlertRule } from '../../db/repositories/alerts.js';
import {
  findOpenAlert,
  listActiveAlerts,
  listAlertRules,
  openAlert,
  setAlertStatus,
  touchAlert,
} from '../../db/repositories/alerts.js';
import { listGateways } from '../../db/repositories/gateways.js';
import { listMeters } from '../../db/repositories/meters.js';
import { loadMetricDefinitions } from '../../db/repositories/metrics.js';
import type { NormalizedSample, NormalizedTelemetry } from '../adapters/types.js';

const log = createLogger('alerts');

/**
 * Rule evaluation (spec section 15).
 *
 * Two kinds of rule, evaluated differently:
 *
 *   value rules     fire on a sample - voltage over limit, PF under limit,
 *                   frequency out of band, demand over threshold;
 *   absence rules   fire on a timer, because their trigger is the *lack* of a
 *                   message - meter stopped reporting, gateway offline.
 *
 * Thresholds are per meter, per gateway, per site or global, and every one of
 * them is a row rather than a constant.
 */

export interface RuleMatch {
  rule: AlertRule;
  sample: NormalizedSample;
  breached: boolean;
}

export function evaluateCondition(rule: AlertRule, value: number): boolean {
  const threshold = rule.threshold ?? 0;
  switch (rule.condition) {
    case 'gt': return value > threshold;
    case 'gte': return value >= threshold;
    case 'lt': return value < threshold;
    case 'lte': return value <= threshold;
    case 'eq': return value === threshold;
    case 'neq': return value !== threshold;
    case 'outside':
      return value < threshold || value > (rule.thresholdHigh ?? threshold);
    case 'inside':
      return value >= threshold && value <= (rule.thresholdHigh ?? threshold);
    case 'no_data':
    case 'device_offline':
      // Absence rules are handled by the timed sweep, never by a sample.
      return false;
  }
}

function ruleApplies(rule: AlertRule, telemetry: NormalizedTelemetry): boolean {
  if (!rule.enabled) return false;
  if (rule.meterId && rule.meterId !== telemetry.meterId) return false;
  if (rule.gatewayId && rule.gatewayId !== telemetry.gatewayId) return false;
  if (rule.siteId && rule.siteId !== telemetry.siteId) return false;
  return true;
}

function renderMessage(rule: AlertRule, value: number, unit: string | null, meterLabel: string): string {
  if (rule.messageTemplate) {
    return rule.messageTemplate
      .replace(/\{value\}/g, String(round(value)))
      .replace(/\{threshold\}/g, String(rule.threshold ?? ''))
      .replace(/\{metric\}/g, rule.metric ?? '')
      .replace(/\{meter\}/g, meterLabel)
      .replace(/\{unit\}/g, unit ?? '');
  }
  const comparison =
    rule.condition === 'outside'
      ? 'outside ' + rule.threshold + '-' + rule.thresholdHigh
      : rule.condition + ' ' + rule.threshold;
  return meterLabel + ': ' + (rule.metric ?? 'value') + ' is ' + round(value) + (unit ? ' ' + unit : '') +
    ' (' + comparison + ')';
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Evaluate every value rule against one reading.
 *
 * Alerts open when the condition first breaches and close when a later reading
 * clears it, so an operator sees one event per episode rather than one per
 * sample.
 */
export async function evaluateTelemetry(telemetry: NormalizedTelemetry): Promise<void> {
  if (!env.ALERTS_ENABLED) return;

  const rules = (await listAlertRules()).filter((rule) => ruleApplies(rule, telemetry));
  if (rules.length === 0) return;

  const definitions = await loadMetricDefinitions();
  const byMetric = new Map(telemetry.samples.map((sample) => [sample.metric, sample] as const));
  const meterLabel = telemetry.meterUid;

  for (const rule of rules) {
    if (rule.condition === 'no_data' || rule.condition === 'device_offline') continue;
    if (!rule.metric) continue;

    const sample = byMetric.get(rule.metric);
    if (!sample) continue;
    // A value we already distrust should not raise a hard alert on its own.
    if (sample.quality === 'BAD') continue;

    const breached = evaluateCondition(rule, sample.value);
    const existing = await findOpenAlert(rule.id, telemetry.meterId, rule.metric);

    if (breached && !existing) {
      const unit = sample.unit ?? definitions.get(rule.metric)?.unit ?? null;
      const event = await openAlert({
        ruleId: rule.id,
        siteId: telemetry.siteId,
        gatewayId: telemetry.gatewayId,
        meterId: telemetry.meterId,
        metric: rule.metric,
        severity: rule.severity,
        message: renderMessage(rule, sample.value, unit, meterLabel),
        value: sample.value,
        threshold: rule.threshold,
        unit,
        at: telemetry.timestamp,
      });
      log.warn('alert opened', {
        event: LogEvent.ALERT_OPENED,
        alertId: event.id,
        rule: rule.name,
        meterId: telemetry.meterId,
        metric: rule.metric,
        value: sample.value,
      });
      bus.emit('alert.opened', {
        id: event.id,
        ruleId: rule.id,
        meterId: telemetry.meterId,
        gatewayId: telemetry.gatewayId,
        severity: rule.severity,
        message: event.message,
        value: sample.value,
      });
    } else if (breached && existing) {
      await touchAlert(existing.id, sample.value, telemetry.timestamp);
    } else if (!breached && existing) {
      await setAlertStatus(existing.id, 'resolved');
      log.info('alert cleared', {
        event: LogEvent.ALERT_CLOSED,
        alertId: existing.id,
        rule: rule.name,
        meterId: telemetry.meterId,
      });
      bus.emit('alert.closed', {
        id: existing.id,
        ruleId: rule.id,
        meterId: telemetry.meterId,
        gatewayId: telemetry.gatewayId,
      });
    }
  }
}

/**
 * Timed evaluation of absence rules.
 *
 * `duration_seconds` on the rule is the silence the operator considers a
 * problem; nothing here is hard-coded to five minutes (spec section 16).
 */
export async function evaluateAbsenceRules(): Promise<void> {
  if (!env.ALERTS_ENABLED) return;

  const rules = (await listAlertRules()).filter(
    (rule) => rule.enabled && (rule.condition === 'no_data' || rule.condition === 'device_offline'),
  );
  if (rules.length === 0) return;

  const now = Date.now();
  const at = nowIso();
  const gateways = await listGateways();
  const meters = await listMeters();

  for (const rule of rules) {
    const silenceSeconds = rule.durationSeconds || env.METER_STALE_AFTER_SECONDS;

    if (rule.condition === 'device_offline') {
      for (const gateway of gateways) {
        if (!gateway.enabled) continue;
        if (rule.gatewayId && rule.gatewayId !== gateway.id) continue;
        if (rule.siteId && rule.siteId !== gateway.siteId) continue;

        const last = gateway.lastSeenAt ? Date.parse(gateway.lastSeenAt) : null;
        const silent = last === null || (now - last) / 1000 > silenceSeconds;
        await reconcileAbsence(rule, {
          siteId: gateway.siteId,
          gatewayId: gateway.id,
          meterId: null,
          label: gateway.name,
          silent,
          silenceSeconds,
          lastAt: gateway.lastSeenAt,
          at,
        });
      }
      continue;
    }

    for (const meter of meters) {
      if (!meter.enabled) continue;
      if (rule.meterId && rule.meterId !== meter.id) continue;
      if (rule.gatewayId && rule.gatewayId !== meter.gatewayId) continue;
      if (rule.siteId && rule.siteId !== meter.siteId) continue;

      const last = meter.lastDataAt ? Date.parse(meter.lastDataAt) : null;
      const silent = last === null || (now - last) / 1000 > silenceSeconds;
      await reconcileAbsence(rule, {
        siteId: meter.siteId,
        gatewayId: meter.gatewayId,
        meterId: meter.id,
        label: meter.meterName,
        silent,
        silenceSeconds,
        lastAt: meter.lastDataAt,
        at,
      });
    }
  }
}

interface AbsenceSubject {
  siteId: string | null;
  gatewayId: string | null;
  meterId: string | null;
  label: string;
  silent: boolean;
  silenceSeconds: number;
  lastAt: string | null;
  at: string;
}

async function reconcileAbsence(rule: AlertRule, subject: AbsenceSubject): Promise<void> {
  const existing = await findOpenAlert(rule.id, subject.meterId, rule.metric);

  if (subject.silent && !existing) {
    const message =
      rule.messageTemplate?.replace(/\{meter\}/g, subject.label) ??
      subject.label + ' has not reported for more than ' + subject.silenceSeconds + 's' +
        (subject.lastAt ? ' (last seen ' + subject.lastAt + ')' : ' (never seen)');

    const event = await openAlert({
      ruleId: rule.id,
      siteId: subject.siteId,
      gatewayId: subject.gatewayId,
      meterId: subject.meterId,
      metric: rule.metric,
      severity: rule.severity,
      message,
      value: null,
      threshold: subject.silenceSeconds,
      unit: 's',
      at: subject.at,
    });
    log.warn('absence alert opened', {
      event: LogEvent.ALERT_OPENED,
      alertId: event.id,
      rule: rule.name,
      subject: subject.label,
    });
    bus.emit('alert.opened', {
      id: event.id,
      ruleId: rule.id,
      meterId: subject.meterId,
      gatewayId: subject.gatewayId,
      severity: rule.severity,
      message,
      value: null,
    });
    return;
  }

  if (!subject.silent && existing) {
    await setAlertStatus(existing.id, 'resolved');
    log.info('absence alert cleared', {
      event: LogEvent.ALERT_CLOSED,
      alertId: existing.id,
      subject: subject.label,
    });
    bus.emit('alert.closed', {
      id: existing.id,
      ruleId: rule.id,
      meterId: subject.meterId,
      gatewayId: subject.gatewayId,
    });
  }
}

export async function activeAlertCount(): Promise<number> {
  return (await listActiveAlerts()).length;
}

/** Subscribe the engine to the ingest pipeline. */
export function startAlertEngine(): () => void {
  if (!env.ALERTS_ENABLED) {
    log.info('alert engine disabled');
    return () => undefined;
  }
  const unsubscribe = bus.on('telemetry.saved', (payload) => {
    void evaluateTelemetry(payload.telemetry).catch((error: unknown) =>
      log.error('rule evaluation failed', { meterId: payload.meterId, error }),
    );
  });
  log.info('alert engine started');
  return unsubscribe;
}
