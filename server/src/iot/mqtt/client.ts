import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';
import type { IClientOptions, MqttClient } from 'mqtt';
import { env, mqttDisplayUrl, mqttProtocol } from '../../config/env.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('mqtt:client');

/**
 * MQTT connection management.
 *
 * Every broker-facing setting is configuration, because none of it is known
 * yet: the topic tree, whether the unit speaks MQTT 3.1.1 or 5, whether it can
 * do TLS, and what authentication it supports are all open questions until the
 * gateway is on the bench (spec section 26). Changing any of them is an
 * environment change, not a code change.
 */

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

let client: MqttClient | null = null;
let state: ConnectionState = 'disconnected';
let connectedAt: string | null = null;
let lastError: string | null = null;
let reconnectCount = 0;
let hasConnectedOnce = false;

export function connectionState(): {
  state: ConnectionState;
  connectedAt: string | null;
  lastError: string | null;
  reconnects: number;
  broker: string;
  clientId: string;
} {
  return {
    state,
    connectedAt,
    lastError,
    reconnects: reconnectCount,
    // Never the password - see logger redaction rules.
    broker: mqttDisplayUrl(),
    clientId: env.MQTT_CLIENT_ID,
  };
}

function buildOptions(): IClientOptions {
  const options: IClientOptions = {
    clientId: env.MQTT_CLIENT_ID,
    clean: env.MQTT_CLEAN_SESSION,
    keepalive: env.MQTT_KEEPALIVE_SECONDS,
    reconnectPeriod: env.MQTT_RECONNECT_PERIOD_MS,
    connectTimeout: env.MQTT_CONNECT_TIMEOUT_MS,
    protocolVersion: env.MQTT_PROTOCOL_VERSION as 3 | 4 | 5,
    resubscribe: true,
  };

  if (env.MQTT_USERNAME) options.username = env.MQTT_USERNAME;
  if (env.MQTT_PASSWORD) options.password = env.MQTT_PASSWORD;

  if (env.MQTT_TLS) {
    options.rejectUnauthorized = env.MQTT_TLS_REJECT_UNAUTHORIZED;
    if (env.MQTT_TLS_CA_PATH) options.ca = readFileSync(env.MQTT_TLS_CA_PATH);
    if (env.MQTT_TLS_CERT_PATH) options.cert = readFileSync(env.MQTT_TLS_CERT_PATH);
    if (env.MQTT_TLS_KEY_PATH) options.key = readFileSync(env.MQTT_TLS_KEY_PATH);
  }

  // Last will: the broker announces our absence if this process dies, which is
  // what lets a dashboard distinguish "backend down" from "no data".
  if (env.MQTT_LWT_TOPIC) {
    options.will = {
      topic: env.MQTT_LWT_TOPIC,
      payload: Buffer.from(env.MQTT_LWT_PAYLOAD),
      qos: env.MQTT_LWT_QOS as 0 | 1 | 2,
      retain: env.MQTT_LWT_RETAIN,
    };
  }

  return options;
}

export function getClient(): MqttClient | null {
  return client;
}

export function isConnected(): boolean {
  return Boolean(client?.connected);
}

/**
 * Connect to the broker. Reconnection is handled by MQTT.js itself; this
 * wrapper exists to give every transition a log line with a stable event code.
 */
export async function connectMqtt(): Promise<MqttClient | null> {
  if (!env.MQTT_ENABLED) {
    log.warn('MQTT is disabled (MQTT_ENABLED=false); only HTTP ingestion is active.');
    return null;
  }
  if (client) return client;

  const url = mqttProtocol() + '://' + env.MQTT_HOST + ':' + env.MQTT_PORT;
  state = 'connecting';
  log.info('connecting to broker', {
    broker: mqttDisplayUrl(),
    clientId: env.MQTT_CLIENT_ID,
    protocolVersion: env.MQTT_PROTOCOL_VERSION,
    tls: env.MQTT_TLS,
    hasUsername: Boolean(env.MQTT_USERNAME),
  });

  client = mqtt.connect(url, buildOptions());

  client.on('connect', () => {
    state = 'connected';
    connectedAt = new Date().toISOString();
    lastError = null;
    log.info(hasConnectedOnce ? 'broker connection restored' : 'broker connected', {
      event: hasConnectedOnce ? LogEvent.MQTT_RECONNECTED : LogEvent.MQTT_CONNECTED,
      broker: mqttDisplayUrl(),
      clientId: env.MQTT_CLIENT_ID,
    });
    hasConnectedOnce = true;
  });

  client.on('reconnect', () => {
    state = 'reconnecting';
    reconnectCount += 1;
    log.warn('reconnecting to broker', {
      event: LogEvent.MQTT_DISCONNECTED,
      attempt: reconnectCount,
      broker: mqttDisplayUrl(),
    });
  });

  client.on('close', () => {
    if (state === 'connected') {
      log.warn('broker connection closed', { event: LogEvent.MQTT_DISCONNECTED, broker: mqttDisplayUrl() });
    }
    if (state !== 'reconnecting') state = 'disconnected';
  });

  client.on('offline', () => {
    state = 'disconnected';
    log.warn('client is offline', { event: LogEvent.MQTT_DISCONNECTED });
  });

  client.on('error', (error) => {
    state = 'error';
    lastError = error instanceof Error ? error.message : String(error);
    log.error('broker error', { event: LogEvent.MQTT_ERROR, error: lastError });
  });

  return client;
}

export async function disconnectMqtt(): Promise<void> {
  if (!client) return;
  const current = client;
  client = null;
  state = 'disconnected';
  await new Promise<void>((resolve) => {
    current.end(false, {}, () => resolve());
  });
  log.info('broker connection closed cleanly', { event: LogEvent.MQTT_DISCONNECTED });
}
