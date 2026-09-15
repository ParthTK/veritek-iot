import express from 'express';
import { badRequest, notFound } from '../../core/errors.js';
import { toSiteIso } from '../../core/time.js';
import { listCounterEvents, listCounterStates } from '../../db/repositories/energy.js';
import { getGateway } from '../../db/repositories/gateways.js';
import { getMeter, getMeterModel, listMeters, listRegisterMap } from '../../db/repositories/meters.js';
import { listMetricDefinitions } from '../../db/repositories/metrics.js';
import { siteTimezone } from '../../db/repositories/sites.js';
import { listMeterMetrics } from '../../db/repositories/telemetry.js';
import { queryConsumption, queryHistory, queryLive } from '../../iot/telemetry/queries.js';
import { listParam, parseRange, pathParam, stringParam } from '../rangeQuery.js';

/**
 * Meter-scoped dashboard APIs.
 *
 *   GET /api/meters
 *   GET /api/meters/:meterId
 *   GET /api/meters/:meterId/live
 *   GET /api/meters/:meterId/history?from=&to=&interval=15m
 *   GET /api/meters/:meterId/consumption?metric=energy_import_kwh&from=&to=
 *   GET /api/meters/:meterId/metrics
 *   GET /api/meters/:meterId/register-map
 */
export function createMetersRouter(): express.Router {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const meters = await listMeters({
      siteId: stringParam(req, 'siteId'),
      gatewayId: stringParam(req, 'gatewayId'),
    });
    res.json({ meters });
  });

  /** Multi-meter history, for cross-meter comparison charts. */
  router.get('/compare/history', async (req, res) => {
    const meterIds = listParam(req, 'meterIds');
    if (!meterIds?.length) throw badRequest('`meterIds` is required (comma separated).');

    const range = parseRange(req);
    const first = await getMeter(meterIds[0] as string);
    const result = await queryHistory({
      meterIds,
      siteId: first?.siteId ?? null,
      metrics: listParam(req, 'metrics'),
      from: range.from,
      to: range.to,
      interval: stringParam(req, 'interval'),
    });
    res.json(result);
  });

  router.get('/:meterId', async (req, res) => {
    const meter = await getMeter(pathParam(req, 'meterId'));
    if (!meter) throw notFound('No meter with id ' + pathParam(req, 'meterId'));

    const [model, gateway, counters] = await Promise.all([
      meter.meterModelId ? getMeterModel(meter.meterModelId) : Promise.resolve(null),
      meter.gatewayId ? getGateway(meter.gatewayId) : Promise.resolve(null),
      listCounterStates(meter.id),
    ]);

    res.json({
      meter,
      model,
      gateway: gateway
        ? {
            id: gateway.id,
            gatewayUid: gateway.gatewayUid,
            name: gateway.name,
            status: gateway.status,
            lastSeenAt: gateway.lastSeenAt,
          }
        : null,
      counters,
      reportedMetrics: await listMeterMetrics(meter.id),
    });
  });

  router.get('/:meterId/live', async (req, res) => {
    const meter = await getMeter(pathParam(req, 'meterId'));
    if (!meter) throw notFound('No meter with id ' + pathParam(req, 'meterId'));

    const timezone = await siteTimezone(meter.siteId);
    const readings = await queryLive([meter.id], timezone);

    res.json({
      meterId: meter.id,
      timezone,
      generatedAt: new Date().toISOString(),
      reading: readings[0] ?? null,
    });
  });

  router.get('/:meterId/history', async (req, res) => {
    const meter = await getMeter(pathParam(req, 'meterId'));
    if (!meter) throw notFound('No meter with id ' + pathParam(req, 'meterId'));

    const range = parseRange(req);
    const result = await queryHistory({
      meterIds: [meter.id],
      siteId: meter.siteId,
      metrics: listParam(req, 'metrics'),
      from: range.from,
      to: range.to,
      interval: stringParam(req, 'interval'),
    });

    res.json({ meterId: meter.id, ...result });
  });

  router.get('/:meterId/consumption', async (req, res) => {
    const meter = await getMeter(pathParam(req, 'meterId'));
    if (!meter) throw notFound('No meter with id ' + pathParam(req, 'meterId'));

    const metric = stringParam(req, 'metric') ?? 'energy_import_kwh';
    const range = parseRange(req);
    const result = await queryConsumption(meter.id, metric, range.from, range.to);
    const timezone = await siteTimezone(meter.siteId);

    res.json({
      ...result,
      timezone,
      fromLocal: toSiteIso(result.from, timezone),
      toLocal: toSiteIso(result.to, timezone),
    });
  });

  router.get('/:meterId/metrics', async (req, res) => {
    const meter = await getMeter(pathParam(req, 'meterId'));
    if (!meter) throw notFound('No meter with id ' + pathParam(req, 'meterId'));

    const reported = await listMeterMetrics(meter.id);
    const definitions = await listMetricDefinitions();
    const known = new Map(definitions.map((definition) => [definition.metricKey, definition] as const));

    res.json({
      meterId: meter.id,
      metrics: reported.map((metric) => ({
        metricKey: metric,
        definition: known.get(metric) ?? null,
      })),
    });
  });

  router.get('/:meterId/register-map', async (req, res) => {
    const meter = await getMeter(pathParam(req, 'meterId'));
    if (!meter) throw notFound('No meter with id ' + pathParam(req, 'meterId'));
    if (!meter.meterModelId) {
      res.json({
        meterId: meter.id,
        meterModelId: null,
        entries: [],
        note: 'This meter has no model assigned, so it has no register map yet.',
      });
      return;
    }

    res.json({
      meterId: meter.id,
      meterModelId: meter.meterModelId,
      model: await getMeterModel(meter.meterModelId),
      entries: await listRegisterMap(meter.meterModelId),
    });
  });

  router.get('/:meterId/counter-events', async (req, res) => {
    const meter = await getMeter(pathParam(req, 'meterId'));
    if (!meter) throw notFound('No meter with id ' + pathParam(req, 'meterId'));
    res.json({ meterId: meter.id, events: await listCounterEvents({ meterId: meter.id, limit: 200 }) });
  });

  return router;
}
