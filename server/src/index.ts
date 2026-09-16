import type { Server } from 'node:http';
import { env, mqttDisplayUrl, productionConfigWarnings } from './config/env.js';
import { LogEvent } from './core/logEvents.js';
import { configureLogger, createLogger } from './core/logger.js';
import type { LogLevel } from './core/logger.js';
import { createApp, startHttpServer } from './api/server.js';
import { closeDb, connectDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { startAlertEngine } from './iot/alerts/engine.js';
import { startHealthMonitor, stopHealthMonitor } from './iot/health/monitor.js';
import { startEmbeddedBroker, stopEmbeddedBroker, devCredentials } from './iot/mqtt/broker.js';
import { disconnectMqtt } from './iot/mqtt/client.js';
import { startConsumer, stopConsumer } from './iot/mqtt/consumer.js';
import { GatewaySimulator } from './iot/simulator/simulator.js';
import { startAggregationScheduler, stopAggregationScheduler } from './iot/telemetry/aggregation.js';
import { drainPendingBacklog } from './iot/telemetry/ingestion.js';
import { closeRealtime, startRealtimeBridge } from './realtime/hub.js';
import { ensureServiceAccount } from './iot/devices/lifecycle.js';
import { startMetricsRefresh, stopMetricsRefresh } from './observability/metrics.js';
import { startTlsMonitor, stopTlsMonitor } from './observability/tlsMonitor.js';
import { seed } from '../scripts/seed.js';

const log = createLogger('boot');

let httpServer: Server | null = null;
let simulator: GatewaySimulator | null = null;

async function main(): Promise<void> {
  configureLogger({ level: env.LOG_LEVEL as LogLevel, pretty: env.LOG_PRETTY });

  for (const warning of productionConfigWarnings()) {
    log.warn('production configuration warning: ' + warning);
  }

  /* -- 1. storage --------------------------------------------------------- */
  const database = await connectDb();
  if (env.DB_AUTO_MIGRATE) await migrate(database);

  // A fresh database with no metric catalogue cannot classify a single reading,
  // so the baseline is idempotently applied at boot.
  await seed();

  // The backend authenticates to the broker like any other client, through a
  // service account that is never a gateway's credential (spec section 9).
  const service = await ensureServiceAccount();
  if (service.created && service.password) {
    log.warn(
      'created MQTT service account ' + service.username + ' with a generated password. ' +
        'Set MQTT_PASSWORD to this value (shown once): ' + service.password,
    );
  }

  /* -- 2. broker ---------------------------------------------------------- */
  // Order matters: the embedded broker has to be listening before our own
  // client tries to connect to it.
  await startEmbeddedBroker();

  /* -- 3. pipeline consumers --------------------------------------------- */
  startRealtimeBridge();
  startAlertEngine();
  startAggregationScheduler();
  startHealthMonitor();
  if (env.METRICS_ENABLED) startMetricsRefresh(env.METRICS_REFRESH_SECONDS);
  // Renewal is automated; this is what notices when the automation stops.
  if (env.MQTT_TLS || env.TLS_CERT_PATH_FOR_EXPIRY_CHECK) startTlsMonitor();

  /* -- 4. transports ------------------------------------------------------ */
  await startConsumer();
  const app = createApp();
  httpServer = await startHttpServer(app);

  /* -- 5. anything stored but not yet processed -------------------------- */
  const replayed = await drainPendingBacklog();
  if (replayed) log.info('replayed stored packets on startup', { count: replayed });

  /* -- 6. simulator, when asked ------------------------------------------ */
  if (env.SIMULATOR_ENABLED) {
    simulator = new GatewaySimulator({ password: devCredentials()?.password });
    await simulator.connect();
    simulator.start();
    log.warn(
      'SIMULATOR_ENABLED=true - synthetic meter data is being published. ' +
        'Turn this off before the real gateway goes live.',
    );
  }

  log.info('backend ready', {
    event: LogEvent.SERVER_STARTED,
    http: 'http://' + env.HOST + ':' + env.PORT,
    commissioning: env.PUBLIC_BASE_URL + '/commissioning',
    mqtt: env.MQTT_ENABLED ? mqttDisplayUrl() : 'disabled',
    subscriptions: env.MQTT_SUBSCRIBE_TOPICS,
    database: database.driver + (database.timescale ? ' (timescaledb)' : ''),
  });
}

async function shutdown(signal: string): Promise<void> {
  log.info('shutting down', { event: LogEvent.SERVER_STOPPING, signal });

  stopConsumer();
  stopAggregationScheduler();
  stopHealthMonitor();
  stopMetricsRefresh();
  stopTlsMonitor();
  closeRealtime();

  await simulator?.disconnect();
  await disconnectMqtt();
  await stopEmbeddedBroker();

  if (httpServer) {
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  }
  await closeDb();

  log.info('shutdown complete');
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      log.error('shutdown failed', { error });
      process.exit(1);
    });
  });
}

process.on('unhandledRejection', (reason) => {
  // Never fatal: an unhandled rejection in one packet must not take the
  // ingestion process down (spec section 19).
  log.error('unhandled promise rejection', { error: reason });
});

process.on('uncaughtException', (error) => {
  log.error('uncaught exception', { error });
});

main().catch((error: unknown) => {
  log.error('failed to start', { error });
  process.exit(1);
});
