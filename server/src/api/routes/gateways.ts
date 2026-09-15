import express from 'express';
import { env } from '../../config/env.js';
import { notFound } from '../../core/errors.js';
import { getGateway, getGatewayHealth, listGateways } from '../../db/repositories/gateways.js';
import { listMeters } from '../../db/repositories/meters.js';
import { listCommands } from '../../db/repositories/commands.js';
import { listRawMessages } from '../../db/repositories/rawMessages.js';
import { classifyGateway } from '../../iot/health/monitor.js';
import { intParam, pathParam, stringParam } from '../rangeQuery.js';

/**
 * Gateway-scoped APIs.
 *
 *   GET /api/gateways
 *   GET /api/gateways/:gatewayId
 *   GET /api/gateways/:gatewayId/status
 *   GET /api/gateways/:gatewayId/raw     - recent packets, exactly as received
 */
export function createGatewaysRouter(): express.Router {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const gateways = await listGateways({ siteId: stringParam(req, 'siteId') });
    const meters = await listMeters();

    res.json({
      gateways: gateways.map((gateway) => ({
        ...gateway,
        // Recomputed rather than read, so a status is never stale between
        // health-monitor ticks.
        liveStatus: classifyGateway(gateway.lastSeenAt),
        meterCount: meters.filter((meter) => meter.gatewayId === gateway.id).length,
      })),
      thresholds: {
        staleAfterSeconds: env.GATEWAY_STALE_AFTER_SECONDS,
        offlineAfterSeconds: env.GATEWAY_OFFLINE_AFTER_SECONDS,
      },
    });
  });

  router.get('/:gatewayId', async (req, res) => {
    const gateway = await getGateway(pathParam(req, 'gatewayId'));
    if (!gateway) throw notFound('No gateway with id ' + pathParam(req, 'gatewayId'));

    res.json({
      gateway,
      liveStatus: classifyGateway(gateway.lastSeenAt),
      meters: await listMeters({ gatewayId: gateway.id }),
      health: await getGatewayHealth(gateway.id),
      commands: await listCommands({ gatewayId: gateway.id, limit: 20 }),
    });
  });

  router.get('/:gatewayId/status', async (req, res) => {
    const gateway = await getGateway(pathParam(req, 'gatewayId'));
    if (!gateway) throw notFound('No gateway with id ' + pathParam(req, 'gatewayId'));

    const health = await getGatewayHealth(gateway.id);
    const now = Date.now();
    const secondsSince = (iso: string | null): number | null =>
      iso ? Math.round((now - Date.parse(iso)) / 1000) : null;

    res.json({
      gatewayId: gateway.id,
      gatewayUid: gateway.gatewayUid,
      name: gateway.name,
      siteId: gateway.siteId,
      status: classifyGateway(gateway.lastSeenAt),
      storedStatus: gateway.status,
      enabled: gateway.enabled,
      lastSeenAt: gateway.lastSeenAt,
      lastDataAt: gateway.lastDataAt,
      secondsSinceLastSeen: secondsSince(gateway.lastSeenAt),
      secondsSinceLastData: secondsSince(gateway.lastDataAt),
      observedTopic: gateway.observedTopic,
      firmwareVersion: gateway.firmwareVersion,
      connectionType: gateway.connectionType,
      thresholds: {
        staleAfterSeconds: env.GATEWAY_STALE_AFTER_SECONDS,
        offlineAfterSeconds: env.GATEWAY_OFFLINE_AFTER_SECONDS,
      },
      counters: health,
    });
  });

  /**
   * The raw packet log for one gateway - the commissioning window into what the
   * hardware is actually sending, before any interpretation.
   */
  router.get('/:gatewayId/raw', async (req, res) => {
    const gateway = await getGateway(pathParam(req, 'gatewayId'));
    if (!gateway) throw notFound('No gateway with id ' + pathParam(req, 'gatewayId'));

    const result = await listRawMessages({
      gatewayUid: gateway.gatewayUid,
      limit: intParam(req, 'limit', 25),
      offset: intParam(req, 'offset', 0),
    });
    res.json({ gatewayId: gateway.id, ...result });
  });

  return router;
}
