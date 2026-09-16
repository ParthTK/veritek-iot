import { env } from '../../config/env.js';
import { generateToken, hashSecret, newId, tokenLookupKey, verifySecret } from '../../core/hash.js';
import { nowIso } from '../../core/time.js';
import { db } from '../index.js';
import { toBool, toInt, toIso, toJson, toNum, toStr } from '../types.js';

export type GatewayStatus = 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'UNKNOWN';

/**
 * Administrative state, as opposed to `status` which is observed connectivity.
 * A gateway can be ACTIVE and OFFLINE at once: we intend it to work, it is not
 * currently reporting.
 */
export type LifecycleState = 'provisioned' | 'active' | 'suspended' | 'revoked' | 'decommissioned';

export interface Gateway {
  id: string;
  gatewayUid: string;
  name: string;
  siteId: string | null;
  imei: string | null;
  simNumber: string | null;
  iccid: string | null;
  mqttClientId: string | null;
  mqttUsername: string | null;
  hardwareModel: string | null;
  firmwareVersion: string | null;
  connectionType: string | null;
  topicNamespace: string | null;
  observedTopic: string | null;
  payloadProfileId: string | null;
  sourceUtcOffset: string | null;
  lastSeenAt: string | null;
  lastDataAt: string | null;
  status: GatewayStatus;
  /** Connectivity health. Separate from lifecycleState, which is intent. */
  lifecycleState: LifecycleState;
  environment: string;
  commissionedAt: string | null;
  decommissionedAt: string | null;
  replacedByGatewayId: string | null;
  enabled: boolean;
  hasAuthToken: boolean;
  config: Record<string, unknown>;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface GatewayHealth {
  gatewayId: string;
  packetsTotal: number;
  packetsOk: number;
  packetsMalformed: number;
  packetsDuplicate: number;
  packetsUnknownSchema: number;
  processingFailures: number;
  bufferedPackets: number;
  lastPacketAt: string | null;
  lastDataAt: string | null;
  lastLagSeconds: number | null;
  maxLagSeconds: number | null;
  avgLagSeconds: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  updatedAt: string | null;
}

function map(row: Record<string, unknown>): Gateway {
  return {
    id: String(row.id),
    gatewayUid: String(row.gateway_uid),
    name: String(row.name),
    siteId: toStr(row.site_id),
    imei: toStr(row.imei),
    simNumber: toStr(row.sim_number),
    iccid: toStr(row.iccid),
    mqttClientId: toStr(row.mqtt_client_id),
    mqttUsername: toStr(row.mqtt_username),
    hardwareModel: toStr(row.hardware_model),
    firmwareVersion: toStr(row.firmware_version),
    connectionType: toStr(row.connection_type),
    topicNamespace: toStr(row.topic_namespace),
    observedTopic: toStr(row.observed_topic),
    payloadProfileId: toStr(row.payload_profile_id),
    sourceUtcOffset: toStr(row.source_utc_offset),
    lastSeenAt: toIso(row.last_seen_at),
    lastDataAt: toIso(row.last_data_at),
    status: (toStr(row.status) as GatewayStatus) ?? 'UNKNOWN',
    lifecycleState: (toStr(row.lifecycle_state) as LifecycleState) ?? 'provisioned',
    environment: toStr(row.environment) ?? 'production',
    commissionedAt: toIso(row.commissioned_at),
    decommissionedAt: toIso(row.decommissioned_at),
    replacedByGatewayId: toStr(row.replaced_by_gateway_id),
    enabled: toBool(row.enabled),
    // The hash itself never leaves the repository.
    hasAuthToken: Boolean(row.auth_token_hash),
    config: toJson<Record<string, unknown>>(row.config, {}),
    notes: toStr(row.notes),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapHealth(row: Record<string, unknown>): GatewayHealth {
  return {
    gatewayId: String(row.gateway_id),
    packetsTotal: toInt(row.packets_total) ?? 0,
    packetsOk: toInt(row.packets_ok) ?? 0,
    packetsMalformed: toInt(row.packets_malformed) ?? 0,
    packetsDuplicate: toInt(row.packets_duplicate) ?? 0,
    packetsUnknownSchema: toInt(row.packets_unknown_schema) ?? 0,
    processingFailures: toInt(row.processing_failures) ?? 0,
    bufferedPackets: toInt(row.buffered_packets) ?? 0,
    lastPacketAt: toIso(row.last_packet_at),
    lastDataAt: toIso(row.last_data_at),
    lastLagSeconds: toNum(row.last_lag_seconds),
    maxLagSeconds: toNum(row.max_lag_seconds),
    avgLagSeconds: toNum(row.avg_lag_seconds),
    lastError: toStr(row.last_error),
    lastErrorAt: toIso(row.last_error_at),
    updatedAt: toIso(row.updated_at),
  };
}

/* ------------------------------------------------------------------ reads -- */

export async function listGateways(filter: { siteId?: string } = {}): Promise<Gateway[]> {
  const where = filter.siteId ? ' WHERE site_id = $1' : '';
  const params = filter.siteId ? [filter.siteId] : [];
  return (await db().rows('SELECT * FROM gateways' + where + ' ORDER BY name', params)).map(map);
}

export async function getGateway(id: string): Promise<Gateway | null> {
  const row = await db().one('SELECT * FROM gateways WHERE id = $1', [id]);
  return row ? map(row) : null;
}

export async function getGatewayByUid(uid: string): Promise<Gateway | null> {
  const row = await db().one('SELECT * FROM gateways WHERE gateway_uid = $1', [uid]);
  return row ? map(row) : null;
}

export async function getGatewayByMqttClientId(clientId: string): Promise<Gateway | null> {
  const row = await db().one('SELECT * FROM gateways WHERE mqtt_client_id = $1', [clientId]);
  return row ? map(row) : null;
}

/** Resolve a device bearer token to its gateway. Constant-time on the secret. */
export async function findGatewayByToken(token: string): Promise<Gateway | null> {
  const lookup = tokenLookupKey(token, env.TOKEN_PEPPER);
  const rows = await db().rows('SELECT * FROM gateways WHERE auth_token_lookup = $1', [lookup]);
  for (const row of rows) {
    if (verifySecret(token, toStr(row.auth_token_hash))) return map(row);
  }
  return null;
}

/* ----------------------------------------------------------------- writes -- */

export interface GatewayInput {
  id?: string;
  gatewayUid: string;
  name?: string;
  siteId?: string | null;
  imei?: string | null;
  simNumber?: string | null;
  iccid?: string | null;
  mqttClientId?: string | null;
  mqttUsername?: string | null;
  hardwareModel?: string | null;
  firmwareVersion?: string | null;
  connectionType?: string | null;
  topicNamespace?: string | null;
  payloadProfileId?: string | null;
  sourceUtcOffset?: string | null;
  enabled?: boolean;
  config?: Record<string, unknown>;
  notes?: string | null;
}

export async function upsertGateway(input: GatewayInput): Promise<Gateway> {
  const existing = await getGatewayByUid(input.gatewayUid);
  const id = existing?.id ?? input.id ?? newId('gw');
  const now = nowIso();

  if (existing) {
    const merged = { ...existing, ...stripUndefined(input) };
    await db().execute(
      'UPDATE gateways SET name = $2, site_id = $3, imei = $4, sim_number = $5, iccid = $6, ' +
        'mqtt_client_id = $7, mqtt_username = $8, hardware_model = $9, firmware_version = $10, ' +
        'connection_type = $11, topic_namespace = $12, payload_profile_id = $13, source_utc_offset = $14, ' +
        'enabled = $15, config = $16, notes = $17, updated_at = $18 WHERE id = $1',
      [
        id, merged.name, merged.siteId, merged.imei, merged.simNumber, merged.iccid,
        merged.mqttClientId, merged.mqttUsername, merged.hardwareModel, merged.firmwareVersion,
        merged.connectionType, merged.topicNamespace, merged.payloadProfileId, merged.sourceUtcOffset,
        merged.enabled, merged.config ?? {}, merged.notes, now,
      ],
    );
  } else {
    await db().execute(
      'INSERT INTO gateways (id, gateway_uid, name, site_id, imei, sim_number, iccid, mqtt_client_id, ' +
        'mqtt_username, hardware_model, firmware_version, connection_type, topic_namespace, ' +
        'payload_profile_id, source_utc_offset, enabled, config, notes, status, created_at, updated_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)',
      [
        id, input.gatewayUid, input.name ?? input.gatewayUid, input.siteId ?? null,
        input.imei ?? null, input.simNumber ?? null, input.iccid ?? null,
        input.mqttClientId ?? null, input.mqttUsername ?? null, input.hardwareModel ?? null,
        input.firmwareVersion ?? null, input.connectionType ?? null,
        input.topicNamespace ?? null, input.payloadProfileId ?? null,
        input.sourceUtcOffset ?? null, input.enabled ?? true,
        input.config ?? {}, input.notes ?? null, 'UNKNOWN', now,
      ],
    );
    await db().execute(
      'INSERT INTO gateway_health (gateway_id, updated_at) VALUES ($1, $2) ON CONFLICT (gateway_id) DO NOTHING',
      [id, now],
    );
  }

  const saved = await getGateway(id);
  if (!saved) throw new Error('Failed to persist gateway ' + input.gatewayUid);
  return saved;
}

function stripUndefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export async function deleteGateway(id: string): Promise<boolean> {
  return (await db().execute('DELETE FROM gateways WHERE id = $1', [id])) > 0;
}

/**
 * Issue a device credential. The plaintext is returned exactly once - only its
 * scrypt hash is stored, so a leaked database does not hand over device access.
 */
export async function rotateGatewayToken(id: string): Promise<string> {
  const token = generateToken();
  await db().execute(
    'UPDATE gateways SET auth_token_hash = $2, auth_token_lookup = $3, updated_at = $4 WHERE id = $1',
    [id, hashSecret(token), tokenLookupKey(token, env.TOKEN_PEPPER), nowIso()],
  );
  return token;
}

/** Record that we heard from the gateway (any packet, parsed or not). */
export async function touchGatewaySeen(id: string, at: string, topic?: string | null): Promise<void> {
  await db().execute(
    'UPDATE gateways SET last_seen_at = $2, observed_topic = COALESCE($3, observed_topic), updated_at = $2 WHERE id = $1',
    [id, at, topic ?? null],
  );
}

/** Record that the gateway delivered usable telemetry. */
export async function touchGatewayData(id: string, at: string): Promise<void> {
  await db().execute(
    'UPDATE gateways SET last_data_at = CASE WHEN last_data_at IS NULL OR last_data_at < $2 THEN $2 ELSE last_data_at END, ' +
      'last_seen_at = $2, updated_at = $2 WHERE id = $1',
    [id, at],
  );
}

export async function setGatewayStatus(id: string, status: GatewayStatus): Promise<void> {
  await db().execute('UPDATE gateways SET status = $2, updated_at = $3 WHERE id = $1', [id, status, nowIso()]);
}

/* ----------------------------------------------------------------- health -- */

export async function getGatewayHealth(gatewayId: string): Promise<GatewayHealth | null> {
  const row = await db().one('SELECT * FROM gateway_health WHERE gateway_id = $1', [gatewayId]);
  return row ? mapHealth(row) : null;
}

export async function listGatewayHealth(): Promise<GatewayHealth[]> {
  return (await db().rows('SELECT * FROM gateway_health')).map(mapHealth);
}

export interface HealthDelta {
  total?: number;
  ok?: number;
  malformed?: number;
  duplicate?: number;
  unknownSchema?: number;
  failures?: number;
  buffered?: number;
  lastPacketAt?: string | null;
  lastDataAt?: string | null;
  lagSeconds?: number | null;
  error?: string | null;
}

/**
 * Accumulate ingest counters (spec section 16).
 *
 * `avg_lag_seconds` is an exponential moving average rather than a true mean -
 * it needs no history table and reacts quickly when a gateway starts replaying
 * a backlog, which is exactly the condition an operator wants to see.
 */
export async function bumpGatewayHealth(gatewayId: string, delta: HealthDelta): Promise<void> {
  const now = nowIso();
  await db().execute(
    'INSERT INTO gateway_health (gateway_id, packets_total, packets_ok, packets_malformed, packets_duplicate, ' +
      'packets_unknown_schema, processing_failures, buffered_packets, last_packet_at, last_data_at, ' +
      'last_lag_seconds, max_lag_seconds, avg_lag_seconds, last_error, last_error_at, updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$11,$12,$13,$14) ' +
      'ON CONFLICT (gateway_id) DO UPDATE SET ' +
      'packets_total = gateway_health.packets_total + $2, ' +
      'packets_ok = gateway_health.packets_ok + $3, ' +
      'packets_malformed = gateway_health.packets_malformed + $4, ' +
      'packets_duplicate = gateway_health.packets_duplicate + $5, ' +
      'packets_unknown_schema = gateway_health.packets_unknown_schema + $6, ' +
      'processing_failures = gateway_health.processing_failures + $7, ' +
      'buffered_packets = gateway_health.buffered_packets + $8, ' +
      'last_packet_at = COALESCE($9, gateway_health.last_packet_at), ' +
      'last_data_at = COALESCE($10, gateway_health.last_data_at), ' +
      'last_lag_seconds = COALESCE($11, gateway_health.last_lag_seconds), ' +
      // GREATEST/MAX differ between the two dialects, so express it as CASE.
      'max_lag_seconds = CASE WHEN $11 IS NULL THEN gateway_health.max_lag_seconds ' +
      '  WHEN gateway_health.max_lag_seconds IS NULL OR gateway_health.max_lag_seconds < $11 THEN $11 ' +
      '  ELSE gateway_health.max_lag_seconds END, ' +
      'avg_lag_seconds = CASE WHEN $11 IS NULL THEN gateway_health.avg_lag_seconds ' +
      '  WHEN gateway_health.avg_lag_seconds IS NULL THEN $11 ' +
      '  ELSE gateway_health.avg_lag_seconds * 0.8 + $11 * 0.2 END, ' +
      'last_error = COALESCE($12, gateway_health.last_error), ' +
      'last_error_at = CASE WHEN $12 IS NULL THEN gateway_health.last_error_at ELSE $13 END, ' +
      'updated_at = $14',
    [
      gatewayId,
      delta.total ?? 0,
      delta.ok ?? 0,
      delta.malformed ?? 0,
      delta.duplicate ?? 0,
      delta.unknownSchema ?? 0,
      delta.failures ?? 0,
      delta.buffered ?? 0,
      delta.lastPacketAt ?? null,
      delta.lastDataAt ?? null,
      delta.lagSeconds ?? null,
      delta.error ?? null,
      delta.error ? now : null,
      now,
    ],
  );
}
