import type { RegisterMapEntry } from '../../../db/repositories/meters.js';
import type { MapOptions, MappedValue, MappingResult } from '../../modbus/registerMap.js';
import { applyRegisterMap } from '../../modbus/registerMap.js';
import type { ParsedPacket } from '../types.js';
import { suggestMetric } from './discovery.js';

/**
 * Vendor keys in, platform metric keys out.
 *
 * Order of authority, strongest first:
 *   1. `source_key` on a register-map row  - configured by a human
 *   2. the metric key itself               - the payload already speaks our language
 *   3. alias inference                     - commissioning only, flagged ESTIMATED
 *
 * Step 3 exists so the very first packets from a new gateway are visible on the
 * dashboard before anyone has written a register map, and it is deliberately
 * marked so nobody mistakes an inferred identity for a verified one.
 */

export interface MapPacketOptions extends MapOptions {
  registerEntries: RegisterMapEntry[];
  /** Enable alias inference. Off once the gateway has a verified profile. */
  allowAliasInference: boolean;
}

export function mapPacket(packet: ParsedPacket, options: MapPacketOptions): MappingResult {
  const result = applyRegisterMap(packet, options.registerEntries, {
    passthroughUnmapped: options.passthroughUnmapped,
    knownMetrics: options.knownMetrics,
    registerEncoding: options.registerEncoding,
  });

  if (!options.allowAliasInference || result.unmappedKeys.length === 0) return result;

  const claimed = new Set(result.values.map((value) => value.metricKey));
  const stillUnmapped: string[] = [];
  const inferred: MappedValue[] = [];

  for (const key of result.unmappedKeys) {
    const metric = suggestMetric(key);
    const raw = packet.values[key];
    const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : null;

    if (!metric || numeric === null || !Number.isFinite(numeric) || claimed.has(metric)) {
      stillUnmapped.push(key);
      continue;
    }
    if (options.knownMetrics && !options.knownMetrics.has(metric)) {
      stillUnmapped.push(key);
      continue;
    }

    claimed.add(metric);
    inferred.push({
      metricKey: metric,
      value: numeric,
      unit: null,
      // ESTIMATED = the number is real, the metric it was filed under is a guess.
      quality: 'ESTIMATED',
      registerAddress: null,
      sourceKey: key,
    });
  }

  return {
    values: [...result.values, ...inferred],
    unmappedKeys: stillUnmapped,
    unmappedRegisters: result.unmappedRegisters,
    warnings: inferred.length
      ? [
          ...result.warnings,
          'Inferred ' + inferred.length + ' metric(s) from key names (' +
            inferred.map((value) => value.sourceKey + ' -> ' + value.metricKey).join(', ') +
            '). Confirm these against the meter register table and record them in the register map.',
        ]
      : result.warnings,
  };
}
