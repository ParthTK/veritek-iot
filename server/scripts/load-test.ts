/**
 * Gateway fleet load test (spec section 27).
 *
 * Simulates many gateways connecting at once and reporting on a schedule, then
 * measures what the broker and backend actually did with the traffic.
 *
 *   npm run test:load -- --gateways 10
 *   npm run test:load -- --gateways 100 --meters 2 --interval 30 --duration 180
 *   npm run test:load -- --gateways 500 --interval 60 --duration 300 --host mqtt-staging.energy.example.com --tls
 *
 * Options
 *   --gateways N     simulated gateways            (default 10)
 *   --meters N       Modbus slaves per gateway     (default 2)
 *   --interval S     reporting interval, seconds   (default 30)
 *   --duration S     how long to run, seconds      (default 120)
 *   --qos 0|1        publish QoS                   (default 1)
 *   --padding N      extra payload bytes, to model a larger register set
 *   --ramp S         seconds to spread connections over (default 10)
 *   --host / --port / --tls          target a remote broker
 *   --username / --password          shared credential instead of provisioning
 *   --api http://host:4000           poll the backend for ingest-side numbers
 *
 * RUN THIS AGAINST STAGING. Pointing a 500-gateway test at production fills the
 * live database with synthetic readings that then have to be cleaned out.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';

const here = dirname(fileURLToPath(import.meta.url));

function flag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : 'true';
}
const has = (name: string): boolean => process.argv.includes('--' + name);
const num = (name: string, fallback: number): number => {
  const value = Number(flag(name));
  return Number.isFinite(value) ? value : fallback;
};

const config = {
  gateways: Math.max(1, num('gateways', 10)),
  meters: Math.max(1, num('meters', 2)),
  intervalSeconds: Math.max(1, num('interval', 30)),
  durationSeconds: Math.max(10, num('duration', 120)),
  qos: (num('qos', 1) === 0 ? 0 : 1) as 0 | 1,
  paddingBytes: Math.max(0, num('padding', 0)),
  rampSeconds: Math.max(0, num('ramp', 10)),
  api: flag('api'),
};

interface Sample {
  connectMs: number[];
  publishMs: number[];
  published: number;
  failed: number;
  connectFailures: number;
  disconnects: number;
}

const stats: Sample = {
  connectMs: [],
  publishMs: [],
  published: 0,
  failed: 0,
  connectFailures: 0,
  disconnects: 0,
};

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[index] ?? 0);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
  const { env } = await import('../src/config/env.js');
  const { configureLogger } = await import('../src/core/logger.js');
  configureLogger({ level: 'error', pretty: true });

  const host = flag('host') ?? env.MQTT_HOST;
  const port = num('port', has('tls') ? env.MQTT_PUBLIC_TLS_PORT : env.MQTT_PORT);
  const tls = has('tls') || env.MQTT_TLS;
  const url = (tls ? 'mqtts' : 'mqtt') + '://' + host + ':' + port;

  process.stdout.write('\nGATEWAY FLEET LOAD TEST\n' + '='.repeat(64) + '\n');
  process.stdout.write('broker     ' + url + '\n');
  process.stdout.write(
    'fleet      ' + config.gateways + ' gateways x ' + config.meters + ' meters, every ' +
      config.intervalSeconds + 's, QoS ' + config.qos + '\n',
  );
  process.stdout.write('duration   ' + config.durationSeconds + 's (ramp ' + config.rampSeconds + 's)\n');

  const expectedRate = (config.gateways * config.meters) / config.intervalSeconds;
  process.stdout.write('expected   ' + expectedRate.toFixed(1) + ' messages/sec at steady state\n\n');

  /* -- credentials ------------------------------------------------------- */
  const sharedUser = flag('username');
  const sharedPassword = flag('password');

  interface Device {
    uid: string;
    username: string;
    password: string;
    topic: string;
  }
  const devices: Device[] = [];

  const { topicsFor } = await import('../src/iot/mqtt/topics.js');

  if (sharedUser && sharedPassword) {
    process.stdout.write('using the supplied shared credential for every simulated gateway\n');
    for (let index = 0; index < config.gateways; index += 1) {
      const uid = 'LOAD-' + String(index + 1).padStart(4, '0');
      devices.push({ uid, username: sharedUser, password: sharedPassword, topic: topicsFor(uid).telemetry });
    }
  } else {
    // Provision real per-device credentials, so the test also exercises the
    // authentication path at fleet scale rather than one credential N times.
    process.stdout.write('provisioning ' + config.gateways + ' gateways with individual credentials...\n');
    const { connectDb } = await import('../src/db/index.js');
    const { migrate } = await import('../src/db/migrate.js');
    const { seed } = await import('./seed.js');
    const database = await connectDb();
    await migrate(database);
    await seed();

    const { provisionGateway } = await import('../src/iot/devices/lifecycle.js');
    const stamp = Date.now().toString(36).toUpperCase();
    for (let index = 0; index < config.gateways; index += 1) {
      const uid = 'LOAD-' + stamp + '-' + String(index + 1).padStart(4, '0');
      const result = await provisionGateway({
        gatewayUid: uid,
        siteId: 'site-onida',
        environment: 'staging',
        meters: Array.from({ length: config.meters }, (_unused, slave) => ({ slaveId: slave + 1 })),
        notes: 'Load test fixture. Safe to delete.',
      });
      devices.push({ uid, username: uid, password: result.mqttPassword, topic: result.topics.telemetry });
      if ((index + 1) % 50 === 0) process.stdout.write('  provisioned ' + (index + 1) + '\n');
    }
    process.stdout.write('  provisioned ' + devices.length + '\n\n');
  }

  /* -- connect, ramped --------------------------------------------------- */
  const { SimulatedMeter } = await import('../src/iot/simulator/meterModel.js');
  const { toSiteIso } = await import('../src/core/time.js');

  const clients: MqttClient[] = [];
  const meterModels = new Map<string, InstanceType<typeof SimulatedMeter>[]>();
  const rampDelay = config.rampSeconds > 0 ? (config.rampSeconds * 1000) / devices.length : 0;

  process.stdout.write('connecting...\n');
  const connectStart = Date.now();

  await Promise.all(
    devices.map(async (device, index) => {
      if (rampDelay) await wait(index * rampDelay);
      const started = Date.now();

      const client = mqtt.connect(url, {
        clientId: device.uid,
        username: device.username,
        password: device.password,
        clean: true,
        reconnectPeriod: 5000,
        connectTimeout: 20000,
        rejectUnauthorized: false,
      });
      clients.push(client);

      meterModels.set(
        device.uid,
        Array.from({ length: config.meters }, (_unused, slave) => new SimulatedMeter({ slaveId: slave + 1 })),
      );

      await new Promise<void>((resolve) => {
        let settled = false;
        client.once('connect', () => {
          if (settled) return;
          settled = true;
          stats.connectMs.push(Date.now() - started);
          resolve();
        });
        client.on('close', () => {
          if (settled) stats.disconnects += 1;
        });
        client.once('error', () => {
          if (settled) return;
          settled = true;
          stats.connectFailures += 1;
          resolve();
        });
        setTimeout(() => {
          if (!settled) {
            settled = true;
            stats.connectFailures += 1;
            resolve();
          }
        }, 25000);
      });
    }),
  );

  const connected = clients.filter((client) => client.connected).length;
  process.stdout.write(
    'connected  ' + connected + '/' + devices.length +
      ' in ' + ((Date.now() - connectStart) / 1000).toFixed(1) + 's' +
      (stats.connectFailures ? ' (' + stats.connectFailures + ' failed)' : '') + '\n\n',
  );

  if (connected === 0) {
    process.stdout.write('no gateway connected - check the broker address and credentials.\n');
    process.exit(1);
  }

  /* -- publish for the duration ------------------------------------------ */
  const padding = config.paddingBytes > 0 ? 'x'.repeat(config.paddingBytes) : undefined;
  const publishOnce = async (device: Device, client: MqttClient): Promise<void> => {
    const meters = meterModels.get(device.uid) ?? [];
    for (const meter of meters) {
      if (!client.connected) return;
      const reading = meter.sample(new Date());
      const payload = JSON.stringify({
        gateway_id: device.uid,
        slave_id: meter.slaveId,
        timestamp: toSiteIso(new Date(), 'Asia/Kolkata'),
        registers: reading,
        ...(padding ? { _padding: padding } : {}),
      });

      const started = Date.now();
      await new Promise<void>((resolve) => {
        client.publish(device.topic, payload, { qos: config.qos }, (error) => {
          if (error) stats.failed += 1;
          else {
            stats.published += 1;
            stats.publishMs.push(Date.now() - started);
          }
          resolve();
        });
        // A QoS 1 PUBACK that never arrives must not stall the whole fleet.
        setTimeout(resolve, 15000);
      });
    }
  };

  process.stdout.write('publishing for ' + config.durationSeconds + 's...\n');
  const runStart = Date.now();
  const deadline = runStart + config.durationSeconds * 1000;
  let lastReport = runStart;

  const intervalHandles: NodeJS.Timeout[] = [];
  const timers = devices.map((device, index) => {
    const client = clients[index];
    if (!client) return null;
    // Spread each gateway's first publish across the interval, so the fleet
    // does not report in a single synchronised burst.
    const offset = (index / devices.length) * config.intervalSeconds * 1000;
    return setTimeout(() => {
      void publishOnce(device, client);
      const timer = setInterval(() => void publishOnce(device, client), config.intervalSeconds * 1000);
      timer.unref?.();
      intervalHandles.push(timer);
    }, offset);
  });

  while (Date.now() < deadline) {
    await wait(1000);
    if (Date.now() - lastReport >= 15000) {
      const elapsed = (Date.now() - runStart) / 1000;
      process.stdout.write(
        '  t+' + Math.round(elapsed) + 's  published=' + stats.published +
          '  rate=' + (stats.published / elapsed).toFixed(1) + '/s' +
          '  p95 publish=' + percentile(stats.publishMs, 95) + 'ms' +
          '  failed=' + stats.failed + '\n',
      );
      lastReport = Date.now();
    }
  }

  for (const timer of timers) if (timer) clearTimeout(timer);
  for (const timer of intervalHandles) clearInterval(timer);

  const elapsedSeconds = (Date.now() - runStart) / 1000;
  process.stdout.write('\ndraining...\n');
  await wait(5000);

  /* -- ingest-side numbers ----------------------------------------------- */
  let ingest: Record<string, unknown> | null = null;
  if (config.api) {
    try {
      const response = await fetch(config.api.replace(/\/$/, '') + '/api/health/detail');
      if (response.ok) ingest = (await response.json()) as Record<string, unknown>;
    } catch {
      process.stdout.write('(could not reach the backend API for ingest-side numbers)\n');
    }
  }

  for (const client of clients) client.end(true);

  report({
    url,
    connected,
    elapsedSeconds,
    expectedRate,
    ingest,
  });
}

function report(context: {
  url: string;
  connected: number;
  elapsedSeconds: number;
  expectedRate: number;
  ingest: Record<string, unknown> | null;
}): void {
  const achieved = stats.published / context.elapsedSeconds;
  const lines = [
    '',
    '='.repeat(64),
    'LOAD TEST RESULT',
    '='.repeat(64),
    'broker                 ' + context.url,
    'gateways connected     ' + context.connected + '/' + config.gateways,
    'connect failures       ' + stats.connectFailures,
    'mid-test disconnects   ' + stats.disconnects,
    'messages published     ' + stats.published,
    'publish failures       ' + stats.failed,
    'achieved rate          ' + achieved.toFixed(1) + ' msg/s (expected ' + context.expectedRate.toFixed(1) + ')',
    'connect  p50/p95/p99   ' + percentile(stats.connectMs, 50) + ' / ' + percentile(stats.connectMs, 95) + ' / ' + percentile(stats.connectMs, 99) + ' ms',
    'publish  p50/p95/p99   ' + percentile(stats.publishMs, 50) + ' / ' + percentile(stats.publishMs, 95) + ' / ' + percentile(stats.publishMs, 99) + ' ms',
  ];

  if (context.ingest) {
    const database = (context.ingest.database ?? {}) as Record<string, unknown>;
    const ingestStats = (context.ingest.ingest ?? {}) as Record<string, unknown>;
    lines.push(
      '',
      'backend telemetry rows ' + String(database.telemetryRows ?? '?'),
      'dirty rollup buckets   ' + String(database.dirtyRollupBuckets ?? '?'),
      'ingest queue depth     ' + String(ingestStats.queued ?? '?'),
      'raw packets by status  ' + JSON.stringify(ingestStats.rawByStatus ?? {}),
    );
  }

  const errorRate = stats.published + stats.failed > 0 ? stats.failed / (stats.published + stats.failed) : 0;
  const healthy =
    context.connected === config.gateways &&
    errorRate < 0.01 &&
    achieved >= context.expectedRate * 0.9;

  lines.push(
    '',
    'verdict                ' + (healthy ? 'HEALTHY' : 'DEGRADED - see the numbers above'),
    '',
    'Interpretation:',
    '  connect failures      credential or broker connection-rate limits',
    '  rising publish p95    the broker or the backend is behind',
    '  achieved < expected   clients could not keep their schedule',
    '  queue depth climbing  ingestion is slower than arrival',
    '',
    'Also check on the host under test: broker CPU and memory, database write',
    'rate, and the Grafana "Connectivity and Ingestion" dashboard.',
    '='.repeat(64),
    '',
  );

  const text = lines.join('\n');
  process.stdout.write(text);

  const date = new Date().toISOString().slice(0, 10);
  const outDir = join(here, '..', 'docs', 'test-results');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'load-' + config.gateways + 'gw-' + date + '.md');
  writeFileSync(file, '# Load test - ' + config.gateways + ' gateways\n\n```\n' + text + '```\n');
  process.stdout.write('written to ' + file + '\n\n');

  process.exit(healthy ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write('\nload test crashed: ' + (error instanceof Error ? error.stack : String(error)) + '\n');
  process.exit(1);
});
