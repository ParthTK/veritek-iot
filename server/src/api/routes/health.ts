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
import { lastReconcileReport } from '../../iot/mqtt/brokerDirectory.js';
import { dynsecState } from '../../iot/mqtt/dynsec.js';
import { requireAuth } from '../middleware/auth.js';
import { classifyGateway } from '../../iot/health/monitor.js';
import { ingestStats } from '../../iot/telemetry/ingestion.js';
import { subscriberCount } from '../../realtime/hub.js';

/**
 * Operational health (spec section 16).
 *
 *   GET /api/health         - simple up/down, safe for a load balancer
 *   GET /api/health/live    - liveness probe: process only, no dependencies
 *   GET /api/health/ready   - readiness probe: dependencies must be usable
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


  /**
   * Liveness: is this process wedged? It must not touch the database or the
   * broker - a database blip should not make the orchestrator kill and restart
   * a container that is otherwise fine (spec section 18).
   */
  router.get('/live', (_req, res) => {
    res.json({ status: 'alive', uptimeSeconds: Math.round(process.uptime()) });
  });

  /**
   * Readiness: should this instance receive traffic? Here the dependencies do
   * matter, so a container with no database is pulled out of the load balancer
   * rather than serving errors.
   */
  router.get('/ready', async (_req, res) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    try {
      await db().query('SELECT 1');
      checks.database = { ok: true };
    } catch (error) {
      checks.database = { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
    }

    const mqtt = connectionState();
    // MQTT down is degraded, not unready: HTTP ingestion and the dashboard APIs
    // still work, and packets already stored keep draining.
    checks.mqtt = { ok: !env.MQTT_ENABLED || mqtt.state === 'connected', detail: mqtt.state };

    const consumer = consumerStats();
    checks.mqttConsumer = { ok: !env.MQTT_ENABLED || consumer.started };

    const control = dynsecState();
    if (control.enabled) {
      // Degraded, not unready: devices still connect and publish without it,
      // only credential changes wait.
      checks.brokerControl = { ok: control.connected, detail: control.connected ? 'connected' : 'disconnected' };
    }

    const queue = ingestStats();
    checks.ingestQueue = {
      ok: queue.queued < env.INGEST_QUEUE_MAX * 0.9,
      detail: queue.queued + ' queued',
    };

    const ready = checks.database?.ok === true && checks.ingestQueue?.ok === true;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not-ready',
      environment: env.DEPLOY_ENVIRONMENT,
      checks,
      lastMqttMessageAt: consumer.lastMessageAt,
    });
  });

  // Signed-in only: device counts, database size, broker internals and the
  // reconciliation report (which names credentials) are reconnaissance for
  // anyone else. /live and /ready stay open for load balancers and uptime checks.
  router.get('/detail', requireAuth, async (_req, res) => {
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
        credentialAuthority: env.MQTT_BROKER_AUTH,
        brokerControl: dynsecState(),
        lastReconciliation: lastReconcileReport(),
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
