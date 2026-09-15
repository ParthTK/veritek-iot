import { newId } from '../../core/hash.js';
import { nowIso } from '../../core/time.js';
import { db } from '../index.js';
import { toBool, toInt, toIso, toJson, toStr } from '../types.js';

/**
 * Remote configuration (spec section 17).
 *
 * The manufacturer documents *that* the unit accepts configuration over an MQTT
 * subscription, but not the message syntax. So a command is only ever built
 * from a template row that a human has filled in and marked verified - the code
 * never invents a payload shape. Until such a row exists, the command service
 * records the request and refuses to transmit.
 */

export type CommandStatus = 'PENDING' | 'SENT' | 'ACKNOWLEDGED' | 'FAILED' | 'TIMEOUT' | 'BLOCKED';

export interface CommandTemplate {
  id: string;
  hardwareModel: string;
  commandType: string;
  description: string | null;
  topicTemplate: string | null;
  payloadTemplate: Record<string, unknown>;
  ackMatch: Record<string, unknown>;
  enabled: boolean;
  /** Must be true before anything is transmitted. */
  verified: boolean;
  notes: string | null;
}

export interface DeviceCommand {
  id: string;
  gatewayId: string;
  commandType: string;
  templateId: string | null;
  topic: string | null;
  payload: Record<string, unknown>;
  correlationId: string | null;
  requestedAt: string;
  sentAt: string | null;
  acknowledgedAt: string | null;
  status: CommandStatus;
  response: unknown;
  error: string | null;
  attempts: number;
  requestedBy: string | null;
}

function mapTemplate(row: Record<string, unknown>): CommandTemplate {
  return {
    id: String(row.id),
    hardwareModel: String(row.hardware_model),
    commandType: String(row.command_type),
    description: toStr(row.description),
    topicTemplate: toStr(row.topic_template),
    payloadTemplate: toJson<Record<string, unknown>>(row.payload_template, {}),
    ackMatch: toJson<Record<string, unknown>>(row.ack_match, {}),
    enabled: toBool(row.enabled),
    verified: toBool(row.verified),
    notes: toStr(row.notes),
  };
}

function mapCommand(row: Record<string, unknown>): DeviceCommand {
  return {
    id: String(row.id),
    gatewayId: String(row.gateway_id),
    commandType: String(row.command_type),
    templateId: toStr(row.template_id),
    topic: toStr(row.topic),
    payload: toJson<Record<string, unknown>>(row.payload, {}),
    correlationId: toStr(row.correlation_id),
    requestedAt: toIso(row.requested_at) ?? '',
    sentAt: toIso(row.sent_at),
    acknowledgedAt: toIso(row.acknowledged_at),
    status: (toStr(row.status) as CommandStatus) ?? 'PENDING',
    response: toJson<unknown>(row.response, null),
    error: toStr(row.error),
    attempts: toInt(row.attempts) ?? 0,
    requestedBy: toStr(row.requested_by),
  };
}

export async function listCommandTemplates(hardwareModel?: string): Promise<CommandTemplate[]> {
  if (hardwareModel) {
    const rows = await db().rows(
      'SELECT * FROM command_templates WHERE hardware_model = $1 ORDER BY command_type',
      [hardwareModel],
    );
    return rows.map(mapTemplate);
  }
  return (await db().rows('SELECT * FROM command_templates ORDER BY hardware_model, command_type')).map(mapTemplate);
}

export async function findCommandTemplate(
  hardwareModel: string,
  commandType: string,
): Promise<CommandTemplate | null> {
  const row = await db().one(
    'SELECT * FROM command_templates WHERE hardware_model = $1 AND command_type = $2',
    [hardwareModel, commandType],
  );
  return row ? mapTemplate(row) : null;
}

export interface CommandTemplateInput {
  id?: string;
  hardwareModel: string;
  commandType: string;
  description?: string | null;
  topicTemplate?: string | null;
  payloadTemplate?: Record<string, unknown>;
  ackMatch?: Record<string, unknown>;
  enabled?: boolean;
  verified?: boolean;
  notes?: string | null;
}

export async function upsertCommandTemplate(input: CommandTemplateInput): Promise<CommandTemplate> {
  const existing = await findCommandTemplate(input.hardwareModel, input.commandType);
  const id = existing?.id ?? input.id ?? newId('tmpl');
  const now = nowIso();
  await db().execute(
    'INSERT INTO command_templates (id, hardware_model, command_type, description, topic_template, ' +
      'payload_template, ack_match, enabled, verified, notes, created_at, updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) ' +
      'ON CONFLICT (id) DO UPDATE SET description = excluded.description, ' +
      'topic_template = excluded.topic_template, payload_template = excluded.payload_template, ' +
      'ack_match = excluded.ack_match, enabled = excluded.enabled, verified = excluded.verified, ' +
      'notes = excluded.notes, updated_at = excluded.updated_at',
    [
      id, input.hardwareModel, input.commandType, input.description ?? null, input.topicTemplate ?? null,
      input.payloadTemplate ?? {}, input.ackMatch ?? {}, input.enabled ?? false, input.verified ?? false,
      input.notes ?? null, now,
    ],
  );
  const template = await db().one('SELECT * FROM command_templates WHERE id = $1', [id]);
  if (!template) throw new Error('Failed to persist command template');
  return mapTemplate(template);
}

export interface CommandInput {
  gatewayId: string;
  commandType: string;
  templateId?: string | null;
  topic?: string | null;
  payload?: Record<string, unknown>;
  correlationId?: string | null;
  requestedBy?: string | null;
  status?: CommandStatus;
  error?: string | null;
}

export async function createCommand(input: CommandInput): Promise<DeviceCommand> {
  const id = newId('cmd');
  const now = nowIso();
  await db().execute(
    'INSERT INTO device_commands (id, gateway_id, command_type, template_id, topic, payload, correlation_id, ' +
      'requested_at, status, error, attempts, requested_by, created_at, updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$8,$8)',
    [
      id, input.gatewayId, input.commandType, input.templateId ?? null, input.topic ?? null,
      input.payload ?? {}, input.correlationId ?? id, now, input.status ?? 'PENDING',
      input.error ?? null, input.requestedBy ?? null,
    ],
  );
  const command = await getCommand(id);
  if (!command) throw new Error('Failed to create command');
  return command;
}

export async function getCommand(id: string): Promise<DeviceCommand | null> {
  const row = await db().one('SELECT * FROM device_commands WHERE id = $1', [id]);
  return row ? mapCommand(row) : null;
}

export async function findCommandByCorrelation(correlationId: string): Promise<DeviceCommand | null> {
  const row = await db().one(
    'SELECT * FROM device_commands WHERE correlation_id = $1 ORDER BY requested_at DESC LIMIT 1',
    [correlationId],
  );
  return row ? mapCommand(row) : null;
}

export async function markCommandSent(id: string, topic: string): Promise<void> {
  const now = nowIso();
  await db().execute(
    "UPDATE device_commands SET status = 'SENT', sent_at = $2, topic = $3, attempts = attempts + 1, " +
      'updated_at = $2 WHERE id = $1',
    [id, now, topic],
  );
}

export async function markCommandAcknowledged(id: string, response: unknown): Promise<void> {
  const now = nowIso();
  await db().execute(
    "UPDATE device_commands SET status = 'ACKNOWLEDGED', acknowledged_at = $2, response = $3, " +
      'updated_at = $2 WHERE id = $1',
    [id, now, response === null || response === undefined ? null : JSON.stringify(response)],
  );
}

export async function markCommandFailed(id: string, status: CommandStatus, error: string): Promise<void> {
  const now = nowIso();
  await db().execute(
    'UPDATE device_commands SET status = $2, error = $3, updated_at = $4 WHERE id = $1',
    [id, status, error, now],
  );
}

export async function listCommands(
  filter: { gatewayId?: string; status?: CommandStatus; limit?: number } = {},
): Promise<DeviceCommand[]> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.gatewayId) {
    params.push(filter.gatewayId);
    clauses.push('gateway_id = $' + params.length);
  }
  if (filter.status) {
    params.push(filter.status);
    clauses.push('status = $' + params.length);
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  params.push(Math.min(Math.max(filter.limit ?? 100, 1), 500));
  const rows = await db().rows(
    'SELECT * FROM device_commands' + where + ' ORDER BY requested_at DESC LIMIT $' + params.length,
    params,
  );
  return rows.map(mapCommand);
}

/** Commands that were sent but never acknowledged inside the timeout window. */
export async function expireStaleCommands(olderThanIso: string): Promise<number> {
  return db().execute(
    "UPDATE device_commands SET status = 'TIMEOUT', error = 'No acknowledgement received', updated_at = $2 " +
      "WHERE status = 'SENT' AND sent_at < $1",
    [olderThanIso, nowIso()],
  );
}
