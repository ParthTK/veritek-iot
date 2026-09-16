import { env } from '../../config/env.js';
import { bus } from '../../core/events.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import { getGatewayByUid, setGatewayStatus, touchGatewaySeen } from '../../db/repositories/gateways.js';
import { metrics } from '../../observability/metrics.js';
import { topicMatches } from '../adapters/jsonPath.js';
import { ingest } from '../telemetry/ingestion.js';
import { handleCommandResponse } from '../commands/commandService.js';
import { connectMqtt } from './client.js';
import { consumerSubscriptions, parseTopic } from './topics.js';

const log = createLogger('mqtt:consumer');

/**
 * The MQTT consumer.
 *
 * It listens on two kinds of namespace at once:
 *
 *   1. our own convention, `energy/v1/gateways/+/{telemetry,status,response}`;
 *   2. anything in MQTT_VENDOR_TOPICS / MQTT_SUBSCRIBE_TOPICS - the escape
 *      hatch for a gateway that cannot be pointed at our topics, and the broad
 *      filter used during commissioning to catch the first unknown packet.
 *
 * Nothing in here may throw. An unexpected payload has to leave a log line and
 * a stored raw row, not kill the subscription.
 */

let started = false;
let messageCount = 0;
let errorCount = 0;
let lastMessageAt: string | null = null;
const topicCounts = new Map<string, number>();

export function consumerStats(): {
  started: boolean;
  messages: number;
  errors: number;
  lastMessageAt: string | null;
  topics: Array<{ topic: string; count: number }>;
  subscriptions: string[];
} {
  return {
    started,
    messages: messageCount,
    errors: errorCount,
    lastMessageAt,
    topics: [...topicCounts.entries()]
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50),
    subscriptions: consumerSubscriptions(),
  };
}

/** Legacy vendor-shaped command acknowledgement topics. */
function legacyResponseFilters(): string[] {
  if (!env.MQTT_COMMAND_TOPIC) return [];
  const base = env.MQTT_COMMAND_TOPIC.replace('{gatewayUid}', '+');
  return [base + '/response', base + '/ack'];
}

export async function startConsumer(): Promise<void> {
  if (started) return;
  const client = await connectMqtt();
  if (!client) return;

  const subscribe = (): void => {
    const filters = [...consumerSubscriptions(), ...legacyResponseFilters()];
    for (const filter of filters) {
      client.subscribe(filter, { qos: env.MQTT_QOS as 0 | 1 | 2 }, (error, granted) => {
        if (error) {
          log.error('subscription failed', { event: LogEvent.MQTT_ERROR, filter, error });
          return;
        }
        log.info('subscribed', { event: LogEvent.MQTT_SUBSCRIBED, filter, qos: granted?.[0]?.qos });
      });
    }
  };

  // Re-subscribing on every connect covers a broker that lost our session, and
  // costs nothing when the session was in fact preserved.
  client.on('connect', subscribe);

  client.on('message', (topic, payload, packet) => {
    void handleMessage(topic, payload, packet?.retain ?? false);
  });

  started = true;
  log.info('consumer started', { subscriptions: consumerSubscriptions() });
}

async function handleMessage(topic: string, payload: Buffer, retained: boolean): Promise<void> {
  messageCount += 1;
  lastMessageAt = new Date().toISOString();
  topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
  metrics.mqttPayloadBytes.inc(payload.byteLength);

  try {
    const parsed = parseTopic(topic);

    if (parsed.kind === 'status' && parsed.gatewayId) {
      metrics.mqttMessagesReceived.inc({ kind: 'status' });
      await handleStatusMessage(parsed.gatewayId, payload, retained);
      return;
    }

    if (parsed.kind === 'response' || legacyResponseFilters().some((filter) => topicMatches(filter, topic))) {
      metrics.mqttMessagesReceived.inc({ kind: 'response' });
      await handleCommandResponse(topic, payload);
      return;
    }

    if (parsed.kind === 'command') {
      // Our own outbound command echoed back by the broker. Not telemetry.
      metrics.mqttMessagesReceived.inc({ kind: 'command' });
      return;
    }

    metrics.mqttMessagesReceived.inc({ kind: 'telemetry' });
    metrics.ingestAccepted.inc({ transport: 'mqtt' });

    await ingest({
      transport: 'MQTT',
      raw: payload,
      topic,
      // On our own namespace the topic segment is a reliable identifier; on a
      // vendor namespace it is only a hint, and the payload still wins.
      assertedGatewayUid: parsed.gatewayId ?? gatewayHintFromTopic(topic),
      contentType: 'application/json',
      mqttClientId: null,
    });

    if (retained) log.debug('message was a retained broker copy', { topic });
  } catch (error) {
    errorCount += 1;
    log.error('failed to accept an MQTT message', {
      event: LogEvent.PROCESSING_FAILED,
      topic,
      bytes: payload.byteLength,
      error,
    });
  }
}

/**
 * Online/offline announcements, including the broker-published last will
 * (spec section 14).
 *
 * Status is treated as corroborating evidence, never as the sole source of
 * truth: the health monitor independently derives status from last_seen_at, so
 * a gateway whose LWT never fires - or whose firmware has no LWT support - is
 * still detected as offline.
 */
async function handleStatusMessage(gatewayUid: string, payload: Buffer, retained: boolean): Promise<void> {
  const text = payload.toString('utf8').trim();
  let state: string | null = null;

  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const raw = body.status ?? body.state ?? body.online ?? body.connected;
    if (typeof raw === 'string') state = raw.toLowerCase();
    else if (typeof raw === 'boolean') state = raw ? 'online' : 'offline';
  } catch {
    // Plenty of devices publish a bare "online" / "offline" string.
    state = /^(online|offline|connected|disconnected)$/i.test(text) ? text.toLowerCase() : null;
  }

  const gateway = await getGatewayByUid(gatewayUid);
  if (!gateway) {
    log.warn('status message from an unregistered gateway', {
      event: LogEvent.UNKNOWN_GATEWAY,
      gatewayUid,
      state,
    });
    return;
  }

  const now = new Date().toISOString();
  if (state === 'online' || state === 'connected') {
    await touchGatewaySeen(gateway.id, now);
    await setGatewayStatus(gateway.id, 'ONLINE');
  } else if (state === 'offline' || state === 'disconnected') {
    await setGatewayStatus(gateway.id, 'OFFLINE');
    log.warn('gateway announced itself offline', {
      event: LogEvent.DEVICE_OFFLINE,
      gatewayUid,
      viaLastWill: retained,
    });
  } else {
    log.debug('unrecognised status payload', { gatewayUid, preview: text.slice(0, 80) });
    return;
  }

  bus.emit('gateway.status', {
    gatewayId: gateway.id,
    gatewayUid: gateway.gatewayUid,
    status: state === 'online' || state === 'connected' ? 'ONLINE' : 'OFFLINE',
    previous: gateway.status,
    lastSeenAt: gateway.lastSeenAt,
    lastDataAt: gateway.lastDataAt,
  });
}

/**
 * Pull a plausible device id out of a vendor-shaped topic.
 *
 * A hint only: it is used when the payload names no gateway, and the pattern is
 * configurable because a vendor's topic layout is not ours to assume.
 */
export function gatewayHintFromTopic(topic: string): string | null {
  const segments = topic.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const verbs = new Set([
    'telemetry', 'data', 'status', 'state', 'up', 'uplink', 'event',
    'command', 'cmd', 'config', 'response', 'ack', 'gateways', 'v1',
  ]);
  const candidates = segments.slice(1).filter((segment) => !verbs.has(segment.toLowerCase()));
  return candidates[0] ?? null;
}

export function stopConsumer(): void {
  started = false;
}
