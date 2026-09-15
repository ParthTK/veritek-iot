import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { env, isProduction } from '../../config/env.js';
import { generateToken } from '../../core/hash.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import { findGatewayByToken, getGatewayByUid } from '../../db/repositories/gateways.js';
import { topicMatches } from '../adapters/jsonPath.js';

const log = createLogger('mqtt:broker');

/**
 * Embedded MQTT broker.
 *
 * Purpose: make the whole path - simulator, consumer, database, API, dashboard
 * - runnable today, on a laptop, with nothing installed. Production points
 * MQTT_HOST at Mosquitto or EMQX and sets EMBEDDED_BROKER_ENABLED=false;
 * `deploy/mosquitto/` carries the equivalent configuration for that broker.
 *
 * Even in development it enforces the two rules from spec section 18:
 * authentication is required (anonymous access is off unless explicitly turned
 * on), and a gateway may only touch its own topic namespace.
 */

interface BrokerClient {
  id: string;
  veritekUsername?: string;
  veritekNamespace?: string | null;
  veritekIsBackend?: boolean;
}

interface BrokerPacket {
  topic: string;
}

interface AedesLike {
  authenticate: (
    client: BrokerClient,
    username: string | undefined,
    password: Buffer | undefined,
    done: (error: (Error & { returnCode?: number }) | null, success: boolean) => void,
  ) => void;
  authorizePublish: (
    client: BrokerClient | null,
    packet: BrokerPacket,
    done: (error?: Error | null) => void,
  ) => void;
  authorizeSubscribe: (
    client: BrokerClient | null,
    sub: { topic: string },
    done: (error: Error | null, sub?: { topic: string } | null) => void,
  ) => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  handle: (stream: unknown) => void;
  close: (callback: () => void) => void;
}

let broker: AedesLike | null = null;
let server: Server | null = null;
let devPassword: string | null = null;
let clientCount = 0;

export function brokerStatus(): {
  running: boolean;
  port: number | null;
  clients: number;
  anonymous: boolean;
} {
  return {
    running: Boolean(server),
    port: server ? env.EMBEDDED_BROKER_PORT : null,
    clients: clientCount,
    anonymous: env.EMBEDDED_BROKER_ALLOW_ANONYMOUS,
  };
}

/** Credentials the simulator and other local test clients should use. */
export function devCredentials(): { username: string; password: string } | null {
  if (!devPassword) return null;
  return { username: env.EMBEDDED_BROKER_DEFAULT_USERNAME, password: devPassword };
}

export async function startEmbeddedBroker(): Promise<boolean> {
  if (!env.EMBEDDED_BROKER_ENABLED) return false;
  if (server) return true;

  if (isProduction) {
    log.warn(
      'the embedded broker is running in production. It is intended for commissioning only - ' +
        'point MQTT_HOST at a managed broker and set EMBEDDED_BROKER_ENABLED=false.',
    );
  }

  const options = { id: 'veritek-embedded-broker', concurrency: 100 };
  try {
    const module = (await import('aedes')) as unknown as {
      Aedes?: unknown;
      default?: unknown;
    };
    // aedes 1.x replaced `new Aedes()` with the async `Aedes.createBroker()`
    // and moved it onto the named export; 0.x only had the constructor. Both
    // are accepted so the pinned version can move without touching this file.
    const named = module.Aedes as { createBroker?: (options: unknown) => Promise<AedesLike> } | undefined;
    if (typeof named?.createBroker === 'function') {
      broker = await named.createBroker(options);
    } else {
      const Ctor = (module.default ?? module) as new (options?: unknown) => AedesLike;
      broker = new Ctor(options);
    }
  } catch (error) {
    log.error('could not start the embedded broker', { error });
    return false;
  }

  devPassword = env.EMBEDDED_BROKER_DEFAULT_PASSWORD ?? generateToken(12);

  broker.authenticate = (client, username, password, done) => {
    void authenticate(client, username, password)
      .then((ok) => {
        if (!ok) {
          log.warn('client authentication rejected', {
            event: LogEvent.BROKER_AUTH_FAILED,
            clientId: client?.id,
            username,
          });
          const error = new Error('Authentication failed') as Error & { returnCode?: number };
          error.returnCode = 4; // Bad username or password
          done(error, false);
          return;
        }
        done(null, true);
      })
      .catch((error: unknown) => {
        log.error('authentication check failed', { error });
        done(new Error('Authentication error'), false);
      });
  };

  broker.authorizePublish = (client, packet, done) => {
    if (!client) {
      done();
      return;
    }
    if (isAllowed(client, packet.topic)) {
      done();
      return;
    }
    log.warn('publish denied by ACL', {
      event: LogEvent.BROKER_ACL_DENIED,
      clientId: client.id,
      username: client.veritekUsername,
      topic: packet.topic,
      namespace: client.veritekNamespace,
    });
    done(new Error('Not authorised to publish to ' + packet.topic));
  };

  broker.authorizeSubscribe = (client, sub, done) => {
    if (!client || isAllowed(client, sub.topic)) {
      done(null, sub);
      return;
    }
    log.warn('subscribe denied by ACL', {
      event: LogEvent.BROKER_ACL_DENIED,
      clientId: client.id,
      topic: sub.topic,
    });
    done(new Error('Not authorised to subscribe to ' + sub.topic), null);
  };

  broker.on('client', (client) => {
    clientCount += 1;
    log.info('client connected', {
      event: LogEvent.BROKER_CLIENT_CONNECTED,
      clientId: (client as BrokerClient)?.id,
      clients: clientCount,
    });
  });

  broker.on('clientDisconnect', (client) => {
    clientCount = Math.max(0, clientCount - 1);
    log.info('client disconnected', {
      event: LogEvent.BROKER_CLIENT_DISCONNECTED,
      clientId: (client as BrokerClient)?.id,
      clients: clientCount,
    });
  });

  broker.on('clientError', (client, error) => {
    log.debug('client error', { clientId: (client as BrokerClient)?.id, error });
  });

  server = createServer((socket) => broker?.handle(socket));

  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(env.EMBEDDED_BROKER_PORT, () => resolve());
  });

  log.info('embedded broker listening', {
    event: LogEvent.BROKER_STARTED,
    port: env.EMBEDDED_BROKER_PORT,
    anonymous: env.EMBEDDED_BROKER_ALLOW_ANONYMOUS,
    defaultUsername: env.EMBEDDED_BROKER_DEFAULT_USERNAME,
  });

  if (!env.EMBEDDED_BROKER_DEFAULT_PASSWORD && !isProduction) {
    // Printed once, on purpose: without it nothing could connect to a broker
    // that (correctly) refuses anonymous clients.
    log.warn(
      'generated a one-off broker password for this run. Set EMBEDDED_BROKER_DEFAULT_PASSWORD ' +
        'in .env to keep it stable: ' + devPassword,
    );
  }

  return true;
}

async function authenticate(
  client: BrokerClient,
  username: string | undefined,
  password: Buffer | undefined,
): Promise<boolean> {
  const secret = password?.toString();

  // The backend's own connection.
  if (username === env.MQTT_USERNAME && env.MQTT_USERNAME) {
    if (env.MQTT_PASSWORD && secret !== env.MQTT_PASSWORD) return false;
    client.veritekIsBackend = true;
    client.veritekUsername = username;
    return true;
  }
  if (client.id === env.MQTT_CLIENT_ID && !env.MQTT_USERNAME) {
    client.veritekIsBackend = true;
    return true;
  }

  // A provisioned gateway: username is its uid, password is its device token.
  if (username && secret) {
    const gateway = await getGatewayByUid(username);
    if (gateway?.hasAuthToken) {
      const matched = await findGatewayByToken(secret);
      if (matched && matched.id === gateway.id) {
        client.veritekUsername = username;
        client.veritekNamespace = gateway.topicNamespace ?? null;
        return true;
      }
      return false;
    }
  }

  // Shared development credentials for the simulator and bench testing.
  if (username === env.EMBEDDED_BROKER_DEFAULT_USERNAME && secret === devPassword) {
    client.veritekUsername = username;
    client.veritekNamespace = null;
    return true;
  }

  return env.EMBEDDED_BROKER_ALLOW_ANONYMOUS && !username;
}

/**
 * Topic ACL.
 *
 * A gateway with a namespace is confined to it. Everything else is limited to
 * the namespaces the backend actually subscribes to, so even a shared
 * development credential cannot open an unrestricted public topic tree.
 */
function isAllowed(client: BrokerClient, topic: string): boolean {
  if (client.veritekIsBackend) return true;

  if (client.veritekNamespace) {
    return topicMatches(client.veritekNamespace + '/#', topic) || topic === client.veritekNamespace;
  }

  const roots = [...env.MQTT_SUBSCRIBE_TOPICS, env.MQTT_COMMAND_TOPIC, env.MQTT_STATUS_TOPIC]
    .filter(Boolean)
    .map((filter) => filter.replace(/\{gatewayUid\}/g, '+'));

  return roots.some((filter) => topicMatches(filter, topic) || topicMatches(rootOf(filter) + '/#', topic));
}

function rootOf(filter: string): string {
  return filter.split('/')[0] ?? filter;
}

export async function stopEmbeddedBroker(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  if (broker) {
    await new Promise<void>((resolve) => broker?.close(() => resolve()));
    broker = null;
  }
}
