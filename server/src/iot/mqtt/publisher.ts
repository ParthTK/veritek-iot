import { env } from '../../config/env.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import { renderTemplate } from '../adapters/jsonPath.js';
import { getClient, isConnected } from './client.js';

const log = createLogger('mqtt:publisher');

export interface PublishOptions {
  qos?: 0 | 1 | 2;
  retain?: boolean;
}

/**
 * Publish to the broker.
 *
 * @returns false when there is no connection, so callers can record a command
 *          as unsent rather than silently losing it
 */
export async function publish(
  topic: string,
  payload: string | Buffer | Record<string, unknown>,
  options: PublishOptions = {},
): Promise<boolean> {
  const client = getClient();
  if (!client || !isConnected()) {
    log.warn('publish skipped: no broker connection', { topic });
    return false;
  }

  const body =
    typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);

  return new Promise<boolean>((resolve) => {
    client.publish(
      topic,
      body,
      { qos: options.qos ?? (env.MQTT_QOS as 0 | 1 | 2), retain: options.retain ?? env.MQTT_RETAIN },
      (error) => {
        if (error) {
          log.error('publish failed', { event: LogEvent.MQTT_ERROR, topic, error });
          resolve(false);
          return;
        }
        log.debug('published', {
          event: LogEvent.MQTT_PUBLISHED,
          topic,
          bytes: Buffer.byteLength(body as string | Buffer),
          retain: options.retain ?? env.MQTT_RETAIN,
        });
        resolve(true);
      },
    );
  });
}

/** Resolve a topic template such as `veritek/{gatewayUid}/command`. */
export function resolveTopic(template: string, values: Record<string, string | number | null>): string {
  return renderTemplate(template, values);
}

export function commandTopicFor(gatewayUid: string, override?: string | null): string {
  return resolveTopic(override ?? env.MQTT_COMMAND_TOPIC, { gatewayUid });
}

export function statusTopicFor(gatewayUid: string): string {
  return resolveTopic(env.MQTT_STATUS_TOPIC, { gatewayUid });
}
