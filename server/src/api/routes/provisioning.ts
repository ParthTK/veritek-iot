import express from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { badRequest, notFound } from '../../core/errors.js';
import { getGateway, getGatewayByUid, listGateways } from '../../db/repositories/gateways.js';
import { listMeters } from '../../db/repositories/meters.js';
import {
  getCredentialById,
  listAuthEvents,
  listCredentials,
  setCredentialStatus,
} from '../../db/repositories/mqttCredentials.js';
import { applyStatus } from '../../iot/mqtt/brokerDirectory.js';
import {
  activateGateway,
  connectionProfileFor,
  decommissionGateway,
  provisionGateway,
  replaceGateway,
  revokeGateway,
  rotateCredentials,
  suspendGateway,
} from '../../iot/devices/lifecycle.js';
import { requireRole } from '../middleware/auth.js';
import { pathParam, stringParam } from '../rangeQuery.js';

/**
 * Device provisioning and lifecycle (spec sections 32 and 33).
 *
 *   POST /api/provisioning/gateways                  create + credential + ACL
 *   GET  /api/provisioning/gateways                  estate view
 *   GET  /api/provisioning/gateways/:id/profile      installer sheet (no secret)
 *   POST /api/provisioning/gateways/:id/activate     mark commissioned
 *   POST /api/provisioning/gateways/:id/suspend
 *   POST /api/provisioning/gateways/:id/revoke
 *   POST /api/provisioning/gateways/:id/decommission
 *   POST /api/provisioning/gateways/:id/rotate       new password, same identity
 *   POST /api/provisioning/gateways/:id/replace      swap in new hardware
 *   GET  /api/provisioning/credentials
 *   GET  /api/provisioning/auth-events               connections and denials
 *
 * The MQTT password appears in exactly one response - the one that creates or
 * rotates it - and is never stored in plaintext or returned again.
 */
export function createProvisioningRouter(): express.Router {
  const router = express.Router();
  router.use(requireRole('Admin'));

  const provisionSchema = z.object({
    gatewayUid: z
      .string()
      .min(3)
      .max(64)
      // The uid is also the MQTT username and appears in every topic, so keep
      // it to characters that are unambiguous on a broker and in a URL.
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, digits, hyphen or underscore, e.g. GW-MUM-001.'),
    name: z.string().optional(),
    siteId: z.string().nullish(),
    hardwareModel: z.string().nullish(),
    imei: z.string().nullish(),
    simNumber: z.string().nullish(),
    environment: z.enum(['staging', 'production']).optional(),
    meters: z
      .array(
        z.object({
          slaveId: z.number().int().min(1).max(247),
          meterName: z.string().optional(),
          meterModelId: z.string().nullish(),
        }),
      )
      .optional(),
    clientIdPattern: z.string().nullish(),
    notes: z.string().nullish(),
  });

  router.post('/gateways', async (req, res) => {
    const input = provisionSchema.parse(req.body);
    const result = await provisionGateway({ ...input, actor: req.user?.id ?? null });

    res.status(201).json({
      gateway: result.gateway,
      topics: result.topics,
      connection: result.connectionProfile,
      credential: {
        id: result.credential.id,
        username: result.credential.mqttUsername,
        status: result.credential.status,
        acl: result.credential.acl,
      },
      // The only time this value exists outside the device.
      mqttPassword: result.mqttPassword,
      note:
        'Record the password now - it is stored only as a hash and cannot be shown again. ' +
        'If it is lost, rotate the credential rather than re-provisioning the gateway.',
    });
  });

  router.get('/gateways', async (req, res) => {
    const gateways = await listGateways({ siteId: stringParam(req, 'siteId') });
    const meters = await listMeters();
    const credentials = await listCredentials({ kind: 'device' });
    const state = stringParam(req, 'lifecycleState');

    res.json({
      environment: env.DEPLOY_ENVIRONMENT,
      gateways: gateways
        .filter((gateway) => !state || gateway.lifecycleState === state)
        .map((gateway) => ({
          id: gateway.id,
          gatewayUid: gateway.gatewayUid,
          name: gateway.name,
          siteId: gateway.siteId,
          lifecycleState: gateway.lifecycleState,
          connectivity: gateway.status,
          environment: gateway.environment,
          commissionedAt: gateway.commissionedAt,
          decommissionedAt: gateway.decommissionedAt,
          replacedByGatewayId: gateway.replacedByGatewayId,
          lastSeenAt: gateway.lastSeenAt,
          lastDataAt: gateway.lastDataAt,
          meterCount: meters.filter((meter) => meter.gatewayId === gateway.id).length,
          credential: (() => {
            const credential = credentials.find((entry) => entry.gatewayId === gateway.id);
            return credential
              ? {
                  username: credential.mqttUsername,
                  status: credential.status,
                  lastAuthAt: credential.lastAuthAt,
                  authFailures: credential.authFailureCount,
                  aclDenials: credential.aclDenialCount,
                  lastRotatedAt: credential.lastRotatedAt,
                }
              : null;
          })(),
        })),
    });
  });

  /** The sheet an installer works from. Contains no secret. */
  router.get('/gateways/:gatewayId/profile', async (req, res) => {
    const gateway = await getGateway(pathParam(req, 'gatewayId'));
    if (!gateway) throw notFound('No gateway with id ' + pathParam(req, 'gatewayId'));

    const meters = await listMeters({ gatewayId: gateway.id });
    res.json({
      gateway: {
        id: gateway.id,
        gatewayUid: gateway.gatewayUid,
        name: gateway.name,
        lifecycleState: gateway.lifecycleState,
        environment: gateway.environment,
      },
      connection: connectionProfileFor(gateway.gatewayUid),
      meters: meters.map((meter) => ({
        meterUid: meter.meterUid,
        meterName: meter.meterName,
        slaveId: meter.slaveId,
        baudRate: meter.baudRate,
        parity: meter.parity,
        stopBits: meter.stopBits,
        meterModelId: meter.meterModelId,
      })),
      stillToConfirm: [
        'Modbus slave id, baud rate, parity and stop bits for each meter',
        'the meter register table (addresses, datatypes, byte/word order, scaling)',
        'whether this unit accepts our topic convention or insists on its own',
        "the unit's TLS support, which decides port 8883 versus 1883",
      ],
      note: 'The MQTT password is not included. Use the rotate endpoint if it has been lost.',
    });
  });

  const reasonSchema = z.object({ reason: z.string().min(3).max(500) });

  router.post('/gateways/:gatewayId/activate', async (req, res) => {
    const gateway = await activateGateway(pathParam(req, 'gatewayId'), req.user?.id ?? null);
    res.json({ gateway });
  });

  router.post('/gateways/:gatewayId/suspend', async (req, res) => {
    const { reason } = reasonSchema.parse(req.body);
    const gateway = await suspendGateway(pathParam(req, 'gatewayId'), reason, req.user?.id ?? null);
    res.json({ gateway, note: 'Broker access is refused from the next connection attempt.' });
  });

  router.post('/gateways/:gatewayId/revoke', async (req, res) => {
    const { reason } = reasonSchema.parse(req.body);
    const gateway = await revokeGateway(pathParam(req, 'gatewayId'), reason, req.user?.id ?? null);
    res.json({ gateway, note: 'Credentials revoked. Telemetry history is unaffected.' });
  });

  router.post('/gateways/:gatewayId/decommission', async (req, res) => {
    const gateway = await decommissionGateway(pathParam(req, 'gatewayId'), req.user?.id ?? null);
    res.json({ gateway, note: 'Gateway retired. Its meters are disabled; all history is retained.' });
  });

  router.post('/gateways/:gatewayId/rotate', async (req, res) => {
    const result = await rotateCredentials(pathParam(req, 'gatewayId'), req.user?.id ?? null);
    res.json({
      credential: {
        id: result.credential.id,
        username: result.credential.mqttUsername,
        status: result.credential.status,
        lastRotatedAt: result.credential.lastRotatedAt,
      },
      mqttPassword: result.mqttPassword,
      note: 'Shown once. Update the gateway before its current session drops.',
    });
  });

  router.post('/gateways/:gatewayId/replace', async (req, res) => {
    const input = provisionSchema.parse(req.body);
    const existing = await getGatewayByUid(input.gatewayUid);
    if (existing) throw badRequest('Gateway uid ' + input.gatewayUid + ' is already in use.');

    const result = await replaceGateway(pathParam(req, 'gatewayId'), input, req.user?.id ?? null);
    res.status(201).json({
      gateway: result.gateway,
      connection: result.connectionProfile,
      mqttPassword: result.mqttPassword,
      note:
        'Meters moved to the replacement gateway, so the site keeps one continuous history. ' +
        'The old unit is decommissioned and its telemetry retained.',
    });
  });

  /* ------------------------------------------------------- credentials -- */

  router.get('/credentials', async (req, res) => {
    const credentials = await listCredentials({
      gatewayId: stringParam(req, 'gatewayId'),
      kind: stringParam(req, 'kind') as never,
      status: stringParam(req, 'status') as never,
    });
    // No hash, no plaintext - the repository never exposes either.
    res.json({ credentials });
  });

  router.post('/credentials/:credentialId/status', async (req, res) => {
    const schema = z.object({
      status: z.enum(['active', 'suspended', 'revoked']),
      reason: z.string().max(500).optional(),
    });
    const { status, reason } = schema.parse(req.body);
    const credentialId = pathParam(req, 'credentialId');
    await setCredentialStatus(credentialId, status, reason ?? null);
    const credential = await getCredentialById(credentialId);
    if (!credential) throw notFound('No credential with id ' + credentialId);
    // With Mosquitto the broker holds its own copy; without this the change
    // would sit in the database until the next reconciliation.
    await applyStatus(credential);
    res.json({ ok: true, status });
  });

  /**
   * Broker connection log. The denials here are the evidence for the security
   * tests, and the first place to look when a site will not connect.
   */
  router.get('/auth-events', async (req, res) => {
    const deniedOnly = stringParam(req, 'denied');
    res.json({
      events: await listAuthEvents({
        allowed: deniedOnly === undefined ? undefined : !/^(1|true|yes)$/i.test(deniedOnly),
        mqttUsername: stringParam(req, 'username'),
        limit: 200,
      }),
    });
  });

  return router;
}
