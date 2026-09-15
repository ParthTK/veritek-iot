import { env } from '../../config/env.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import { topicMatches } from '../adapters/jsonPath.js';
import { ingest } from '../telemetry/ingestion.js';
import { handleCommandResponse } from '../commands/commandService.js';
import { connectMqtt, getClient } from './client.js';

const log = createLogger('mqtt:consumer');

/**
 * The MQTT consumer.
 *
 * Commissioning strategy (spec section 2): subscribe to a broad namespace such
 * as `technode/#` so the very first packet from the real gateway is captured
 * whatever topic it chooses, read the actual topic off the commissioning
 * screen, then narrow MQTT_SUBSCRIBE_TOPICS to the device-specific topic.
 *
 * Nothing in here may throw. An unexpected payload has to leave a log line and
 * a stored raw row, not kill the subscription (spec section 19).
 */

let started = false;
let messageCount = 0;
let errorCount = 0;
const topicCounts = new Map<string, number>();

export function consumerStats(): {
  started: boolean;
  messages: number;
  errors: number;
  topics: Array<{ topic: string; count: number }>;
  subscriptions: string[];
} {
  return {
    started,
    messages: messageCount,
    errors: errorCount,
    topics: [...topicCounts.entries()]
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50),
    subscriptions: [...env.MQTT_SUBSCRIBE_TOPICS],
  };
}

/** Topic patterns treated as command acknowledgements rather than telemetry. */
function commandAckFilters(): string[] {
  const filters: string[] = [];
  if (env.MQTT_COMMAND_TOPIC) {
    // A gateway usually answers on a sibling of the command topic.
    filters.push(env.MQTT_COMMAND_TOPIC.replace('{gatewayUid}', '+') + '/response');
    filters.push(env.MQTT_COMMAND_TOPIC.replace('{gatewayUid}', '+') + '/ack');
  }
  return filters;
}

export async function startConsumer(): Promise<void> {
  if (started) return;
  const client = await connectMqtt();
  if (!client) return;

  client.on('connect', () => {
    for (const filter of env.MQTT_SUBSCRIBE_TOPICS) {
      client.subscribe(filter, { qos: env.MQTT_QOS as 0 | 1 | 2 }, (error, granted) => {
        if (error) {
          log.error('subscription failed', { event: LogEvent.MQTT_ERROR, filter, error });
          return;
        }
        log.info('subscribed', {
          event: LogEvent.MQTT_SUBSCRIBED,
          filter,
          qos: granted?.[0]?.qos,
        });
      });
    }

    for (const filter of commandAckFilters()) {
      client.subscribe(filter, { qos: env.MQTT_QOS as 0 | 1 | 2 }, (error) => {
        if (!error) log.info('subscribed to command responses', { event: LogEvent.MQTT_SUBSCRIBED, filter });
      });
    }
  });

  client.on('message', (topic, payload, packet) => {
    void handleMessage(topic, payload, packet?.retain ?? false);
  });

  started = true;
  log.info('consumer started', { subscriptions: env.MQTT_SUBSCRIBE_TOPICS });
}

async function handleMessage(topic: string, payload: Buffer, retained: boolean): Promise<void> {
  messageCount += 1;
  topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);

  try {
    if (commandAckFilters().some((filter) => topicMatches(filter, topic))) {
      await handleCommandResponse(topic, payload);
      return;
    }

    await ingest({
      transport: 'MQTT',
      raw: payload,
      topic,
      // The gateway id is discovered from the payload during processing; the
      // topic segment is only a hint and is deliberately not trusted here.
      assertedGatewayUid: gatewayHintFromTopic(topic),
      contentType: 'application/json',
      mqttClientId: null,
    });

    if (retained) {
      log.debug('message was a retained broker copy', { topic });
    }
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
 * Pull a plausible device id out of the topic.
 *
 * Purely a hint: it is used only when the payload itself names no gateway, and
 * the pattern is configurable because Technode's topic layout is unknown.
 */
export function gatewayHintFromTopic(topic: string): string | null {
  const segments = topic.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  // Skip the vendor/root segment and any trailing verb such as
  // .../telemetry or .../status; what remains is most likely the device id.
  const verbs = new Set(['telemetry', 'data', 'status', 'state', 'up', 'uplink', 'event', 'command', 'cmd', 'config', 'response', 'ack']);
  const candidates = segments.slice(1).filter((segment) => !verbs.has(segment.toLowerCase()));
  return candidates[0] ?? null;
}

export function stopConsumer(): void {
  started = false;
}
