import { env } from '../../config/env.js';
import { sampleFingerprint } from '../../core/hash.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import { parseOffsetMinutes } from '../../core/time.js';
import type { Gateway } from '../../db/repositories/gateways.js';
import type { Meter, RegisterMapEntry } from '../../db/repositories/meters.js';
import { loadMetricDefinitions } from '../../db/repositories/metrics.js';
import { getRegisterMap } from '../modbus/registerMap.js';
import { mapPacket } from '../adapters/veritek/mapper.js';
import type { NormalizedSample, NormalizedTelemetry, ParsedPacket, Quality } from '../adapters/types.js';
import { resolveMeter } from '../devices/meters.js';
import { assessValue } from './quality.js';

const log = createLogger('telemetry:normalize');

/**
 * Packet in our terms, meter identified, values on platform metric keys.
 *
 * The timestamp decisions live here, and they are the ones that make buffered
 * data behave (spec sections 9 and 10):
 *
 *   - the gateway's own measurement time wins whenever it is credible;
 *   - it is stored next to, never instead of, the server receipt time;
 *   - an implausible RTC reading falls back to server time but the device's
 *     claim is still recorded, so a clock fault is visible rather than silently
 *     scattering readings across history.
 */

export interface NormalizeContext {
  gateway: Gateway;
  receivedAt: string;
  rawMessageId: string | null;
  /** Adapter reported UNKNOWN_SCHEMA - allow alias inference for visibility. */
  unverifiedMapping: boolean;
  source: string;
}

export interface NormalizeOutcome {
  telemetry: NormalizedTelemetry | null;
  meter: Meter | null;
  warnings: string[];
  unmappedKeys: string[];
  unmappedRegisters: number[];
  skippedReason: string | null;
}

export async function normalizePacket(
  packet: ParsedPacket,
  context: NormalizeContext,
): Promise<NormalizeOutcome> {
  const warnings: string[] = [];

  /* -- 1. which meter is this? -------------------------------------------- */
  const resolution = await resolveMeter(context.gateway, packet.slaveId, packet.meterUid);
  if (!resolution.meter) {
    return {
      telemetry: null,
      meter: null,
      warnings,
      unmappedKeys: [],
      unmappedRegisters: [],
      skippedReason:
        'No meter matches gateway ' + context.gateway.gatewayUid +
        ' slave ' + (packet.slaveId ?? 'n/a') + ' (' + (resolution.reason ?? 'unmapped') + ').',
    };
  }
  const meter = resolution.meter;

  log.debug('meter identified', {
    event: LogEvent.METER_IDENTIFIED,
    gatewayUid: context.gateway.gatewayUid,
    meterId: meter.id,
    meterUid: meter.meterUid,
    slaveId: packet.slaveId,
    provisioned: resolution.provisioned,
  });

  /* -- 2. when was it measured? ------------------------------------------- */
  const timing = resolveTiming(packet, context);
  if (timing.warning) warnings.push(timing.warning);

  /* -- 3. vendor keys and raw registers to platform metrics --------------- */
  const definitions = await loadMetricDefinitions();
  const registerEntries: RegisterMapEntry[] = meter.meterModelId
    ? await getRegisterMap(meter.meterModelId)
    : [];

  if (registerEntries.length === 0 && packet.registerBlocks.length > 0) {
    warnings.push(
      'Gateway sent raw Modbus registers but meter ' + meter.meterUid +
        ' has no register map, so nothing could be decoded. Assign a meter model.',
    );
  }

  const mapped = mapPacket(packet, {
    registerEntries,
    knownMetrics: new Set(definitions.keys()),
    allowAliasInference: context.unverifiedMapping || registerEntries.length === 0,
    passthroughUnmapped: true,
    registerEncoding: 'words',
  });
  warnings.push(...mapped.warnings);

  /* -- 4. plausibility flags ---------------------------------------------- */
  const samples: NormalizedSample[] = [];
  const measurements: Record<string, number> = {};

  for (const value of mapped.values) {
    const definition = definitions.get(value.metricKey) ?? null;
    const assessment = assessValue(value.value, definition, value.quality);
    if (assessment.reason) warnings.push(value.metricKey + ': ' + assessment.reason);

    samples.push({
      metric: value.metricKey,
      value: value.value,
      unit: value.unit ?? definition?.unit ?? null,
      quality: assessment.quality as Quality,
      registerAddress: value.registerAddress ?? null,
      sourceKey: value.sourceKey ?? null,
    });
    measurements[value.metricKey] = value.value;
  }

  if (samples.length === 0) {
    return {
      telemetry: null,
      meter,
      warnings,
      unmappedKeys: mapped.unmappedKeys,
      unmappedRegisters: mapped.unmappedRegisters,
      skippedReason: 'Packet produced no recognised measurements.',
    };
  }

  /* -- 5. idempotency key -------------------------------------------------- */
  const fingerprint = sampleFingerprint({
    gatewayUid: context.gateway.gatewayUid,
    slaveId: packet.slaveId,
    sourceTimestamp: packet.sourceTimestamp,
    measurements,
  });

  const telemetry: NormalizedTelemetry = {
    gatewayId: context.gateway.id,
    gatewayUid: context.gateway.gatewayUid,
    meterId: meter.id,
    meterUid: meter.meterUid,
    siteId: meter.siteId ?? context.gateway.siteId ?? null,
    slaveId: packet.slaveId,
    timestamp: timing.timestamp,
    sourceTimestamp: packet.sourceTimestamp,
    serverReceivedAt: context.receivedAt,
    source: context.source,
    isBuffered: timing.isBuffered,
    lagSeconds: timing.lagSeconds,
    measurements,
    samples,
    fingerprint,
    unmappedKeys: mapped.unmappedKeys,
  };

  return {
    telemetry,
    meter,
    warnings,
    unmappedKeys: mapped.unmappedKeys,
    unmappedRegisters: mapped.unmappedRegisters,
    skippedReason: null,
  };
}

interface Timing {
  /** Authoritative measurement time, UTC ISO. */
  timestamp: string;
  isBuffered: boolean;
  lagSeconds: number;
  warning: string | null;
}

/**
 * Decide the measurement time for a packet.
 *
 * Arrival time is explicitly NOT assumed to be measurement time: the gateway
 * stores readings through a cellular outage and uploads them together, so three
 * readings measured a minute apart can all arrive in the same second.
 */
export function resolveTiming(packet: ParsedPacket, context: NormalizeContext): Timing {
  const receivedMs = Date.parse(context.receivedAt);
  const source = packet.sourceTimestamp;

  if (!source) {
    return {
      timestamp: context.receivedAt,
      isBuffered: packet.bufferedFlag === true,
      lagSeconds: 0,
      warning: 'Packet carried no timestamp; server receipt time was used as the measurement time.',
    };
  }

  const sourceMs = Date.parse(source);
  const lagSeconds = (receivedMs - sourceMs) / 1000;

  if (lagSeconds < -env.MAX_FUTURE_SKEW_SECONDS) {
    log.warn('device clock is ahead of the server', {
      event: LogEvent.CLOCK_SKEW_DETECTED,
      gatewayUid: context.gateway.gatewayUid,
      sourceTimestamp: source,
      receivedAt: context.receivedAt,
      skewSeconds: Math.round(-lagSeconds),
    });
    return {
      timestamp: context.receivedAt,
      isBuffered: false,
      lagSeconds: 0,
      warning:
        'Device timestamp ' + source + ' is ' + Math.round(-lagSeconds) +
        's in the future; server time used instead. Check the gateway RTC.',
    };
  }

  if (lagSeconds > env.MAX_PAST_SKEW_SECONDS) {
    log.warn('device timestamp is implausibly old', {
      event: LogEvent.CLOCK_SKEW_DETECTED,
      gatewayUid: context.gateway.gatewayUid,
      sourceTimestamp: source,
      lagSeconds: Math.round(lagSeconds),
    });
    return {
      timestamp: context.receivedAt,
      isBuffered: false,
      lagSeconds: 0,
      warning:
        'Device timestamp ' + source + ' is older than the configured limit (' +
        env.MAX_PAST_SKEW_SECONDS + 's); server time used instead. Check the gateway RTC.',
    };
  }

  const isBuffered = packet.bufferedFlag === true || lagSeconds > env.BUFFERED_THRESHOLD_SECONDS;
  if (isBuffered) {
    log.info('reading arrived later than it was measured', {
      event: LogEvent.BUFFERED_DATA_RECEIVED,
      gatewayUid: context.gateway.gatewayUid,
      sourceTimestamp: source,
      lagSeconds: Math.round(lagSeconds),
    });
  }

  return {
    timestamp: source,
    isBuffered,
    lagSeconds: Math.max(lagSeconds, 0),
    warning:
      packet.timestampHadOffset
        ? null
        : 'Device timestamp carried no timezone; interpreted as UTC' +
          formatOffset(packet.assumedOffsetMinutes ?? parseOffsetMinutes(env.DEFAULT_SOURCE_UTC_OFFSET) ?? 0) + '.',
  };
}

function formatOffset(minutes: number): string {
  if (minutes === 0) return '';
  const sign = minutes > 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
}
