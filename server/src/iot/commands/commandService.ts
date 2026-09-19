import { env } from '../../config/env.js';
import { bus } from '../../core/events.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import { nowIso } from '../../core/time.js';
import type { CommandTemplate, DeviceCommand } from '../../db/repositories/commands.js';
import {
  createCommand,
  expireStaleCommands,
  findCommandByCorrelation,
  findCommandTemplate,
  markCommandAcknowledged,
  markCommandFailed,
  markCommandSent,
} from '../../db/repositories/commands.js';
import { getGateway } from '../../db/repositories/gateways.js';
import { audit } from '../../db/repositories/users.js';
import { getByPathLoose, renderTemplate } from '../adapters/jsonPath.js';
import { commandTopicFor, publish } from '../mqtt/publisher.js';

const log = createLogger('commands');

/**
 * Remote configuration (spec section 17).
 *
 * The manufacturer confirms the unit can be reconfigured over an MQTT
 * subscription - broker, port, publish topic, polling interval, slave id, baud
 * rate, parity, stop bits, Modbus transactions - but does not publish the
 * message syntax.
 *
 * So the pipeline is complete and the wire format is empty. A command is only
 * ever rendered from a `command_templates` row that a human has filled in from
 * real vendor documentation and marked `verified`. Until such a row exists the
 * request is recorded as BLOCKED and nothing is transmitted. Guessing a control
 * message at an energy meter is not a risk worth taking.
 */

export type CommandOutcome = 'SENT' | 'BLOCKED' | 'FAILED';

export interface QueueCommandInput {
  gatewayId: string;
  commandType: string;
  /** Values substituted into the template's placeholders. */
  params?: Record<string, string | number | boolean | null>;
  requestedBy?: string | null;
  /** Skip the enabled/verified gate. Only for a controlled bench test. */
  force?: boolean;
}

export interface QueueCommandResult {
  command: DeviceCommand;
  outcome: CommandOutcome;
  reason: string | null;
}

export async function queueCommand(input: QueueCommandInput): Promise<QueueCommandResult> {
  const gateway = await getGateway(input.gatewayId);
  if (!gateway) throw new Error('Unknown gateway ' + input.gatewayId);

  const template = gateway.hardwareModel
    ? await findCommandTemplate(gateway.hardwareModel, input.commandType)
    : null;

  const blockReason = describeBlock(template, input.force ?? false, gateway.hardwareModel);

  if (blockReason) {
    const command = await createCommand({
      gatewayId: gateway.id,
      commandType: input.commandType,
      templateId: template?.id ?? null,
      payload: { requestedParams: input.params ?? {} },
      requestedBy: input.requestedBy ?? null,
      status: 'BLOCKED',
      error: blockReason,
    });

    log.warn('command recorded but not transmitted', {
      event: LogEvent.COMMAND_BLOCKED,
      gatewayUid: gateway.gatewayUid,
      commandType: input.commandType,
      reason: blockReason,
    });
    await audit({
      actor: input.requestedBy ?? null,
      action: 'command.blocked',
      entityType: 'gateway',
      entityId: gateway.id,
      detail: { commandType: input.commandType, reason: blockReason, params: input.params ?? {} },
    });

    return { command, outcome: 'BLOCKED', reason: blockReason };
  }

  // Only reachable with a verified template in hand.
  const verified = template as CommandTemplate;
  const payload = renderPayload(verified.payloadTemplate, {
    ...(input.params ?? {}),
    gatewayUid: gateway.gatewayUid,
    gatewayId: gateway.id,
    timestamp: nowIso(),
  });

  const command = await createCommand({
    gatewayId: gateway.id,
    commandType: input.commandType,
    templateId: verified.id,
    payload: payload as Record<string, unknown>,
    requestedBy: input.requestedBy ?? null,
    status: 'PENDING',
  });

  const topic = commandTopicFor(gateway.gatewayUid, verified.topicTemplate);
  const withCorrelation = {
    ...(payload as Record<string, unknown>),
    ...(verified.ackMatch.correlationField
      ? { [String(verified.ackMatch.correlationField)]: command.correlationId }
      : {}),
  };

  log.info('dispatching command', {
    event: LogEvent.COMMAND_QUEUED,
    gatewayUid: gateway.gatewayUid,
    commandType: input.commandType,
    topic,
    commandId: command.id,
  });

  const sent = await publish(topic, withCorrelation, { qos: 1, retain: false });
  if (!sent) {
    await markCommandFailed(command.id, 'FAILED', 'Broker connection unavailable.');
    return {
      command: { ...command, status: 'FAILED', error: 'Broker connection unavailable.' },
      outcome: 'FAILED',
      reason: 'Broker connection unavailable.',
    };
  }

  await markCommandSent(command.id, topic);
  await audit({
    actor: input.requestedBy ?? null,
    action: 'command.sent',
    entityType: 'gateway',
    entityId: gateway.id,
    detail: { commandType: input.commandType, topic, commandId: command.id, payload: withCorrelation },
  });
  bus.emit('command.updated', { id: command.id, gatewayId: gateway.id, status: 'SENT' });

  log.info('command sent', { event: LogEvent.COMMAND_SENT, commandId: command.id, topic });
  return { command: { ...command, status: 'SENT', topic }, outcome: 'SENT', reason: null };
}

function describeBlock(
  template: CommandTemplate | null,
  force: boolean,
  hardwareModel: string | null,
): string | null {
  if (!env.COMMANDS_ENABLED && !force) {
    return 'Remote configuration is disabled (COMMANDS_ENABLED=false).';
  }
  if (!hardwareModel) {
    return 'The gateway has no hardware_model set, so no command template can be selected.';
  }
  if (!template) {
    return (
      'No command template exists for ' + hardwareModel + '. ' +
      "the vendor's exact command syntax is not published; add a verified command_templates row " +
      'before this command can be transmitted.'
    );
  }
  if (!template.verified && !force) {
    return 'Command template ' + template.id + ' is not marked verified against vendor documentation.';
  }
  if (!template.enabled && !force) {
    return 'Command template ' + template.id + ' is disabled.';
  }
  return null;
}

/** Substitute `{placeholders}` through a template of arbitrary depth. */
export function renderPayload(
  template: unknown,
  values: Record<string, string | number | boolean | null>,
): unknown {
  const scalars: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(values)) {
    scalars[key] = typeof value === 'boolean' ? String(value) : value;
  }

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      // A template that is exactly one placeholder keeps the value's own type.
      const exact = /^\{(\w+)\}$/.exec(node);
      if (exact && exact[1] !== undefined && exact[1] in values) return values[exact[1]];
      return renderTemplate(node, scalars);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([key, value]) => [key, walk(value)]),
      );
    }
    return node;
  };

  return walk(template);
}

/**
 * Match a gateway's reply to the command that caused it.
 *
 * Which field carries the correlation id is part of the unknown syntax, so the
 * field name comes from the template's `ack_match` configuration.
 */
export async function handleCommandResponse(topic: string, payload: Buffer): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(payload.toString('utf8'));
  } catch {
    log.warn('command response was not JSON', { topic, preview: payload.toString('utf8').slice(0, 120) });
    return;
  }

  const candidates = ['correlation_id', 'correlationId', 'id', 'msg_id', 'msgId', 'request_id', 'seq'];
  let correlationId: string | null = null;
  for (const candidate of candidates) {
    const value = getByPathLoose(body, candidate);
    if (typeof value === 'string' || typeof value === 'number') {
      correlationId = String(value);
      break;
    }
  }

  if (!correlationId) {
    log.warn('command response carried no recognisable correlation id', { topic });
    return;
  }

  const command = await findCommandByCorrelation(correlationId);
  if (!command) {
    log.warn('command response did not match any request', { topic, correlationId });
    return;
  }

  await markCommandAcknowledged(command.id, body);
  bus.emit('command.updated', { id: command.id, gatewayId: command.gatewayId, status: 'ACKNOWLEDGED' });
  log.info('command acknowledged', {
    event: LogEvent.COMMAND_ACKNOWLEDGED,
    commandId: command.id,
    topic,
  });
}

/** Periodic sweep for commands that were sent but never answered. */
export async function expireCommands(): Promise<number> {
  const cutoff = new Date(Date.now() - env.COMMAND_TIMEOUT_SECONDS * 1000).toISOString();
  return expireStaleCommands(cutoff);
}
