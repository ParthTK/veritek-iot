import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { env } from '../../config/env.js';
import { createLogger } from '../../core/logger.js';
import { metrics } from '../../observability/metrics.js';
import type { AclSpec } from './topics.js';

const log = createLogger('mqtt:dynsec');

/**
 * Control-plane client for Mosquitto's Dynamic Security plugin.
 *
 * With Mosquitto, device credentials and ACLs live inside the broker (the
 * plugin keeps them in dynamic-security.json on its data volume) rather than
 * being looked up from our database on every CONNECT, as the EMQX webhooks do.
 * That is a deliberate trade:
 *
 *   + the broker keeps authenticating devices, and queueing their messages for
 *     us, while the backend is restarting or down - no message is dropped for
 *     want of an auth answer;
 *   - the broker holds its own copy of each verifier, so every change to a
 *     credential has to be pushed to it. That is this module's job, and
 *     brokerDirectory.ts decides what to push.
 *
 * The protocol: JSON commands published to $CONTROL/dynamic-security/v1, one
 * JSON reply per request on .../response. Each command carries correlationData,
 * which the reply echoes, so concurrent requests cannot be confused.
 *
 * This connection is broker-admin - it can create credentials - so it uses its
 * own identity (MQTT_CONTROL_USERNAME), never the ingestion account, and never
 * a device's.
 */

const CONTROL_TOPIC = '$CONTROL/dynamic-security/v1';
const RESPONSE_TOPIC = CONTROL_TOPIC + '/response';
const REQUEST_TIMEOUT_MS = 10_000;

/** Broker statistics mirrored into Prometheus. Topic -> metric name suffix. */
const SYS_TOPICS: Record<string, string> = {
  '$SYS/broker/clients/connected': 'clients_connected',
  '$SYS/broker/clients/total': 'clients_total',
  '$SYS/broker/clients/maximum': 'clients_maximum',
  '$SYS/broker/subscriptions/count': 'subscriptions',
  '$SYS/broker/store/messages/count': 'stored_messages',
  '$SYS/broker/store/messages/bytes': 'stored_bytes',
  '$SYS/broker/messages/received': 'messages_received',
  '$SYS/broker/messages/sent': 'messages_sent',
  '$SYS/broker/load/messages/received/1min': 'load_received_1min',
  '$SYS/broker/load/messages/sent/1min': 'load_sent_1min',
  '$SYS/broker/load/connections/1min': 'load_connections_1min',
  '$SYS/broker/bytes/received': 'bytes_received',
  '$SYS/broker/bytes/sent': 'bytes_sent',
  '$SYS/broker/uptime': 'uptime_seconds',
};

export interface DynsecAcl {
  acltype:
    | 'publishClientSend'
    | 'publishClientReceive'
    | 'subscribeLiteral'
    | 'subscribePattern'
    | 'unsubscribeLiteral'
    | 'unsubscribePattern';
  topic: string;
  allow: boolean;
  priority?: number;
}

export interface DynsecCommand {
  command: string;
  [key: string]: unknown;
}

export interface DynsecResponse {
  command: string;
  error?: string;
  data?: Record<string, unknown>;
  correlationData?: string;
}

export class DynsecError extends Error {
  readonly command: string;
  constructor(command: string, message: string) {
    super(command + ': ' + message);
    this.command = command;
    this.name = 'DynsecError';
  }
}

interface Pending {
  resolve: (response: DynsecResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

let client: MqttClient | null = null;
let connected = false;
const connectListeners: Array<() => void> = [];

/**
 * Run on every (re)connection. A broker restart is exactly when its directory
 * is most likely to have drifted - a restored or replaced data volume - so the
 * reconciler hangs off this rather than only off backend startup.
 */
export function onDynsecConnect(listener: () => void): void {
  connectListeners.push(listener);
}
let brokerStats: Record<string, number> = {};
const pending = new Map<string, Pending>();

export function isDynsecEnabled(): boolean {
  return env.MQTT_BROKER_AUTH === 'dynsec';
}

export function dynsecState(): { enabled: boolean; connected: boolean; broker: Record<string, number> } {
  return { enabled: isDynsecEnabled(), connected, broker: { ...brokerStats } };
}

/**
 * Translate our ACL spec into the plugin's vocabulary.
 *
 * Publish rules become publishClientSend. Subscribe rules become
 * subscribeLiteral - an exact-string match on the filter the client sends - so
 * a device granted its own command topic cannot widen that into a wildcard.
 * A rule that is itself a wildcard (the backend's `.../gateways/+/telemetry`)
 * is granted as a literal too, which lets the backend subscribe to exactly that
 * filter and nothing broader.
 */
export function aclToDynsec(acl: AclSpec): DynsecAcl[] {
  const rules: DynsecAcl[] = [];
  for (const topic of acl.publish) rules.push({ acltype: 'publishClientSend', topic, allow: true, priority: 0 });
  for (const topic of acl.subscribe) {
    rules.push({ acltype: 'subscribeLiteral', topic, allow: true, priority: 0 });
    if (topic.includes('+') || topic.includes('#')) {
      rules.push({ acltype: 'subscribePattern', topic, allow: true, priority: 0 });
    }
  }
  return rules;
}

function aclKey(rule: DynsecAcl): string {
  return rule.acltype + ' ' + rule.topic + ' ' + (rule.allow ? 'allow' : 'deny');
}

/** Connect the control client. Resolves once connected, or rejects on timeout. */
export async function connectDynsec(): Promise<void> {
  if (!isDynsecEnabled() || client) return;
  if (!env.MQTT_CONTROL_USERNAME || !env.MQTT_CONTROL_PASSWORD) {
    throw new Error(
      'MQTT_BROKER_AUTH=dynsec needs MQTT_CONTROL_USERNAME and MQTT_CONTROL_PASSWORD - the broker-admin ' +
        'identity the backend uses to manage device credentials.',
    );
  }

  const protocol = env.MQTT_TLS ? 'mqtts' : 'mqtt';
  const url = protocol + '://' + env.MQTT_HOST + ':' + env.MQTT_PORT;
  log.info('connecting control client', { broker: url, username: env.MQTT_CONTROL_USERNAME });

  client = mqtt.connect(url, {
    clientId: env.MQTT_CONTROL_CLIENT_ID,
    username: env.MQTT_CONTROL_USERNAME,
    password: env.MQTT_CONTROL_PASSWORD,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 3000,
    connectTimeout: 15_000,
    protocolVersion: 4,
    rejectUnauthorized: env.MQTT_TLS_REJECT_UNAUTHORIZED,
  });

  client.on('connect', () => {
    connected = true;
    metrics.brokerControlConnected.set(1);
    log.info('control client connected');
    client?.subscribe([RESPONSE_TOPIC, ...Object.keys(SYS_TOPICS)], { qos: 1 }, (error, granted) => {
      if (error) log.error('control subscription failed', { error });
      const refused = (granted ?? []).filter((grant) => grant.qos === 128).map((grant) => grant.topic);
      if (refused.length) log.error('broker refused control subscriptions', { refused });
      for (const listener of connectListeners) listener();
    });
  });
  client.on('close', () => {
    if (connected) log.warn('control client disconnected');
    connected = false;
    metrics.brokerControlConnected.set(0);
  });
  client.on('error', (error) => log.error('control client error', { error: error.message }));

  client.on('message', (topic, payload) => {
    if (topic === RESPONSE_TOPIC) {
      handleResponse(payload);
      return;
    }
    const name = SYS_TOPICS[topic];
    if (!name) return;
    // `$SYS/broker/uptime` reads "12345 seconds"; the rest are plain numbers.
    const value = Number.parseFloat(payload.toString('utf8'));
    if (!Number.isFinite(value)) return;
    brokerStats[name] = value;
    metrics.brokerStat.set({ stat: name }, value);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out connecting the dynsec control client')), 20_000);
    client?.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function disconnectDynsec(): Promise<void> {
  const current = client;
  client = null;
  connected = false;
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error('control client closed'));
  }
  pending.clear();
  if (current) await new Promise<void>((resolve) => current.end(false, {}, () => resolve()));
}

function handleResponse(payload: Buffer): void {
  let body: { responses?: DynsecResponse[] };
  try {
    body = JSON.parse(payload.toString('utf8')) as { responses?: DynsecResponse[] };
  } catch {
    log.warn('unparseable dynsec response');
    return;
  }
  for (const response of body.responses ?? []) {
    const id = response.correlationData;
    if (!id) continue;
    const entry = pending.get(id);
    // Another admin client's reply - the response topic is shared.
    if (!entry) continue;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(response);
  }
}

/**
 * Send commands and wait for every reply.
 *
 * Replies come back in order, but each is matched on its own correlationData
 * rather than position, so a reply can never be credited to the wrong command.
 * A command-level error is returned, not thrown: "client not found" is an
 * answer, and the caller decides whether it matters.
 */
export async function sendCommands(commands: DynsecCommand[]): Promise<DynsecResponse[]> {
  if (!client || !connected) throw new Error('dynsec control client is not connected');
  const current = client;

  const waits = commands.map((command) => {
    const correlationData = randomUUID();
    command.correlationData = correlationData;
    return new Promise<DynsecResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(correlationData);
        reject(new DynsecError(command.command, 'no reply from the broker within ' + REQUEST_TIMEOUT_MS + ' ms'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(correlationData, { resolve, reject, timer });
    });
  });

  await new Promise<void>((resolve, reject) => {
    current.publish(CONTROL_TOPIC, JSON.stringify({ commands }), { qos: 1 }, (error) =>
      error ? reject(error) : resolve(),
    );
  });

  return Promise.all(waits);
}

/** One command, throwing on any error except those listed as acceptable. */
async function run(command: DynsecCommand, tolerate: RegExp | null = null): Promise<DynsecResponse> {
  const [response] = await sendCommands([command]);
  if (!response) throw new DynsecError(command.command, 'empty reply');
  if (response.error && !(tolerate && tolerate.test(response.error))) {
    throw new DynsecError(command.command, response.error);
  }
  return response;
}

const NOT_FOUND = /not found/i;

/* --------------------------------------------------------------- reads -- */

export interface BrokerClient {
  username: string;
  clientid?: string;
  textname?: string;
  disabled?: boolean;
  roles?: Array<{ rolename: string }>;
}

export async function getBrokerClient(username: string): Promise<BrokerClient | null> {
  const response = await run({ command: 'getClient', username }, NOT_FOUND);
  if (response.error) return null;
  return ((response.data as { client?: BrokerClient } | undefined)?.client ?? null);
}

export async function listBrokerClients(): Promise<string[]> {
  const response = await run({ command: 'listClients', verbose: false, count: -1, offset: 0 });
  const clients = (response.data as { clients?: Array<string | { username: string }> } | undefined)?.clients ?? [];
  return clients.map((entry) => (typeof entry === 'string' ? entry : entry.username));
}

async function getRoleAcls(rolename: string): Promise<DynsecAcl[] | null> {
  const response = await run({ command: 'getRole', rolename }, NOT_FOUND);
  if (response.error) return null;
  return ((response.data as { role?: { acls?: DynsecAcl[] } } | undefined)?.role?.acls ?? []);
}

/* -------------------------------------------------------------- writes -- */

/**
 * Make a role hold exactly these ACLs - adding what is missing and removing
 * what is not asked for, so a narrowed ACL actually narrows.
 */
export async function ensureRole(rolename: string, acls: DynsecAcl[], textname?: string): Promise<void> {
  const current = await getRoleAcls(rolename);
  if (current === null) {
    await run({ command: 'createRole', rolename, textname: textname ?? rolename, acls });
    return;
  }

  const wanted = new Map(acls.map((rule) => [aclKey(rule), rule] as const));
  const present = new Map(current.map((rule) => [aclKey(rule), rule] as const));

  for (const [key, rule] of present) {
    if (!wanted.has(key)) await run({ command: 'removeRoleACL', rolename, acltype: rule.acltype, topic: rule.topic });
  }
  for (const [key, rule] of wanted) {
    if (!present.has(key)) await run({ command: 'addRoleACL', rolename, ...rule });
  }
}

export interface UpsertClientInput {
  username: string;
  /** Required to create; when given for an existing client, it replaces the password. */
  password?: string;
  roles: string[];
  textname?: string;
  /** Pin the MQTT client id the credential must present. */
  clientid?: string | null;
}

export type UpsertOutcome = 'created' | 'updated' | 'missing';

/**
 * Create a broker client, or bring an existing one in line.
 *
 * Returns 'missing' when the client does not exist and no password was
 * supplied: the broker needs the plaintext to create a verifier, and we keep
 * only a hash, so such a credential can only be restored by rotating it.
 */
export async function upsertBrokerClient(input: UpsertClientInput): Promise<UpsertOutcome> {
  const existing = await getBrokerClient(input.username);

  if (!existing) {
    if (!input.password) return 'missing';
    await run({
      command: 'createClient',
      username: input.username,
      password: input.password,
      textname: input.textname ?? input.username,
      roles: input.roles.map((rolename) => ({ rolename, priority: 0 })),
      ...(input.clientid ? { clientid: input.clientid } : {}),
    });
    return 'created';
  }

  if (input.password) await run({ command: 'setClientPassword', username: input.username, password: input.password });

  const have = new Set((existing.roles ?? []).map((role) => role.rolename));
  for (const rolename of input.roles) {
    if (!have.has(rolename)) await run({ command: 'addClientRole', username: input.username, rolename, priority: 0 });
  }
  for (const rolename of have) {
    if (!input.roles.includes(rolename)) await run({ command: 'removeClientRole', username: input.username, rolename });
  }

  const wantClientId = input.clientid ?? '';
  if ((existing.clientid ?? '') !== wantClientId) {
    await run({ command: 'setClientId', username: input.username, clientid: wantClientId });
  }
  if (existing.disabled) await run({ command: 'enableClient', username: input.username });
  return 'updated';
}

/** Block a client from connecting, and drop any session it has open now. */
export async function disableBrokerClient(username: string): Promise<void> {
  await run({ command: 'disableClient', username }, NOT_FOUND);
}

export async function enableBrokerClient(username: string): Promise<void> {
  await run({ command: 'enableClient', username }, NOT_FOUND);
}

/** Remove a client for good. The plugin disconnects it if it is online. */
export async function deleteBrokerClient(username: string): Promise<void> {
  await run({ command: 'deleteClient', username }, NOT_FOUND);
}

export async function deleteBrokerRole(rolename: string): Promise<void> {
  await run({ command: 'deleteRole', rolename }, NOT_FOUND);
}

/** Drop the live session(s) for a username without changing its credential. */
export async function kickBrokerClient(username: string): Promise<void> {
  // disable + enable is the plugin's documented way to kick; the credential
  // itself is untouched.
  await disableBrokerClient(username);
  await enableBrokerClient(username);
}
