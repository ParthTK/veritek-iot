import { env } from '../../config/env.js';
import { bus } from '../../core/events.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import type { GatewayStatus } from '../../db/repositories/gateways.js';
import { listGateways, setGatewayStatus } from '../../db/repositories/gateways.js';
import { listMeters, setMeterStatus } from '../../db/repositories/meters.js';
import { countByStatus, pruneRawMessages } from '../../db/repositories/rawMessages.js';
import { pruneFingerprints } from '../../db/repositories/telemetry.js';
import { expireCommands } from '../commands/commandService.js';
import { evaluateAbsenceRules } from '../alerts/engine.js';

const log = createLogger('health');

/**
 * Device liveness and housekeeping (spec section 16).
 *
 * Both thresholds are configuration, not constants: a five-minute rule suits a
 * one-minute poll and is nonsense for a fifteen-minute one.
 *
 *   GATEWAY_STALE_AFTER_SECONDS    quiet for this long  -> DEGRADED
 *   GATEWAY_OFFLINE_AFTER_SECONDS  quiet for this long  -> OFFLINE
 */

export function classifyGateway(lastSeenAt: string | null, now = Date.now()): GatewayStatus {
  if (!lastSeenAt) return 'UNKNOWN';
  const silentSeconds = (now - Date.parse(lastSeenAt)) / 1000;
  if (silentSeconds > env.GATEWAY_OFFLINE_AFTER_SECONDS) return 'OFFLINE';
  if (silentSeconds > env.GATEWAY_STALE_AFTER_SECONDS) return 'DEGRADED';
  return 'ONLINE';
}

export function classifyMeter(lastDataAt: string | null, now = Date.now()): string {
  if (!lastDataAt) return 'UNKNOWN';
  const silentSeconds = (now - Date.parse(lastDataAt)) / 1000;
  return silentSeconds > env.METER_STALE_AFTER_SECONDS ? 'STALE' : 'ONLINE';
}

export async function runHealthScan(): Promise<void> {
  const now = Date.now();

  for (const gateway of await listGateways()) {
    const status = classifyGateway(gateway.lastSeenAt, now);
    if (status === gateway.status) continue;

    await setGatewayStatus(gateway.id, status);
    const silentFor = gateway.lastSeenAt ? Math.round((now - Date.parse(gateway.lastSeenAt)) / 1000) : null;

    if (status === 'OFFLINE') {
      log.warn('gateway is offline', {
        event: LogEvent.DEVICE_OFFLINE,
        gatewayUid: gateway.gatewayUid,
        silentSeconds: silentFor,
        threshold: env.GATEWAY_OFFLINE_AFTER_SECONDS,
      });
    } else if (status === 'DEGRADED') {
      log.warn('gateway data is stale', {
        event: LogEvent.DEVICE_STALE,
        gatewayUid: gateway.gatewayUid,
        silentSeconds: silentFor,
        threshold: env.GATEWAY_STALE_AFTER_SECONDS,
      });
    } else if (status === 'ONLINE') {
      log.info('gateway is reporting again', {
        event: LogEvent.DEVICE_RECOVERED,
        gatewayUid: gateway.gatewayUid,
        previous: gateway.status,
      });
    }

    bus.emit('gateway.status', {
      gatewayId: gateway.id,
      gatewayUid: gateway.gatewayUid,
      status,
      previous: gateway.status,
      lastSeenAt: gateway.lastSeenAt,
      lastDataAt: gateway.lastDataAt,
    });
  }

  for (const meter of await listMeters()) {
    const status = classifyMeter(meter.lastDataAt, now);
    if (status !== meter.status) {
      await setMeterStatus(meter.id, status);
      if (status === 'STALE') {
        log.warn('meter stopped reporting', {
          event: LogEvent.DEVICE_STALE,
          meterId: meter.id,
          meterUid: meter.meterUid,
          lastDataAt: meter.lastDataAt,
        });
      }
    }
  }

  await evaluateAbsenceRules();
  await expireCommands();
}

/** Retention sweep. Raw packets are forensic evidence, so this is opt-in. */
export async function runRetentionSweep(): Promise<void> {
  if (env.RAW_RETENTION_DAYS <= 0) return;
  const cutoff = new Date(Date.now() - env.RAW_RETENTION_DAYS * 86_400_000).toISOString();
  const removedRaw = await pruneRawMessages(cutoff);
  const removedFingerprints = await pruneFingerprints(cutoff);
  if (removedRaw || removedFingerprints) {
    log.info('retention sweep complete', {
      cutoff,
      rawRemoved: removedRaw,
      fingerprintsRemoved: removedFingerprints,
    });
  }
}

let timer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;

export function startHealthMonitor(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runHealthScan().catch((error: unknown) => log.error('health scan failed', { error }));
  }, env.HEALTH_SCAN_INTERVAL_SECONDS * 1000);
  timer.unref?.();

  retentionTimer = setInterval(() => {
    void runRetentionSweep().catch((error: unknown) => log.error('retention sweep failed', { error }));
  }, 6 * 60 * 60 * 1000);
  retentionTimer.unref?.();

  log.info('health monitor started', {
    scanSeconds: env.HEALTH_SCAN_INTERVAL_SECONDS,
    staleAfterSeconds: env.GATEWAY_STALE_AFTER_SECONDS,
    offlineAfterSeconds: env.GATEWAY_OFFLINE_AFTER_SECONDS,
  });
}

export function stopHealthMonitor(): void {
  if (timer) clearInterval(timer);
  if (retentionTimer) clearInterval(retentionTimer);
  timer = null;
  retentionTimer = null;
}

export async function ingestHealthSummary(): Promise<Record<string, number>> {
  return countByStatus();
}
