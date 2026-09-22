import { env } from '../../config/env.js';
import { bus } from '../../core/events.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import { parseOffsetMinutes, BUCKET_INTERVALS, bucketStart } from '../../core/time.js';
import type { Gateway } from '../../db/repositories/gateways.js';
import { bumpGatewayHealth, getGateway, touchGatewayData, touchGatewaySeen } from '../../db/repositories/gateways.js';
import { touchMeterData } from '../../db/repositories/meters.js';
import { loadMetricDefinitions } from '../../db/repositories/metrics.js';
import { recordFieldObservations } from '../../db/repositories/profiles.js';
import type { RawMessage, ProcessingStatus } from '../../db/repositories/rawMessages.js';
import { getRawMessage, markProcessed } from '../../db/repositories/rawMessages.js';
import { markDirty } from '../../db/repositories/rollups.js';
import { siteTimezone } from '../../db/repositories/sites.js';
import {
  insertTelemetry,
  recordFingerprint,
  valueAtOrBefore,
} from '../../db/repositories/telemetry.js';
import { advanceCounter, getCounterState, recordCounterEvent } from '../../db/repositories/energy.js';
import { parsePayload } from '../adapters/registry.js';
import type { NormalizedTelemetry, PayloadContext } from '../adapters/types.js';
import { resolveGateway } from '../devices/gateways.js';
import { parseTopic } from '../mqtt/topics.js';
import { DEFAULT_COUNTER_OPTIONS, computeCounterDelta } from './energy.js';
import { normalizePacket } from './normalization.js';

const log = createLogger('telemetry:processor');

const counterOptions = {
  rolloverCeilings: env.ENERGY_COUNTER_ROLLOVER_VALUES.map(Number).filter(Number.isFinite),
  maxDeltaPerHour: env.ENERGY_MAX_DELTA_PER_HOUR,
  backwardTolerance: Number(env.ENERGY_BACKWARD_TOLERANCE) || DEFAULT_COUNTER_OPTIONS.backwardTolerance,
};

export interface ProcessResult {
  status: ProcessingStatus;
  telemetry: NormalizedTelemetry[];
  duplicates: number;
  warnings: string[];
  error: string | null;
}

/**
 * Take one stored raw packet all the way to telemetry.
 *
 * This function is the reason an unrecognised payload cannot take the system
 * down (spec section 19): every failure mode ends in a status on the raw row
 * and a counter on the gateway, never in a thrown error escaping to the MQTT
 * consumer.
 */
export async function processRawMessage(rawMessageId: string): Promise<ProcessResult> {
  const raw = await getRawMessage(rawMessageId);
  if (!raw) {
    return { status: 'FAILED', telemetry: [], duplicates: 0, warnings: [], error: 'Raw message not found.' };
  }

  try {
    return await processRaw(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('processing failed', {
      event: LogEvent.PROCESSING_FAILED,
      rawMessageId,
      gatewayUid: raw.gatewayUid,
      error,
    });
    await markProcessed(raw.id, { status: 'FAILED', error: message });
    if (raw.gatewayId) await bumpGatewayHealth(raw.gatewayId, { failures: 1, error: message });
    return { status: 'FAILED', telemetry: [], duplicates: 0, warnings: [], error: message };
  }
}

async function processRaw(raw: RawMessage): Promise<ProcessResult> {
  const warnings: string[] = [];

  /* -- payload has to be JSON before anything else is possible ------------ */
  if (raw.payload === null || typeof raw.payload !== 'object') {
    log.warn('payload was not valid JSON', {
      event: LogEvent.INVALID_PAYLOAD,
      rawMessageId: raw.id,
      topic: raw.mqttTopic,
      bytes: raw.byteSize,
      preview: raw.payloadText.slice(0, 120),
    });
    await markProcessed(raw.id, { status: 'INVALID_PAYLOAD', error: 'Payload was not valid JSON.' });
    if (raw.gatewayId) await bumpGatewayHealth(raw.gatewayId, { malformed: 1, error: 'Invalid JSON payload' });
    return {
      status: 'INVALID_PAYLOAD',
      telemetry: [],
      duplicates: 0,
      warnings,
      error: 'Payload was not valid JSON.',
    };
  }

  const context: PayloadContext = {
    transport: raw.transport,
    topic: raw.mqttTopic,
    mqttClientId: raw.mqttClientId,
    assertedGatewayUid: raw.gatewayUid,
    receivedAt: raw.receivedAtServer,
    defaultOffsetMinutes: parseOffsetMinutes(env.DEFAULT_SOURCE_UTC_OFFSET) ?? 0,
  };

  /* -- first parse: discovers which gateway is talking -------------------- */
  let result = await parsePayload(raw.payload, context);
  const payloadUid = result.packets.find((packet) => packet.gatewayUid)?.gatewayUid ?? null;

  const resolution = await resolveGateway({
    payloadUid,
    assertedUid: raw.gatewayUid,
    verifiedUid: await verifiedSenderUid(raw),
    mqttClientId: raw.mqttClientId,
    topic: raw.mqttTopic,
    transport: raw.transport,
  });
  const gateway = resolution.gateway;

  if (resolution.rejected) {
    // Filed under the authenticated sender, not the gateway it claimed to be:
    // the raw log is evidence of who tried it.
    await markProcessed(raw.id, {
      status: 'UNKNOWN_GATEWAY',
      error: resolution.rejected,
      adapter: result.adapter,
      profileId: result.profileId,
    });
    return { status: 'UNKNOWN_GATEWAY', telemetry: [], duplicates: 0, warnings, error: resolution.rejected };
  }

  /* -- second parse: honour a profile pinned to this specific gateway ----- */
  if (gateway?.payloadProfileId && gateway.payloadProfileId !== result.profileId) {
    result = await parsePayload(raw.payload, context, { profileId: gateway.payloadProfileId });
  }

  log.debug('payload parsed', {
    event: LogEvent.MESSAGE_PARSED,
    rawMessageId: raw.id,
    adapter: result.adapter,
    profile: result.profileName,
    status: result.status,
    packets: result.packets.length,
  });
  warnings.push(...result.warnings);

  /* -- remember the payload's real field names for commissioning ---------- */
  const observationUid = gateway?.gatewayUid ?? payloadUid ?? raw.gatewayUid;
  if (observationUid && result.observedPaths.length) {
    await recordFieldObservations(observationUid, raw.mqttTopic, result.observedPaths);
  }

  if (!gateway) {
    await markProcessed(raw.id, {
      status: 'UNKNOWN_GATEWAY',
      error: 'Could not identify the sending gateway.',
      adapter: result.adapter,
      profileId: result.profileId,
      gatewayUid: payloadUid,
    });
    return {
      status: 'UNKNOWN_GATEWAY',
      telemetry: [],
      duplicates: 0,
      warnings,
      error: 'Could not identify the sending gateway.',
    };
  }

  await touchGatewaySeen(gateway.id, raw.receivedAtServer, raw.mqttTopic);
  await bumpGatewayHealth(gateway.id, { total: 1, lastPacketAt: raw.receivedAtServer });

  if (result.status === 'INVALID_PAYLOAD') {
    await markProcessed(raw.id, {
      status: 'INVALID_PAYLOAD',
      error: result.error ?? 'Adapter rejected the payload.',
      adapter: result.adapter,
      gatewayId: gateway.id,
      gatewayUid: gateway.gatewayUid,
    });
    await bumpGatewayHealth(gateway.id, { malformed: 1, error: result.error ?? null });
    return { status: 'INVALID_PAYLOAD', telemetry: [], duplicates: 0, warnings, error: result.error ?? null };
  }

  if (result.packets.length === 0) {
    await markProcessed(raw.id, {
      status: 'UNKNOWN_SCHEMA',
      error: result.error ?? 'No measurements could be extracted.',
      adapter: result.adapter,
      profileId: result.profileId,
      gatewayId: gateway.id,
      gatewayUid: gateway.gatewayUid,
    });
    await bumpGatewayHealth(gateway.id, { unknownSchema: 1, error: result.error ?? null });
    bus.emit('raw.unknownSchema', {
      id: raw.id,
      gatewayUid: gateway.gatewayUid,
      topic: raw.mqttTopic,
      reason: result.error ?? 'No measurements could be extracted.',
    });
    return { status: 'UNKNOWN_SCHEMA', telemetry: [], duplicates: 0, warnings, error: result.error ?? null };
  }

  /* -- normalise and persist every sample in the packet ------------------- */
  const saved: NormalizedTelemetry[] = [];
  let duplicates = 0;
  let skipped = 0;

  for (const packet of result.packets) {
    const outcome = await normalizePacket(packet, {
      gateway,
      receivedAt: raw.receivedAtServer,
      rawMessageId: raw.id,
      unverifiedMapping: result.status !== 'OK',
      source: result.adapter,
    });
    warnings.push(...outcome.warnings);

    if (!outcome.telemetry) {
      skipped += 1;
      if (outcome.skippedReason) warnings.push(outcome.skippedReason);
      continue;
    }

    const isDuplicate = await recordFingerprint({
      fingerprint: outcome.telemetry.fingerprint,
      gatewayUid: gateway.gatewayUid,
      meterId: outcome.telemetry.meterId,
      slaveId: outcome.telemetry.slaveId,
      sourceTime: outcome.telemetry.sourceTimestamp,
      rawMessageId: raw.id,
    });

    if (isDuplicate) {
      duplicates += 1;
      log.info('packet already ingested, skipping', {
        event: LogEvent.DUPLICATE_PACKET,
        gatewayUid: gateway.gatewayUid,
        meterId: outcome.telemetry.meterId,
        sourceTimestamp: outcome.telemetry.sourceTimestamp,
        fingerprint: outcome.telemetry.fingerprint.slice(0, 16),
      });
      bus.emit('telemetry.duplicate', {
        gatewayUid: gateway.gatewayUid,
        meterId: outcome.telemetry.meterId,
        fingerprint: outcome.telemetry.fingerprint,
      });
      continue;
    }

    await persistTelemetry(outcome.telemetry, gateway, raw.id);
    saved.push(outcome.telemetry);
  }

  await bumpGatewayHealth(gateway.id, {
    ok: saved.length ? 1 : 0,
    duplicate: duplicates,
    buffered: saved.filter((entry) => entry.isBuffered).length,
    lastDataAt: saved.length ? raw.receivedAtServer : null,
    lagSeconds: saved.length ? Math.max(...saved.map((entry) => entry.lagSeconds)) : null,
  });

  const status: ProcessingStatus =
    saved.length === 0
      ? duplicates > 0
        ? 'DUPLICATE'
        : 'UNKNOWN_SCHEMA'
      : result.status === 'OK' && skipped === 0
        ? 'OK'
        : 'PARTIAL';

  await markProcessed(raw.id, {
    status,
    error: status === 'OK' ? null : (result.error ?? warnings[0] ?? null),
    adapter: result.adapter,
    profileId: result.profileId,
    sampleCount: saved.reduce((total, entry) => total + entry.samples.length, 0),
    gatewayId: gateway.id,
    gatewayUid: gateway.gatewayUid,
  });

  return { status, telemetry: saved, duplicates, warnings, error: null };
}

/**
 * Write one normalised reading: telemetry rows, cumulative-counter maintenance,
 * rollup invalidation, then the internal event the realtime hub rides on.
 */
async function persistTelemetry(
  telemetry: NormalizedTelemetry,
  gateway: Gateway,
  rawMessageId: string,
): Promise<void> {
  const definitions = await loadMetricDefinitions();

  /* -- cumulative counters are differenced against the reading that
        precedes this one *in measurement order*, so a late arrival is
        compared with its true neighbour rather than with whatever happened
        to be stored last. -------------------------------------------------- */
  for (const sample of telemetry.samples) {
    const definition = definitions.get(sample.metric);
    if (definition?.kind !== 'cumulative') continue;

    const previousRow = await valueAtOrBefore(
      telemetry.meterId,
      sample.metric,
      new Date(Date.parse(telemetry.timestamp) - 1).toISOString(),
    );
    const previous = previousRow
      ? { value: previousRow.value, time: previousRow.time }
      : await fallbackCounterState(telemetry.meterId, sample.metric);

    const step = computeCounterDelta(previous, { value: sample.value, time: telemetry.timestamp }, counterOptions);

    if (step.event) {
      log.warn('cumulative counter anomaly', {
        event:
          step.event === 'ROLLOVER'
            ? LogEvent.COUNTER_ROLLOVER_DETECTED
            : step.event === 'SPIKE'
              ? LogEvent.VALUE_SPIKE_DETECTED
              : LogEvent.COUNTER_RESET_DETECTED,
        meterId: telemetry.meterId,
        metric: sample.metric,
        previous: previous?.value ?? null,
        current: sample.value,
        note: step.note,
      });
      await recordCounterEvent({
        meterId: telemetry.meterId,
        metric: sample.metric,
        eventType: step.event,
        previousValue: previous?.value ?? null,
        newValue: sample.value,
        deltaApplied: step.delta,
        sourceTime: telemetry.sourceTimestamp,
        note: step.note,
      });
      // Flag the stored sample so the dashboard can show why a step looks odd,
      // without altering the value the meter actually reported.
      sample.quality = step.quality;
    }

    await advanceCounter({
      meterId: telemetry.meterId,
      metric: sample.metric,
      lastValue: sample.value,
      lastTime: telemetry.timestamp,
      accumulatedDelta: step.delta,
      resetIncrement: step.event === 'RESET' ? 1 : 0,
      rolloverIncrement: step.event === 'ROLLOVER' ? 1 : 0,
    });
  }

  const inserted = await insertTelemetry(
    telemetry.samples.map((sample) => ({
      time: telemetry.timestamp,
      meterId: telemetry.meterId,
      metric: sample.metric,
      value: sample.value,
      gatewayId: telemetry.gatewayId,
      siteId: telemetry.siteId,
      unit: sample.unit,
      quality: sample.quality,
      sourceTimestamp: telemetry.sourceTimestamp,
      serverReceivedAt: telemetry.serverReceivedAt,
      isBuffered: telemetry.isBuffered,
      rawMessageId,
      fingerprint: telemetry.fingerprint,
    })),
  );

  log.info('telemetry stored', {
    event: LogEvent.TELEMETRY_SAVED,
    gatewayUid: telemetry.gatewayUid,
    meterId: telemetry.meterId,
    metrics: telemetry.samples.length,
    inserted,
    at: telemetry.timestamp,
    buffered: telemetry.isBuffered,
    lagSeconds: Math.round(telemetry.lagSeconds),
  });

  /* -- invalidate every rollup bucket this reading falls into -------------- */
  const timezone = await siteTimezone(telemetry.siteId);
  await markDirty(
    BUCKET_INTERVALS.map((interval) => ({
      bucket: interval,
      meterId: telemetry.meterId,
      bucketStart: bucketStart(telemetry.timestamp, interval, timezone).toISOString(),
    })),
  );

  await touchGatewayData(gateway.id, telemetry.serverReceivedAt);
  await touchMeterData(telemetry.meterId, telemetry.timestamp);

  bus.emit('telemetry.saved', {
    gatewayUid: telemetry.gatewayUid,
    gatewayId: telemetry.gatewayId,
    meterId: telemetry.meterId,
    siteId: telemetry.siteId,
    telemetry,
    samples: telemetry.samples,
    buffered: telemetry.isBuffered,
  });
}

/** Counter state is the fallback baseline when no earlier row exists. */
async function fallbackCounterState(
  meterId: string,
  metric: string,
): Promise<{ value: number; time: string } | null> {
  const state = await getCounterState(meterId, metric);
  if (!state || state.lastValue === null || !state.lastTime) return null;
  return { value: state.lastValue, time: state.lastTime };
}

/**
 * The gateway the transport has proven sent this packet, if any.
 *
 * On our own MQTT namespace the topic's gateway segment is proof: the broker
 * only lets a credential publish under its own id. An HTTP packet carries the
 * gateway resolved from its device token. A vendor-shaped topic or an
 * unauthenticated header proves nothing, so those return null and the older,
 * hint-based resolution applies.
 */
async function verifiedSenderUid(raw: RawMessage): Promise<string | null> {
  if (raw.transport === 'MQTT' && raw.mqttTopic) {
    const parsed = parseTopic(raw.mqttTopic);
    return parsed.canonical ? parsed.gatewayId : null;
  }
  if (raw.transport === 'HTTP' && raw.gatewayId) {
    return (await getGateway(raw.gatewayId))?.gatewayUid ?? null;
  }
  return null;
}
