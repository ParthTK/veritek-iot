import { newId, payloadHash } from '../../core/hash.js';
import { nowIso } from '../../core/time.js';
import { db } from '../index.js';
import { toBool, toInt, toIso, toJson, toStr } from '../types.js';

/**
 * The raw ingest log (spec section 3).
 *
 * Every packet is written here byte-for-byte *before* anything tries to
 * understand it. When the real Technode gateway connects tomorrow, this table
 * is where its first packet will be read off - and if the parser rejects it,
 * the payload is still safely on disk to map against and replay.
 */

export type Transport = 'MQTT' | 'HTTP';

export type ProcessingStatus =
  | 'PENDING'
  | 'OK'
  | 'PARTIAL'
  | 'DUPLICATE'
  | 'UNKNOWN_SCHEMA'
  | 'UNKNOWN_GATEWAY'
  | 'INVALID_PAYLOAD'
  | 'FAILED';

export interface RawMessage {
  id: string;
  gatewayId: string | null;
  gatewayUid: string | null;
  transport: Transport;
  mqttTopic: string | null;
  mqttClientId: string | null;
  sourceIp: string | null;
  contentType: string | null;
  byteSize: number;
  receivedAtServer: string;
  payload: unknown;
  payloadText: string;
  payloadHash: string;
  processed: boolean;
  processingStatus: ProcessingStatus;
  processingError: string | null;
  processedAt: string | null;
  adapter: string | null;
  profileId: string | null;
  sampleCount: number;
  createdAt: string | null;
}

function map(row: Record<string, unknown>): RawMessage {
  return {
    id: String(row.id),
    gatewayId: toStr(row.gateway_id),
    gatewayUid: toStr(row.gateway_uid),
    transport: (toStr(row.transport) as Transport) ?? 'MQTT',
    mqttTopic: toStr(row.mqtt_topic),
    mqttClientId: toStr(row.mqtt_client_id),
    sourceIp: toStr(row.source_ip),
    contentType: toStr(row.content_type),
    byteSize: toInt(row.byte_size) ?? 0,
    receivedAtServer: toIso(row.received_at_server) ?? nowIso(),
    payload: toJson<unknown>(row.payload, null),
    payloadText: toStr(row.payload_text) ?? '',
    payloadHash: toStr(row.payload_hash) ?? '',
    processed: toBool(row.processed),
    processingStatus: (toStr(row.processing_status) as ProcessingStatus) ?? 'PENDING',
    processingError: toStr(row.processing_error),
    processedAt: toIso(row.processed_at),
    adapter: toStr(row.adapter),
    profileId: toStr(row.profile_id),
    sampleCount: toInt(row.sample_count) ?? 0,
    createdAt: toIso(row.created_at),
  };
}

export interface RawMessageInput {
  gatewayId?: string | null;
  gatewayUid?: string | null;
  transport: Transport;
  mqttTopic?: string | null;
  mqttClientId?: string | null;
  sourceIp?: string | null;
  contentType?: string | null;
  receivedAtServer?: string;
  /** The bytes exactly as they arrived. */
  raw: Buffer | string;
}

export interface StoredRawMessage {
  id: string;
  receivedAtServer: string;
  payloadHash: string;
  /** Parsed JSON, or null when the bytes were not JSON at all. */
  json: unknown;
  jsonError: string | null;
  byteSize: number;
  payloadText: string;
}

/**
 * Persist a packet. Parsing is attempted only so the payload can be queried
 * later - a parse failure never stops the row being written.
 */
export async function storeRawMessage(input: RawMessageInput): Promise<StoredRawMessage> {
  const id = newId('raw');
  const receivedAt = input.receivedAtServer ?? nowIso();
  const buffer = Buffer.isBuffer(input.raw) ? input.raw : Buffer.from(input.raw, 'utf8');
  const payloadText = buffer.toString('utf8');
  const hash = payloadHash(buffer);

  let json: unknown = null;
  let jsonError: string | null = null;
  try {
    const trimmed = payloadText.trim();
    json = trimmed === '' ? null : JSON.parse(trimmed);
  } catch (error) {
    jsonError = error instanceof Error ? error.message : String(error);
  }

  await db().execute(
    'INSERT INTO raw_iot_messages (id, gateway_id, gateway_uid, transport, mqtt_topic, mqtt_client_id, source_ip, ' +
      'content_type, byte_size, received_at_server, payload, payload_text, payload_hash, processed, ' +
      'processing_status, sample_count, created_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
    [
      id,
      input.gatewayId ?? null,
      input.gatewayUid ?? null,
      input.transport,
      input.mqttTopic ?? null,
      input.mqttClientId ?? null,
      input.sourceIp ?? null,
      input.contentType ?? null,
      buffer.byteLength,
      receivedAt,
      json === null ? null : JSON.stringify(json),
      payloadText,
      hash,
      false,
      'PENDING',
      0,
      receivedAt,
    ],
  );

  return { id, receivedAtServer: receivedAt, payloadHash: hash, json, jsonError, byteSize: buffer.byteLength, payloadText };
}

export interface ProcessingOutcome {
  status: ProcessingStatus;
  error?: string | null;
  adapter?: string | null;
  profileId?: string | null;
  sampleCount?: number;
  gatewayId?: string | null;
  gatewayUid?: string | null;
}

export async function markProcessed(id: string, outcome: ProcessingOutcome): Promise<void> {
  await db().execute(
    'UPDATE raw_iot_messages SET processed = $2, processing_status = $3, processing_error = $4, ' +
      'processed_at = $5, adapter = COALESCE($6, adapter), profile_id = COALESCE($7, profile_id), ' +
      'sample_count = $8, gateway_id = COALESCE($9, gateway_id), gateway_uid = COALESCE($10, gateway_uid) ' +
      'WHERE id = $1',
    [
      id,
      true,
      outcome.status,
      outcome.error ?? null,
      nowIso(),
      outcome.adapter ?? null,
      outcome.profileId ?? null,
      outcome.sampleCount ?? 0,
      outcome.gatewayId ?? null,
      outcome.gatewayUid ?? null,
    ],
  );
}

export async function getRawMessage(id: string): Promise<RawMessage | null> {
  const row = await db().one('SELECT * FROM raw_iot_messages WHERE id = $1', [id]);
  return row ? map(row) : null;
}

export interface RawMessageQuery {
  gatewayUid?: string;
  topic?: string;
  status?: ProcessingStatus;
  transport?: Transport;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function listRawMessages(query: RawMessageQuery = {}): Promise<{ rows: RawMessage[]; total: number }> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  const add = (sql: string, value: string | number): void => {
    params.push(value);
    clauses.push(sql.replace('?', '$' + params.length));
  };

  if (query.gatewayUid) add('gateway_uid = ?', query.gatewayUid);
  if (query.topic) add('mqtt_topic = ?', query.topic);
  if (query.status) add('processing_status = ?', query.status);
  if (query.transport) add('transport = ?', query.transport);
  if (query.from) add('received_at_server >= ?', query.from);
  if (query.to) add('received_at_server <= ?', query.to);

  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const totalRow = await db().one<{ total: number }>(
    'SELECT COUNT(*) AS total FROM raw_iot_messages' + where,
    params,
  );

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);
  params.push(limit, offset);
  const rows = await db().rows(
    'SELECT * FROM raw_iot_messages' + where +
      ' ORDER BY received_at_server DESC LIMIT $' + (params.length - 1) + ' OFFSET $' + params.length,
    params,
  );

  return { rows: rows.map(map), total: Number(totalRow?.total ?? 0) };
}

/** Packets that have not been through the pipeline yet - restart recovery. */
export async function listPendingRawMessages(limit: number): Promise<RawMessage[]> {
  const rows = await db().rows(
    'SELECT * FROM raw_iot_messages WHERE processed = $1 ORDER BY received_at_server LIMIT $2',
    [false, limit],
  );
  return rows.map(map);
}

/** Distinct topics seen, newest first - the commissioning topic discovery view. */
export async function listObservedTopics(limit = 50): Promise<Array<{ topic: string; count: number; lastSeen: string | null; gatewayUid: string | null }>> {
  const rows = await db().rows<Record<string, unknown>>(
    'SELECT mqtt_topic AS topic, COUNT(*) AS count, MAX(received_at_server) AS last_seen, ' +
      'MAX(gateway_uid) AS gateway_uid FROM raw_iot_messages WHERE mqtt_topic IS NOT NULL ' +
      'GROUP BY mqtt_topic ORDER BY MAX(received_at_server) DESC LIMIT $1',
    [limit],
  );
  return rows.map((row) => ({
    topic: String(row.topic),
    count: toInt(row.count) ?? 0,
    lastSeen: toIso(row.last_seen),
    gatewayUid: toStr(row.gateway_uid),
  }));
}

export async function pruneRawMessages(olderThanIso: string): Promise<number> {
  return db().execute('DELETE FROM raw_iot_messages WHERE received_at_server < $1', [olderThanIso]);
}

export async function countByStatus(): Promise<Record<string, number>> {
  const rows = await db().rows<Record<string, unknown>>(
    'SELECT processing_status AS status, COUNT(*) AS count FROM raw_iot_messages GROUP BY processing_status',
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[String(row.status)] = toInt(row.count) ?? 0;
  return out;
}
