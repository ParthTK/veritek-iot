import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import { getGateway } from '../../db/repositories/gateways.js';
import type { MqttCredential } from '../../db/repositories/mqttCredentials.js';
import {
  recordAclDenial,
  recordAuthEvent,
  recordAuthOutcome,
  verifyCredential,
} from '../../db/repositories/mqttCredentials.js';
import { aclAllows, renderAcl } from '../../iot/mqtt/topics.js';
import { metrics } from '../../observability/metrics.js';
import { rateLimit } from '../middleware/rateLimit.js';

const log = createLogger('broker:auth');

/**
 * Broker authentication and authorization callbacks (spec sections 5, 6, 8).
 *
 * EMQX is configured with an `http` authenticator and an `http` authorizer
 * pointing at these two endpoints. On every CONNECT the broker asks us whether
 * the credential is valid; on PUBLISH/SUBSCRIBE it asks whether that client may
 * touch that topic.
 *
 * Why this rather than a password file and an ACL file:
 *
 *   - provisioning a new site is an API call, not an edit-and-reload of broker
 *     config on every install (section 32);
 *   - revoking a leaked credential takes effect on the next connection attempt
 *     across the whole estate, with no broker restart (sections 6 and 33);
 *   - every allow and deny is recorded, which is the evidence the security
 *     tests in section 29 need.
 *
 * These endpoints are NOT public. They require a shared secret that only the
 * broker holds, and in deployment they are bound to the internal network - see
 * `deploy/` and the firewall notes.
 */

/** Constant-time compare so the shared secret cannot be probed byte by byte. */
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireBrokerSecret(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header('x-broker-secret') ?? undefined;
  if (!secretMatches(provided, env.BROKER_WEBHOOK_SECRET)) {
    log.warn('broker webhook called without a valid shared secret', {
      event: LogEvent.AUTH_FAILED,
      ip: req.ip,
      path: req.path,
    });
    // 'ignore' lets EMQX fall through to its next authenticator rather than
    // treating our misconfiguration as a positive allow.
    res.status(401).json({ result: 'ignore' });
    return;
  }
  next();
}

/* ------------------------------------------------- request normalisation -- */

interface BrokerRequest {
  clientId: string | null;
  username: string | null;
  password: string | null;
  topic: string | null;
  action: 'publish' | 'subscribe' | null;
  peerIp: string | null;
}

/**
 * EMQX field names vary a little between versions and between the placeholders
 * an operator writes into the config, so read them tolerantly.
 */
function readBrokerRequest(req: Request): BrokerRequest {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = body[key];
      if (typeof value === 'string' && value !== '') return value;
      if (typeof value === 'number') return String(value);
    }
    return null;
  };

  const rawAction = pick('action', 'access')?.toLowerCase() ?? null;
  const action =
    rawAction === 'publish' || rawAction === '2' ? 'publish'
      : rawAction === 'subscribe' || rawAction === '1' ? 'subscribe'
        : null;

  return {
    clientId: pick('clientid', 'client_id', 'clientId'),
    username: pick('username', 'user'),
    password: pick('password', 'pass'),
    topic: pick('topic'),
    action,
    peerIp: pick('peerhost', 'peername', 'ip', 'sockhost') ?? req.ip ?? null,
  };
}

/** A credential may pin the client id the device must present. */
function clientIdAllowed(credential: MqttCredential, clientId: string | null): boolean {
  if (!credential.clientIdPattern) return true;
  if (!clientId) return false;
  try {
    return new RegExp(credential.clientIdPattern).test(clientId);
  } catch {
    log.error('credential has an invalid client_id_pattern; ignoring the pin', {
      credentialId: credential.id,
    });
    return true;
  }
}

export function createBrokerAuthRouter(): express.Router {
  const router = express.Router();

  router.use(requireBrokerSecret);

  // A device stuck in a credential-retry loop must not be able to hammer the
  // database. Generous, because a site coming back after an outage reconnects
  // in a burst.
  router.use(
    rateLimit({
      perMinute: env.BROKER_WEBHOOK_RATE_LIMIT_PER_MINUTE,
      name: 'broker-webhook',
      keyFor: (req) => String((req.body as Record<string, unknown>)?.username ?? req.ip ?? 'unknown'),
    }),
  );

  /**
   * CONNECT. Answer `allow` only for an active credential with a matching
   * password, whose gateway (if it has one) is not suspended or decommissioned.
   */
  router.post('/auth', async (req, res) => {
    const request = readBrokerRequest(req);
    const deny = async (reason: string, credentialId?: string): Promise<void> => {
      metrics.brokerAuthFailures.inc();
      if (credentialId) await recordAuthOutcome(credentialId, false, request.peerIp);
      await recordAuthEvent({
        eventType: 'connect',
        mqttUsername: request.username,
        clientId: request.clientId,
        gatewayId: null,
        gatewayUid: null,
        topic: null,
        peerIp: request.peerIp,
        allowed: false,
        reason,
      });
      log.warn('broker CONNECT denied', {
        event: LogEvent.AUTH_FAILED,
        username: request.username,
        clientId: request.clientId,
        peerIp: request.peerIp,
        reason,
      });
      res.json({ result: 'deny' });
    };

    if (!request.username || !request.password) {
      // Anonymous connections are refused here as well as in broker config,
      // so the rule holds even if someone loosens the broker (section 5).
      await deny('anonymous or incomplete credentials');
      return;
    }

    const { credential, reason } = await verifyCredential(request.username, request.password);
    if (!credential) {
      await deny(reason);
      return;
    }

    if (!clientIdAllowed(credential, request.clientId)) {
      await deny('client id does not match the pinned pattern', credential.id);
      return;
    }

    if (credential.gatewayId) {
      const gateway = await getGateway(credential.gatewayId);
      if (!gateway) {
        await deny('gateway record missing', credential.id);
        return;
      }
      if (!gateway.enabled) {
        await deny('gateway is disabled', credential.id);
        return;
      }
      const lifecycle = String(gateway.lifecycleState ?? 'active').toLowerCase();
      if (lifecycle === 'revoked' || lifecycle === 'decommissioned' || lifecycle === 'suspended') {
        await deny('gateway lifecycle state is ' + lifecycle, credential.id);
        return;
      }
    }

    metrics.brokerAuthSuccess.inc();
    await recordAuthOutcome(credential.id, true, request.peerIp);
    await recordAuthEvent({
      eventType: 'connect',
      mqttUsername: credential.mqttUsername,
      clientId: request.clientId,
      gatewayId: credential.gatewayId,
      gatewayUid: credential.gatewayUid,
      topic: null,
      peerIp: request.peerIp,
      allowed: true,
      reason: 'ok',
    });

    log.info('broker CONNECT allowed', {
      event: LogEvent.BROKER_CLIENT_CONNECTED,
      username: credential.mqttUsername,
      clientId: request.clientId,
      kind: credential.kind,
      gatewayUid: credential.gatewayUid,
      peerIp: request.peerIp,
    });

    // is_superuser stays false even for the service account: it is bound by the
    // ACL below, so a bug there cannot silently grant it the whole topic tree.
    res.json({ result: 'allow', is_superuser: false });
  });

  /**
   * PUBLISH / SUBSCRIBE. The credential's stored ACL is the only authority; a
   * device that asks for a wildcard or for another gateway's topic is denied.
   */
  router.post('/acl', async (req, res) => {
    const request = readBrokerRequest(req);

    if (!request.username || !request.topic || !request.action) {
      res.json({ result: 'deny' });
      return;
    }

    const { getCredentialByUsername } = await import('../../db/repositories/mqttCredentials.js');
    const credential = await getCredentialByUsername(request.username);

    const denyAcl = async (reason: string): Promise<void> => {
      metrics.brokerAclDenials.inc();
      if (credential) await recordAclDenial(credential.id);
      await recordAuthEvent({
        eventType: request.action === 'publish' ? 'acl_publish' : 'acl_subscribe',
        mqttUsername: request.username,
        clientId: request.clientId,
        gatewayId: credential?.gatewayId ?? null,
        gatewayUid: credential?.gatewayUid ?? null,
        topic: request.topic,
        peerIp: request.peerIp,
        allowed: false,
        reason,
      });
      log.warn('broker ACL denied', {
        event: LogEvent.BROKER_ACL_DENIED,
        username: request.username,
        clientId: request.clientId,
        topic: request.topic,
        action: request.action,
        reason,
      });
      res.json({ result: 'deny' });
    };

    if (!credential) {
      await denyAcl('unknown username');
      return;
    }
    if (credential.status !== 'active') {
      await denyAcl('credential is ' + credential.status);
      return;
    }

    const templateValues = {
      gatewayId: credential.gatewayUid ?? '',
      gatewayUid: credential.gatewayUid ?? '',
    };
    const rules = renderAcl(
      request.action === 'publish' ? (credential.acl.publish ?? []) : (credential.acl.subscribe ?? []),
      templateValues,
    );

    if (!aclAllows(rules, request.topic)) {
      await denyAcl('topic not in the credential ACL');
      return;
    }

    metrics.brokerAclAllows.inc();
    // Allowed ACL checks are high-volume; they are counted, not written to the
    // audit table, which is reserved for connections and denials.
    res.json({ result: 'allow' });
  });

  return router;
}
