import { createLogger } from '../../core/logger.js';
import { LogEvent } from '../../core/logEvents.js';
import type { RegisterMapEntry } from '../../db/repositories/meters.js';
import { listRegisterMap } from '../../db/repositories/meters.js';
import type { ParsedPacket, Quality } from '../adapters/types.js';
import { DecodeError, coerceToWords, decodeRegisters, defaultRegisterLength } from './decoder.js';

const log = createLogger('modbus:registerMap');

/**
 * Applies a meter model's register map to whatever the gateway sent.
 *
 * Two shapes have to work, because we do not yet know which one the Veritek
 * unit produces:
 *
 *   1. the gateway already polled Modbus and sends named engineering values -
 *      the map is then used as an alias table (`source_key`) plus optional
 *      scale/unit correction;
 *   2. the gateway forwards raw register words - the map does the full
 *      address/datatype/endianness/scale decode.
 *
 * Both paths land on the same platform metric keys.
 */

export interface MappedValue {
  metricKey: string;
  value: number;
  unit: string | null;
  quality: Quality;
  registerAddress: number | null;
  sourceKey: string | null;
}

export interface MappingResult {
  values: MappedValue[];
  /** Keys present in the payload that no register map claims. */
  unmappedKeys: string[];
  /** Register addresses present in the payload that no register map claims. */
  unmappedRegisters: number[];
  warnings: string[];
}

/** In-memory cache; invalidated whenever a register map row is edited. */
const mapCache = new Map<string, { at: number; entries: RegisterMapEntry[] }>();
const CACHE_TTL_MS = 30_000;

export async function getRegisterMap(meterModelId: string): Promise<RegisterMapEntry[]> {
  const cached = mapCache.get(meterModelId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.entries;
  const entries = (await listRegisterMap(meterModelId)).filter((entry) => entry.enabled);
  mapCache.set(meterModelId, { at: Date.now(), entries });
  return entries;
}

export function invalidateRegisterMapCache(meterModelId?: string): void {
  if (meterModelId) mapCache.delete(meterModelId);
  else mapCache.clear();
}

/** Loosen key comparison: `Voltage_L1`, `voltage-l1` and `voltageL1` all match. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface KeyIndex {
  byMetric: Map<string, RegisterMapEntry>;
  bySourceKey: Map<string, RegisterMapEntry>;
  byAddress: Map<number, RegisterMapEntry>;
}

function indexEntries(entries: RegisterMapEntry[]): KeyIndex {
  const byMetric = new Map<string, RegisterMapEntry>();
  const bySourceKey = new Map<string, RegisterMapEntry>();
  const byAddress = new Map<number, RegisterMapEntry>();

  for (const entry of entries) {
    byMetric.set(normaliseKey(entry.metricKey), entry);
    if (entry.sourceKey) bySourceKey.set(normaliseKey(entry.sourceKey), entry);
    byAddress.set(entry.registerAddress, entry);
  }
  return { byMetric, bySourceKey, byAddress };
}

export interface MapOptions {
  /**
   * Keep numeric values whose key matches no register-map row, using the key
   * itself as the metric. Useful during commissioning so the first packets are
   * visible before the map is filled in; noisy afterwards.
   */
  passthroughUnmapped?: boolean;
  /** Metric keys the platform knows about, used to validate passthrough keys. */
  knownMetrics?: Set<string>;
  registerEncoding?: 'words' | 'bytes';
}

/**
 * Turn one parsed packet into platform metrics using `entries`.
 *
 * An empty register map is not an error: with `passthroughUnmapped` the decoded
 * values still flow through under their own names, which is exactly what is
 * needed on day one when the meter's register table has not arrived yet.
 */
export function applyRegisterMap(
  packet: ParsedPacket,
  entries: RegisterMapEntry[],
  options: MapOptions = {},
): MappingResult {
  const index = indexEntries(entries);
  const values: MappedValue[] = [];
  const unmappedKeys: string[] = [];
  const unmappedRegisters: number[] = [];
  const warnings: string[] = [];
  const claimed = new Set<string>();

  /* -- 1. values the gateway already decoded, keyed by name ---------------- */
  for (const [key, rawValue] of Object.entries(packet.values)) {
    const numeric = toNumber(rawValue);
    if (numeric === null) continue;

    const normalised = normaliseKey(key);
    const entry = index.bySourceKey.get(normalised) ?? index.byMetric.get(normalised);

    if (entry) {
      if (claimed.has(entry.metricKey)) continue;
      claimed.add(entry.metricKey);
      values.push({
        metricKey: entry.metricKey,
        // A pre-decoded value is already in engineering units, so the register
        // map's scale is applied only when it was explicitly set for this path.
        value: numeric * (entry.scale ?? 1) + (entry.valueOffset ?? 0),
        unit: entry.unit,
        quality: 'GOOD',
        registerAddress: entry.registerAddress,
        sourceKey: key,
      });
      continue;
    }

    if (options.passthroughUnmapped) {
      const candidate = normaliseKey(key);
      const known = options.knownMetrics
        ? [...options.knownMetrics].find((metric) => normaliseKey(metric) === candidate)
        : undefined;
      if (known) {
        if (claimed.has(known)) continue;
        claimed.add(known);
        values.push({
          metricKey: known,
          value: numeric,
          unit: null,
          quality: 'GOOD',
          registerAddress: null,
          sourceKey: key,
        });
        continue;
      }
    }
    unmappedKeys.push(key);
  }

  /* -- 2. sparse address/value pairs -------------------------------------- */
  for (const pair of packet.registerValues) {
    const entry = index.byAddress.get(pair.address);
    if (!entry) {
      unmappedRegisters.push(pair.address);
      continue;
    }
    if (claimed.has(entry.metricKey)) continue;
    try {
      const decoded = decodeRegisters([pair.value], {
        datatype: entry.datatype,
        byteOrder: entry.byteOrder,
        wordOrder: entry.wordOrder,
        registerLength: 1,
        scale: entry.scale,
        offset: entry.valueOffset,
        bitMask: entry.bitMask,
        bitOffset: entry.bitOffset,
      });
      claimed.add(entry.metricKey);
      values.push({
        metricKey: entry.metricKey,
        value: decoded.value,
        unit: entry.unit,
        quality: 'GOOD',
        registerAddress: entry.registerAddress,
        sourceKey: null,
      });
    } catch (error) {
      warnings.push(describeDecodeFailure(entry, error));
    }
  }

  /* -- 3. contiguous raw register blocks ---------------------------------- */
  for (const block of packet.registerBlocks) {
    const words = coerceToWords(block.words ?? block.hex, options.registerEncoding ?? 'words');
    if (!words) {
      warnings.push('Register block at ' + block.startAddress + ' was not decodable register data.');
      continue;
    }

    for (const entry of entries) {
      if (claimed.has(entry.metricKey)) continue;
      if (block.functionCode != null && entry.functionCode !== block.functionCode) continue;

      const length = entry.registerLength || defaultRegisterLength(entry.datatype);
      const start = entry.registerAddress - block.startAddress;
      if (start < 0 || start + length > words.length) continue;

      try {
        const decoded = decodeRegisters(words.slice(start, start + length), {
          datatype: entry.datatype,
          byteOrder: entry.byteOrder,
          wordOrder: entry.wordOrder,
          registerLength: length,
          scale: entry.scale,
          offset: entry.valueOffset,
          bitMask: entry.bitMask,
          bitOffset: entry.bitOffset,
        });
        claimed.add(entry.metricKey);
        values.push({
          metricKey: entry.metricKey,
          value: decoded.value,
          unit: entry.unit,
          quality: 'GOOD',
          registerAddress: entry.registerAddress,
          sourceKey: null,
        });
      } catch (error) {
        warnings.push(describeDecodeFailure(entry, error));
      }
    }
  }

  if (unmappedKeys.length) {
    log.debug('payload contained keys with no register map entry', {
      event: LogEvent.UNKNOWN_REGISTER,
      keys: unmappedKeys.slice(0, 20),
    });
  }

  return { values, unmappedKeys, unmappedRegisters, warnings };
}

function describeDecodeFailure(entry: RegisterMapEntry, error: unknown): string {
  const reason = error instanceof DecodeError ? error.message : String(error);
  return 'Could not decode ' + entry.metricKey + ' at register ' + entry.registerAddress + ': ' + reason;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
