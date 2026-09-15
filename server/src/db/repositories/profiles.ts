import { newId } from '../../core/hash.js';
import { nowIso } from '../../core/time.js';
import { db } from '../index.js';
import { toBool, toInt, toIso, toJson, toStr } from '../types.js';

/**
 * Payload profiles: the configuration that tells an adapter where, inside an
 * arbitrary JSON document, the gateway id / slave id / timestamp / values live.
 *
 * This table is the reason no Technode JSON key appears anywhere in the source.
 * When the first real packet is captured tomorrow, the mapping is a row here -
 * `technode_schema_v1` - not a code change.
 */

export interface ProfileMatchRules {
  /** MQTT topic patterns, MQTT wildcard syntax (`+` and `#`). */
  topics?: string[];
  /** JSON paths that must exist for this profile to claim the payload. */
  requiredPaths?: string[];
  /** Path/value pairs that must match exactly. */
  equals?: Record<string, string | number | boolean>;
  /** Gateway uids this profile is pinned to. */
  gatewayUids?: string[];
}

export interface ProfileSpec {
  /** Candidate JSON paths for each field, tried in order. */
  gatewayIdPaths?: string[];
  meterIdPaths?: string[];
  slaveIdPaths?: string[];
  timestampPaths?: string[];
  timestampFormat?: string;
  /** Offset assumed when the timestamp carries no zone information. */
  assumeUtcOffset?: string;
  sequencePaths?: string[];
  bufferedFlagPaths?: string[];
  /**
   * Where an array of per-sample objects lives, when the gateway batches its
   * offline buffer into one packet. Each element is parsed as its own packet.
   */
  batchPaths?: string[];
  /** Where the decoded name/value measurements live. */
  measurementPaths?: string[];
  /** Explicit vendor-key to platform-metric mapping. */
  keyMap?: Record<string, string>;
  /** Per-key unit/scale overrides applied after the key map. */
  transforms?: Record<string, { scale?: number; offset?: number; unit?: string }>;
  /** Where raw Modbus register words live, for gateways that do not decode. */
  registerBlockPaths?: string[];
  registerArrayPaths?: string[];
  registerAddressKey?: string;
  registerValueKey?: string;
  /** Treat unmapped numeric keys as metrics using their own name. */
  passthroughUnmapped?: boolean;
}

export interface PayloadProfile {
  id: string;
  name: string;
  vendor: string;
  version: number;
  enabled: boolean;
  priority: number;
  /** False until checked against a genuine captured packet. */
  verified: boolean;
  matchRules: ProfileMatchRules;
  spec: ProfileSpec;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function map(row: Record<string, unknown>): PayloadProfile {
  return {
    id: String(row.id),
    name: String(row.name),
    vendor: String(row.vendor),
    version: toInt(row.version) ?? 1,
    enabled: toBool(row.enabled),
    priority: toInt(row.priority) ?? 100,
    verified: toBool(row.verified),
    matchRules: toJson<ProfileMatchRules>(row.match_rules, {}),
    spec: toJson<ProfileSpec>(row.spec, {}),
    notes: toStr(row.notes),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

let cache: PayloadProfile[] | null = null;

export async function listProfiles(force = false): Promise<PayloadProfile[]> {
  if (cache && !force) return cache;
  const rows = await db().rows('SELECT * FROM payload_profiles ORDER BY priority ASC, version DESC');
  cache = rows.map(map);
  return cache;
}

export function invalidateProfileCache(): void {
  cache = null;
}

export async function getProfile(id: string): Promise<PayloadProfile | null> {
  const row = await db().one('SELECT * FROM payload_profiles WHERE id = $1', [id]);
  return row ? map(row) : null;
}

export async function getProfileByName(name: string): Promise<PayloadProfile | null> {
  const row = await db().one('SELECT * FROM payload_profiles WHERE name = $1', [name]);
  return row ? map(row) : null;
}

export interface ProfileInput {
  id?: string;
  name: string;
  vendor: string;
  version?: number;
  enabled?: boolean;
  priority?: number;
  verified?: boolean;
  matchRules?: ProfileMatchRules;
  spec?: ProfileSpec;
  notes?: string | null;
}

export async function upsertProfile(input: ProfileInput): Promise<PayloadProfile> {
  const existing = await getProfileByName(input.name);
  const id = existing?.id ?? input.id ?? newId('prof');
  const now = nowIso();
  await db().execute(
    'INSERT INTO payload_profiles (id, name, vendor, version, enabled, priority, verified, match_rules, spec, ' +
      'notes, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) ' +
      'ON CONFLICT (id) DO UPDATE SET name = excluded.name, vendor = excluded.vendor, version = excluded.version, ' +
      'enabled = excluded.enabled, priority = excluded.priority, verified = excluded.verified, ' +
      'match_rules = excluded.match_rules, spec = excluded.spec, notes = excluded.notes, ' +
      'updated_at = excluded.updated_at',
    [
      id, input.name, input.vendor, input.version ?? 1, input.enabled ?? true, input.priority ?? 100,
      input.verified ?? false, input.matchRules ?? {}, input.spec ?? {}, input.notes ?? null, now,
    ],
  );
  invalidateProfileCache();
  const profile = await getProfile(id);
  if (!profile) throw new Error('Failed to persist payload profile ' + input.name);
  return profile;
}

export async function deleteProfile(id: string): Promise<boolean> {
  const deleted = await db().execute('DELETE FROM payload_profiles WHERE id = $1', [id]);
  invalidateProfileCache();
  return deleted > 0;
}

/* --------------------------------------------------- field observations -- */

export interface FieldObservation {
  id: string;
  gatewayUid: string;
  topic: string | null;
  jsonPath: string;
  valueType: string | null;
  sampleValue: string | null;
  occurrences: number;
  mappedMetric: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

function mapObservation(row: Record<string, unknown>): FieldObservation {
  return {
    id: String(row.id),
    gatewayUid: String(row.gateway_uid),
    topic: toStr(row.topic),
    jsonPath: String(row.json_path),
    valueType: toStr(row.value_type),
    sampleValue: toStr(row.sample_value),
    occurrences: toInt(row.occurrences) ?? 0,
    mappedMetric: toStr(row.mapped_metric),
    firstSeenAt: toIso(row.first_seen_at),
    lastSeenAt: toIso(row.last_seen_at),
  };
}

/**
 * Remember every JSON path a device has ever sent.
 *
 * This is the commissioning shortcut: instead of eyeballing raw packets to work
 * out the vendor's schema, the admin screen lists the real keys, their types
 * and a sample value, with the ones we have not mapped yet flagged.
 */
export async function recordFieldObservations(
  gatewayUid: string,
  topic: string | null,
  paths: Array<{ path: string; valueType: string; sample: string }>,
): Promise<void> {
  if (paths.length === 0) return;
  const now = nowIso();
  for (const observed of paths) {
    await db().execute(
      'INSERT INTO payload_field_observations (id, gateway_uid, topic, json_path, value_type, sample_value, ' +
        'occurrences, first_seen_at, last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$7) ' +
        'ON CONFLICT (gateway_uid, json_path) DO UPDATE SET ' +
        'occurrences = payload_field_observations.occurrences + 1, ' +
        'sample_value = excluded.sample_value, value_type = excluded.value_type, ' +
        'topic = COALESCE(excluded.topic, payload_field_observations.topic), last_seen_at = excluded.last_seen_at',
      [newId('obs'), gatewayUid, topic, observed.path, observed.valueType, observed.sample.slice(0, 200), now],
    );
  }
}

export async function listFieldObservations(gatewayUid?: string): Promise<FieldObservation[]> {
  if (gatewayUid) {
    const rows = await db().rows(
      'SELECT * FROM payload_field_observations WHERE gateway_uid = $1 ORDER BY json_path',
      [gatewayUid],
    );
    return rows.map(mapObservation);
  }
  const rows = await db().rows('SELECT * FROM payload_field_observations ORDER BY gateway_uid, json_path');
  return rows.map(mapObservation);
}

export async function setObservationMapping(id: string, metricKey: string | null): Promise<void> {
  await db().execute('UPDATE payload_field_observations SET mapped_metric = $2 WHERE id = $1', [id, metricKey]);
}
