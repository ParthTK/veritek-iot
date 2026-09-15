import { parseOffsetMinutes, parseTimestamp } from '../../core/time.js';
import type { TimestampFormat } from '../../core/time.js';
import type { ProfileSpec } from '../../db/repositories/profiles.js';
import { firstHit, getByPathLoose } from './jsonPath.js';
import type { ParsedPacket, RawRegisterBlock } from './types.js';

/**
 * The generic, configuration-driven extraction engine.
 *
 * A `ProfileSpec` row says where each field lives inside an arbitrary JSON
 * document; this file does the reading. It has no idea which vendor it is
 * looking at, which is the whole point: mapping a new gateway is a database
 * row, not a code change (spec sections 4, 19 and 26).
 */

export interface ProfileParseOptions {
  /** Offset applied to timestamps that carry no timezone information. */
  defaultOffsetMinutes: number;
  /** Gateway uid asserted by the transport, used when the body omits one. */
  assertedGatewayUid?: string | null;
}

export interface ProfileParseResult {
  packets: ParsedPacket[];
  warnings: string[];
}

/** Fields that describe the packet rather than measure anything. */
const CONTROL_KEY_PATTERN =
  /^(gateway|device|dev|client|imei|serial|sn|uid|id|slave|unit|addr|address|meter|ts|time|timestamp|datetime|date|epoch|seq|sequence|frame|msgid|buffered|cached|offline|status|state|rssi|csq|signal|fw|firmware|version|type|topic|qos|retain|protocol|count|len|length)$/i;

export function parseWithProfile(
  payload: unknown,
  spec: ProfileSpec,
  options: ProfileParseOptions,
): ProfileParseResult {
  const warnings: string[] = [];
  const documents = expandBatch(payload, spec, warnings);
  const packets: ParsedPacket[] = [];

  for (const document of documents) {
    const packet = parseDocument(document.node, document.root, spec, options, warnings);
    if (packet) packets.push(packet);
  }
  return { packets, warnings };
}

interface BatchDocument {
  /** The per-sample object. */
  node: unknown;
  /** The enclosing document, so packet-level fields stay reachable. */
  root: unknown;
}

/**
 * Split a payload into individual samples.
 *
 * A gateway flushing its offline buffer will usually send an array of readings
 * in one packet; each element has to become its own telemetry row carrying its
 * own measurement time (spec section 9).
 */
function expandBatch(payload: unknown, spec: ProfileSpec, warnings: string[]): BatchDocument[] {
  if (Array.isArray(payload)) {
    return payload.map((node) => ({ node, root: node }));
  }

  const hit = firstHit(payload, spec.batchPaths);
  if (hit && Array.isArray(hit.value)) {
    if (hit.value.length === 0) warnings.push('Batch array at ' + hit.path + ' was empty.');
    return hit.value.map((node) => ({ node, root: payload }));
  }
  return [{ node: payload, root: payload }];
}

function parseDocument(
  node: unknown,
  root: unknown,
  spec: ProfileSpec,
  options: ProfileParseOptions,
  warnings: string[],
): ParsedPacket | null {
  if (node === null || typeof node !== 'object') return null;

  // Sample-level fields win; packet-level fields (gateway id, timestamp on the
  // envelope) are the fallback.
  const read = (paths: string[] | undefined): unknown => {
    const local = firstHit(node, paths);
    if (local) return local.value;
    if (node === root) return undefined;
    return firstHit(root, paths)?.value;
  };

  const gatewayRaw = read(spec.gatewayIdPaths);
  const gatewayUid = toIdString(gatewayRaw) ?? options.assertedGatewayUid ?? null;
  const meterUid = toIdString(read(spec.meterIdPaths));
  const slaveId = toInteger(read(spec.slaveIdPaths));

  const assumedOffset =
    parseOffsetMinutes(spec.assumeUtcOffset ?? null) ?? options.defaultOffsetMinutes;
  const timestampRaw = read(spec.timestampPaths);
  const parsedTime = parseTimestamp(
    timestampRaw,
    (spec.timestampFormat as TimestampFormat) ?? 'auto',
    assumedOffset,
  );
  if (timestampRaw !== undefined && timestampRaw !== null && !parsedTime) {
    warnings.push('Could not interpret timestamp value ' + JSON.stringify(timestampRaw).slice(0, 80) + '.');
  }

  const values = collectMeasurements(node, root, spec, warnings);
  const registerBlocks = collectRegisterBlocks(node, spec);
  const registerValues = collectRegisterValues(node, spec);

  return {
    gatewayUid,
    meterUid,
    slaveId,
    sourceTimestamp: parsedTime ? parsedTime.date.toISOString() : null,
    timestampFormat: parsedTime ? parsedTime.format : null,
    timestampHadOffset: parsedTime ? parsedTime.hadOffset : false,
    assumedOffsetMinutes: parsedTime?.assumedOffsetMinutes ?? null,
    values,
    registerBlocks,
    registerValues,
    sequence: toInteger(read(spec.sequencePaths)),
    bufferedFlag: toBooleanOrNull(read(spec.bufferedFlagPaths)),
    extra: {},
  };
}

/**
 * Pull the name/value measurements out of a document and translate the vendor's
 * key names into platform metric keys via `spec.keyMap`.
 */
function collectMeasurements(
  node: unknown,
  root: unknown,
  spec: ProfileSpec,
  warnings: string[],
): Record<string, number | string | boolean | null> {
  let container: unknown = null;

  const hit = firstHit(node, spec.measurementPaths) ?? (node === root ? null : firstHit(root, spec.measurementPaths));
  if (hit) container = hit.value;

  // With no declared location, treat the document's own scalar fields as the
  // measurements and let the control-key filter drop the envelope fields.
  if (container === null || container === undefined) container = node;

  if (Array.isArray(container)) {
    // A list of {name, value} objects is a common alternative to an object map.
    const out: Record<string, number | string | boolean | null> = {};
    for (const entry of container) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const name = toIdString(record.name ?? record.key ?? record.metric ?? record.tag ?? record.id);
      if (!name) continue;
      const value = record.value ?? record.val ?? record.v;
      out[name] = toScalar(value);
    }
    return applyKeyMap(out, spec);
  }

  if (!container || typeof container !== 'object') {
    warnings.push('No measurement object found in payload.');
    return {};
  }

  const out: Record<string, number | string | boolean | null> = {};
  const declared = Boolean(hit);
  for (const [key, value] of Object.entries(container as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object') continue;
    // Only filter out envelope fields when we are scraping the document itself;
    // inside a declared measurement object, every key is a measurement.
    if (!declared && CONTROL_KEY_PATTERN.test(key)) continue;
    out[key] = toScalar(value);
  }
  return applyKeyMap(out, spec);
}

function applyKeyMap(
  values: Record<string, number | string | boolean | null>,
  spec: ProfileSpec,
): Record<string, number | string | boolean | null> {
  const keyMap = spec.keyMap;
  const transforms = spec.transforms;
  if (!keyMap && !transforms) return values;

  const lookup = new Map<string, string>();
  for (const [from, to] of Object.entries(keyMap ?? {})) {
    lookup.set(from.toLowerCase().replace(/[^a-z0-9]/g, ''), to);
  }

  const out: Record<string, number | string | boolean | null> = {};
  for (const [key, value] of Object.entries(values)) {
    const mapped = lookup.get(key.toLowerCase().replace(/[^a-z0-9]/g, '')) ?? key;
    const transform = transforms?.[mapped] ?? transforms?.[key];
    if (transform && typeof value === 'number') {
      out[mapped] = value * (transform.scale ?? 1) + (transform.offset ?? 0);
    } else {
      out[mapped] = value;
    }
  }
  return out;
}

function collectRegisterBlocks(node: unknown, spec: ProfileSpec): RawRegisterBlock[] {
  const hit = firstHit(node, spec.registerBlockPaths);
  if (!hit) return [];

  const entries = Array.isArray(hit.value) ? hit.value : [hit.value];
  const blocks: RawRegisterBlock[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const startAddress = toInteger(
      record.start ?? record.startAddress ?? record.address ?? record.addr ?? record.register,
    );
    if (startAddress === null) continue;

    const words = record.words ?? record.data ?? record.values ?? record.registers;
    blocks.push({
      functionCode: toInteger(record.fc ?? record.functionCode ?? record.function),
      registerType: typeof record.type === 'string' ? record.type : null,
      startAddress,
      words: Array.isArray(words) ? words.map((word) => Number(word)) : undefined,
      hex: typeof words === 'string' ? words : typeof record.hex === 'string' ? record.hex : undefined,
    });
  }
  return blocks;
}

function collectRegisterValues(node: unknown, spec: ProfileSpec): Array<{ address: number; value: number }> {
  const hit = firstHit(node, spec.registerArrayPaths);
  if (!hit) return [];

  const addressKey = spec.registerAddressKey ?? 'address';
  const valueKey = spec.registerValueKey ?? 'value';
  const out: Array<{ address: number; value: number }> = [];

  if (Array.isArray(hit.value)) {
    for (const entry of hit.value) {
      if (!entry || typeof entry !== 'object') continue;
      const address = toInteger(getByPathLoose(entry, addressKey));
      const value = toNumber(getByPathLoose(entry, valueKey));
      if (address !== null && value !== null) out.push({ address, value });
    }
    return out;
  }

  // ...or an object keyed by register address: {"40001": 2315, "40003": 132}
  if (hit.value && typeof hit.value === 'object') {
    for (const [key, value] of Object.entries(hit.value as Record<string, unknown>)) {
      const address = toInteger(key);
      const numeric = toNumber(value);
      if (address !== null && numeric !== null) out.push({ address, value: numeric });
    }
  }
  return out;
}

/* --------------------------------------------------------------- coercion -- */

function toScalar(value: unknown): number | string | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  return null;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function toInteger(value: unknown): number | null {
  const parsed = toNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

export function toIdString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function toBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    if (/^(1|true|yes|y|on|buffered|cached)$/i.test(value.trim())) return true;
    if (/^(0|false|no|n|off|live|realtime)$/i.test(value.trim())) return false;
  }
  return null;
}
