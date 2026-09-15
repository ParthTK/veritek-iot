import express from 'express';
import { notFound } from '../../core/errors.js';
import { listGateways } from '../../db/repositories/gateways.js';
import { listMeters } from '../../db/repositories/meters.js';
import { getSite, listSites } from '../../db/repositories/sites.js';
import { queryHistory, queryLive } from '../../iot/telemetry/queries.js';
import { listParam, parseRange, pathParam, stringParam } from '../rangeQuery.js';

/**
 * Site-scoped dashboard APIs.
 *
 *   GET /api/sites
 *   GET /api/sites/:siteId
 *   GET /api/sites/:siteId/energy/live
 *   GET /api/sites/:siteId/energy/history?from=&to=&interval=15m
 */
export function createSitesRouter(): express.Router {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    const sites = await listSites();
    const gateways = await listGateways();
    const meters = await listMeters();

    res.json({
      sites: sites.map((site) => ({
        ...site,
        gatewayCount: gateways.filter((gateway) => gateway.siteId === site.id).length,
        meterCount: meters.filter((meter) => meter.siteId === site.id).length,
        onlineGateways: gateways.filter((gateway) => gateway.siteId === site.id && gateway.status === 'ONLINE').length,
      })),
    });
  });

  router.get('/:siteId', async (req, res) => {
    const site = await getSite(pathParam(req, 'siteId'));
    if (!site) throw notFound('No site with id ' + pathParam(req, 'siteId'));

    res.json({
      site,
      gateways: await listGateways({ siteId: site.id }),
      meters: await listMeters({ siteId: site.id }),
    });
  });

  router.get('/:siteId/energy/live', async (req, res) => {
    const site = await getSite(pathParam(req, 'siteId'));
    if (!site) throw notFound('No site with id ' + pathParam(req, 'siteId'));

    const meters = await listMeters({ siteId: site.id });
    const readings = await queryLive(meters.map((meter) => meter.id), site.timezone);

    res.json({
      siteId: site.id,
      timezone: site.timezone,
      generatedAt: new Date().toISOString(),
      meters: readings,
    });
  });

  router.get('/:siteId/energy/history', async (req, res) => {
    const site = await getSite(pathParam(req, 'siteId'));
    if (!site) throw notFound('No site with id ' + pathParam(req, 'siteId'));

    const range = parseRange(req);
    const requestedMeters = listParam(req, 'meterIds');
    const meters = await listMeters({ siteId: site.id });
    const meterIds = requestedMeters
      ? meters.filter((meter) => requestedMeters.includes(meter.id)).map((meter) => meter.id)
      : meters.map((meter) => meter.id);

    const result = await queryHistory({
      meterIds,
      siteId: site.id,
      metrics: listParam(req, 'metrics'),
      from: range.from,
      to: range.to,
      interval: stringParam(req, 'interval'),
    });

    res.json({ siteId: site.id, ...result });
  });

  return router;
}
