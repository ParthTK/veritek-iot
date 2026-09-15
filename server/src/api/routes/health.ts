import express from 'express';
import { env, mqttDisplayUrl, productionConfigWarnings } from '../../config/env.js';
import { db } from '../../db/index.js';
import { listActiveAlerts } from '../../db/repositories/alerts.js';
import { listGateways } from '../../db/repositories/gateways.js';
import { listMeters } from '../../db/repositories/meters.js';
import { countByStatus } from '../../db/repositories/rawMessages.js';
import { countDirty } from '../../db/repositories/rollups.js';
import { countTelemetry } from '../../db/repositories/telemetry.js';
import { brokerStatus } from '../../iot/mqtt/broker.js';
import { connectionState } from '../../iot/mqtt/client.js';
import { consumerStats } from '../../iot/mqtt/consumer.js';
import { classifyGateway } from '../../iot/health/monitor.js';
import { ingestStats } from '../../iot/telemetry/ingestion.js';
import { subscriberCount } from '../../realtime/hub.js';

/**
 * Operational health (spec section 16).
 *
 *   GET /api/health         - liveness, safe to expose to a load balancer
 *   GET /api/health/detail  - the full picture for an operator
 */
export function createHealthRouter(): express.Router {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    let database = false;
    try {
      await db().query('SELECT 1');
      database = true;
    } catch {
      database = false;
    }

    const mqtt = connectionState();
    res.status(database ? 200 : 503).json({
      status: database ? 'ok' : 'degraded',
      at: new Date().toISOString(),
      database,
      mqtt: mqtt.state,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  router.get('/detail', async (_req, res) => {
    const gateways = await listGateways();
    const meters = await listMeters();
    const now = Date.now();

    const gatewayStates = gateways.map((gateway) => classifyGateway(gateway.lastSeenAt, now));
    const tally = (status: string): number => gatewayStates.filter((state) => state === status).length;

    res.json({
      at: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      database: {
        driver: db().driver,
        timescale: db().timescale,
        telemetryRows: await countTelemetry(),
        dirtyRollupBuckets: await countDirty(),
      },
      mqtt: {
        ...connectionState(),
        broker: mqttDisplayUrl(),
        consumer: consumerStats(),
        embeddedBroker: brokerStatus(),
      },
      ingest: {
        ...ingestStats(),
        rawByStatus: await countByStatus(),
        maxPayloadBytes: env.INGEST_MAX_PAYLOAD_BYTES,
        rateLimitPerMinute: env.INGEST_RATE_LIMIT_PER_MINUTE,
      },
      devices: {
        gateways: gateways.length,
        online: tally('ONLINE'),
        degraded: tally('DEGRADED'),
        offline: tally('OFFLINE'),
        unknown: tally('UNKNOWN'),
        meters: meters.length,
        metersReporting: meters.filter((meter) => meter.lastDataAt).length,
      },
      alerts: {
        active: (await listActiveAlerts()).length,
        enabled: env.ALERTS_ENABLED,
      },
      realtime: subscriberCount(),
      thresholds: {
        gatewayStaleAfterSeconds: env.GATEWAY_STALE_AFTER_SECONDS,
        gatewayOfflineAfterSeconds: env.GATEWAY_OFFLINE_AFTER_SECONDS,
        meterStaleAfterSeconds: env.METER_STALE_AFTER_SECONDS,
        bufferedThresholdSeconds: env.BUFFERED_THRESHOLD_SECONDS,
      },
      features: {
        commandsEnabled: env.COMMANDS_ENABLED,
        authEnabled: env.AUTH_ENABLED,
        aggregationEnabled: env.AGGREGATION_ENABLED,
        autoProvisionGateways: env.AUTO_PROVISION_GATEWAYS,
        autoProvisionMeters: env.AUTO_PROVISION_METERS,
        ingestRequiresAuth: env.INGEST_REQUIRE_AUTH,
      },
      configWarnings: productionConfigWarnings(),
    });
  });

  return router;
}
