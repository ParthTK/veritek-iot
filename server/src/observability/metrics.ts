import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

/**
 * Prometheus metrics (spec section 19).
 *
 * Everything the brief asks to be visible - connections, message rates, auth
 * and ACL failures, malformed payloads, duplicates, reconnects, processing
 * latency, last telemetry per gateway - is exported here and scraped from
 * `/metrics`. Grafana dashboards in `deploy/grafana/` render them.
 *
 * Label discipline: gateway id appears only on the few gauges where per-device
 * detail is the point (`last telemetry seen`). High-rate counters are kept
 * unlabelled by gateway, because one series per device per counter is how a
 * Prometheus instance falls over once the estate reaches a few hundred sites.
 */

export const registry = new Registry();

registry.setDefaultLabels({ service: 'veritek-iot-backend' });
collectDefaultMetrics({ register: registry, prefix: 'veritek_' });

const counter = (name: string, help: string, labelNames: string[] = []): Counter<string> =>
  new Counter({ name, help, labelNames, registers: [registry] });

const gauge = (name: string, help: string, labelNames: string[] = []): Gauge<string> =>
  new Gauge({ name, help, labelNames, registers: [registry] });

export const metrics = {
  /* ------------------------------------------------------------ broker -- */
  brokerAuthSuccess: counter('veritek_mqtt_auth_success_total', 'Accepted MQTT CONNECT attempts.'),
  brokerAuthFailures: counter('veritek_mqtt_auth_failure_total', 'Rejected MQTT CONNECT attempts.'),
  brokerAclAllows: counter('veritek_mqtt_acl_allow_total', 'Permitted MQTT publish/subscribe checks.'),
  brokerAclDenials: counter('veritek_mqtt_acl_deny_total', 'Refused MQTT publish/subscribe checks.'),
  brokerControlConnected: gauge(
    'veritek_broker_control_connected',
    'Mosquitto dynamic-security control connection (1 connected). 0 means credentials cannot be changed.',
  ),
  brokerStat: gauge('veritek_broker_stat', 'Mosquitto $SYS statistics, one series per stat.', ['stat']),
  brokerMissingCredentials: gauge(
    'veritek_broker_missing_credentials',
    'Credentials active in the database but absent from the broker; each needs a rotation.',
  ),
  brokerUnknownClients: gauge(
    'veritek_broker_unknown_clients',
    'Broker clients the database did not issue. Disabled on sight.',
  ),

  /* -------------------------------------------------- consumer / client -- */
  mqttConnected: gauge('veritek_mqtt_connected', 'Backend MQTT consumer connection state (1 connected).'),
  mqttReconnects: counter('veritek_mqtt_reconnect_total', 'Backend MQTT reconnection attempts.'),
  mqttDisconnects: counter('veritek_mqtt_disconnect_total', 'Backend MQTT disconnections.'),
  mqttMessagesReceived: counter(
    'veritek_mqtt_messages_received_total',
    'MQTT messages received by the consumer.',
    ['kind'],
  ),
  mqttMessagesPublished: counter('veritek_mqtt_messages_published_total', 'MQTT messages published by the backend.'),
  mqttPayloadBytes: counter('veritek_mqtt_payload_bytes_total', 'Total bytes received over MQTT.'),

  /* ------------------------------------------------------------ ingest -- */
  ingestAccepted: counter('veritek_ingest_accepted_total', 'Packets accepted for processing.', ['transport']),
  ingestProcessed: counter('veritek_ingest_processed_total', 'Packets processed, by outcome.', ['status']),
  ingestMalformed: counter('veritek_ingest_malformed_total', 'Packets that were not valid JSON.'),
  ingestDuplicates: counter('veritek_ingest_duplicate_total', 'Packets rejected as duplicates.'),
  ingestFailures: counter('veritek_ingest_failure_total', 'Packets that failed processing outright.'),
  ingestQueueDepth: gauge('veritek_ingest_queue_depth', 'Packets waiting to be processed.'),
  telemetryRowsWritten: counter('veritek_telemetry_rows_written_total', 'Telemetry rows inserted.'),

  /* ----------------------------------------------------------- latency -- */
  processingLatency: new Histogram({
    name: 'veritek_ingest_processing_seconds',
    help: 'Time from raw packet stored to telemetry written.',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  }),
  endToEndLag: new Histogram({
    name: 'veritek_telemetry_lag_seconds',
    help: 'Measurement time to server receipt. Large values mean buffered replay.',
    buckets: [1, 5, 15, 30, 60, 300, 900, 3600, 21600, 86400],
    registers: [registry],
  }),

  /* ----------------------------------------------------------- devices -- */
  gatewaysTotal: gauge('veritek_gateways_total', 'Registered gateways by status.', ['status']),
  metersTotal: gauge('veritek_meters_total', 'Registered meters.'),
  gatewayLastTelemetrySeconds: gauge(
    'veritek_gateway_last_telemetry_age_seconds',
    'Seconds since this gateway last delivered telemetry.',
    ['gateway_uid'],
  ),
  activeAlerts: gauge('veritek_active_alerts', 'Currently open alerts by severity.', ['severity']),

  /* -------------------------------------------------------------- infra -- */
  databaseUp: gauge('veritek_database_up', 'Database reachable (1 up).'),
  dirtyRollupBuckets: gauge('veritek_rollup_dirty_buckets', 'Rollup buckets awaiting recompute.'),
  realtimeSubscribers: gauge('veritek_realtime_subscribers', 'Connected SSE/WebSocket dashboard clients.'),
  tlsCertificateExpirySeconds: gauge(
    'veritek_tls_certificate_expiry_seconds',
    'Seconds until the MQTT TLS certificate expires. Alert when low.',
  ),
};

export async function metricsText(): Promise<string> {
  return registry.metrics();
}

export function metricsContentType(): string {
  return registry.contentType;
}

/**
 * Refresh the gauges that describe current state rather than counting events.
 * Called on a timer and immediately before a scrape-facing health check.
 */
export async function refreshStateMetrics(): Promise<void> {
  const [{ listGateways }, { listMeters }, { listActiveAlerts }, { countDirty }, { db }, { subscriberCount }] =
    await Promise.all([
      import('../db/repositories/gateways.js'),
      import('../db/repositories/meters.js'),
      import('../db/repositories/alerts.js'),
      import('../db/repositories/rollups.js'),
      import('../db/index.js'),
      import('../realtime/hub.js'),
    ]);

  try {
    await db().query('SELECT 1');
    metrics.databaseUp.set(1);
  } catch {
    metrics.databaseUp.set(0);
    // Without the database nothing below can be computed; leave the last known
    // device gauges in place rather than reporting a fleet of zeros.
    return;
  }

  const gateways = await listGateways();
  const byStatus = new Map<string, number>();
  const now = Date.now();

  metrics.gatewayLastTelemetrySeconds.reset();
  for (const gateway of gateways) {
    byStatus.set(gateway.status, (byStatus.get(gateway.status) ?? 0) + 1);
    if (gateway.lastDataAt) {
      metrics.gatewayLastTelemetrySeconds.set(
        { gateway_uid: gateway.gatewayUid },
        Math.round((now - Date.parse(gateway.lastDataAt)) / 1000),
      );
    }
  }

  metrics.gatewaysTotal.reset();
  for (const [status, count] of byStatus) metrics.gatewaysTotal.set({ status }, count);

  metrics.metersTotal.set((await listMeters()).length);
  metrics.dirtyRollupBuckets.set(await countDirty());
  metrics.realtimeSubscribers.set(subscriberCount().total);

  const alerts = await listActiveAlerts();
  const bySeverity = new Map<string, number>();
  for (const alert of alerts) bySeverity.set(alert.severity, (bySeverity.get(alert.severity) ?? 0) + 1);
  metrics.activeAlerts.reset();
  for (const [severity, count] of bySeverity) metrics.activeAlerts.set({ severity }, count);
}

let refreshTimer: NodeJS.Timeout | null = null;

export function startMetricsRefresh(intervalSeconds = 15): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshStateMetrics().catch(() => undefined);
  }, intervalSeconds * 1000);
  refreshTimer.unref?.();
}

export function stopMetricsRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}
