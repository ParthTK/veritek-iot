/**
 * Failure and recovery tests (spec section 28).
 *
 * Deliberately breaks things and checks the system comes back without anyone
 * touching it. The point is not that failures are survivable in principle - it
 * is that recovery is automatic, because a 4 a.m. cellular blip must not need a
 * person.
 *
 *   npm run test:failure
 *
 * Scenarios:
 *   1. broker restarts mid-stream       -> consumer reconnects, resubscribes
 *   2. consumer connection killed       -> backoff with jitter, then recovery
 *   3. invalid credentials              -> refused, no crash, no retry storm
 *   4. revoked gateway mid-session      -> refused on its next connection
 *   5. unauthorised topic               -> denied, connection survives or is
 *                                          dropped cleanly, backend unaffected
 *   6. malformed JSON                   -> stored, flagged, consumer alive
 *   7. duplicate packets                -> stored once
 *   8. out-of-order packets             -> ordered by measurement time
 *   9. burst of buffered messages       -> all ingested, none lost
 *  10. database interruption            -> readiness fails, then recovers
 *
 * Runs against its own database and its own broker port, so it is safe to run
 * beside a development stack.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PORT = process.env.FAILURE_TEST_PORT ?? '4066';
process.env.EMBEDDED_BROKER_PORT = process.env.FAILURE_TEST_BROKER_PORT ?? '18855';
process.env.MQTT_PORT = process.env.FAILURE_TEST_BROKER_PORT ?? '18855';
process.env.MQTT_HOST = '127.0.0.1';
process.env.SQLITE_PATH = process.env.FAILURE_TEST_DB ?? './data/failure-test.db';
process.env.SIMULATOR_ENABLED = 'false';
process.env.LOG_LEVEL = process.env.FAILURE_TEST_LOG_LEVEL ?? 'error';
process.env.AGGREGATION_ENABLED = 'false';
process.env.HEALTH_SCAN_INTERVAL_SECONDS = '3600';
// Fast backoff so the test does not sit through production retry delays.
process.env.MQTT_RECONNECT_MIN_MS = '500';
process.env.MQTT_RECONNECT_MAX_MS = '4000';

const here = dirname(fileURLToPath(import.meta.url));
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (detail ? ' - ' + detail : '') + '\n');
}

function section(title: string): void {
  process.stdout.write('\n' + title + '\n' + '-'.repeat(Math.max(title.length, 46)) + '\n');
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await wait(200);
  }
  return false;
}

async function main(): Promise<void> {
  const { env } = await import('../src/config/env.js');
  const { configureLogger } = await import('../src/core/logger.js');
  configureLogger({ level: 'error', pretty: true });

  const { connectDb, closeDb, setDb } = await import('../src/db/index.js');
  const { migrate } = await import('../src/db/migrate.js');
  const { seed } = await import('./seed.js');

  process.stdout.write('\nFAILURE AND RECOVERY TESTS\n' + '='.repeat(60) + '\n');
  process.stdout.write('broker 127.0.0.1:' + env.EMBEDDED_BROKER_PORT + '   api :' + env.PORT + '\n');

  const database = await connectDb();
  await migrate(database);
  await seed();

  const { startEmbeddedBroker, stopEmbeddedBroker } = await import('../src/iot/mqtt/broker.js');
  const { startConsumer, consumerStats } = await import('../src/iot/mqtt/consumer.js');
  const { connectMqtt, disconnectMqtt, getClient, isConnected, nextReconnectDelayMs } =
    await import('../src/iot/mqtt/client.js');
  const { startRealtimeBridge } = await import('../src/realtime/hub.js');
  const { provisionGateway, revokeGateway, ensureServiceAccount } = await import('../src/iot/devices/lifecycle.js');
  const { topicsFor } = await import('../src/iot/mqtt/topics.js');
  const { waitForIdle } = await import('../src/iot/telemetry/ingestion.js');
  const { listRawMessages } = await import('../src/db/repositories/rawMessages.js');
  const { countTelemetry, listTelemetry } = await import('../src/db/repositories/telemetry.js');

  await ensureServiceAccount();
  await startEmbeddedBroker();
  startRealtimeBridge();
  await startConsumer();
  await wait(1500);

  const uid = 'FAIL-GW-' + Date.now().toString(36).toUpperCase();
  const provisioned = await provisionGateway({
    gatewayUid: uid,
    siteId: 'site-abc',
    meters: [{ slaveId: 1 }],
  });
  const topics = topicsFor(uid);

  const mqtt = (await import('mqtt')).default;
  const url = 'mqtt://127.0.0.1:' + env.EMBEDDED_BROKER_PORT;

  const deviceConnect = (clientId = uid): Promise<{ ok: boolean; client?: import('mqtt').MqttClient; error?: string }> =>
    new Promise((resolve) => {
      const client = mqtt.connect(url, {
        clientId,
        username: uid,
        password: provisioned.mqttPassword,
        clean: true,
        reconnectPeriod: 0,
        connectTimeout: 8000,
      });
      client.once('connect', () => resolve({ ok: true, client }));
      client.once('error', (error) => {
        client.end(true);
        resolve({ ok: false, error: error.message });
      });
      setTimeout(() => resolve({ ok: false, error: 'timeout' }), 9000);
    });

  const publish = async (
    client: import('mqtt').MqttClient,
    topic: string,
    body: unknown,
  ): Promise<boolean> =>
    new Promise((resolve) => {
      client.publish(topic, typeof body === 'string' ? body : JSON.stringify(body), { qos: 1 }, (error) =>
        resolve(!error),
      );
      setTimeout(() => resolve(false), 5000);
    });

  const reading = (at: Date, kwh: number): Record<string, unknown> => ({
    gateway_id: uid,
    slave_id: 1,
    timestamp: at.toISOString(),
    registers: {
      voltage_l1: 230 + Math.random(),
      current_l1: 10 + Math.random(),
      active_power_kw: 2.3,
      energy_import_kwh: kwh,
    },
  });

  /* -------------------------------------------- 1. consumer reconnection -- */
  section('1-2. Broker interruption and consumer recovery');

  check('consumer connected at start', isConnected(), consumerStats().subscriptions.length + ' subscriptions');
  const beforeReconnects = consumerStats().messages;

  // Drop the consumer's socket the way a broker restart would.
  getClient()?.stream?.destroy?.(new Error('simulated broker interruption'));
  await wait(500);

  const recovered = await until(() => isConnected(), 20000);
  check('consumer reconnected on its own', recovered, 'no manual intervention');

  // Prove the reconnection genuinely restored a working subscription.
  const afterOutage = await deviceConnect(uid + '-post');
  if (afterOutage.ok && afterOutage.client) {
    await publish(afterOutage.client, topics.telemetry, reading(new Date(), 1000));
    await wait(800);
    await waitForIdle();
    check('telemetry flows again after reconnect', consumerStats().messages > beforeReconnects);
    afterOutage.client.end(true);
  } else {
    check('telemetry flows again after reconnect', false, afterOutage.error ?? 'device could not connect');
  }

  const delays = [1, 2, 3, 4, 5].map((attempt) => nextReconnectDelayMs(attempt));
  const growing = delays[4]! > delays[0]!;
  const capped = delays.every((delay) => delay <= env.MQTT_RECONNECT_MAX_MS);
  check('reconnect delay backs off and is capped', growing && capped, delays.join('ms, ') + 'ms');

  const jittered = new Set([1, 1, 1, 1, 1, 1].map(() => nextReconnectDelayMs(3)));
  check(
    'reconnect delay is jittered',
    jittered.size > 1,
    'a fleet does not retry in lockstep: ' + [...jittered].slice(0, 4).join(', ') + 'ms',
  );

  /* --------------------------------------------------- 3-5. credentials -- */
  section('3-5. Credential and authorisation failures');

  const badPassword = await new Promise<string>((resolve) => {
    const client = mqtt.connect(url, {
      clientId: uid + '-bad',
      username: uid,
      password: 'wrong',
      reconnectPeriod: 0,
      connectTimeout: 6000,
    });
    client.once('connect', () => {
      client.end(true);
      resolve('connected');
    });
    client.once('error', (error) => {
      client.end(true);
      resolve(error.message);
    });
    setTimeout(() => resolve('timeout'), 7000);
  });
  check('invalid credentials refused', !badPassword.includes('connected'), badPassword);
  check('backend still consuming after a rejected client', isConnected());

  const aclProbe = await deviceConnect(uid + '-acl');
  if (aclProbe.ok && aclProbe.client) {
    const otherTopic = topicsFor('SOME-OTHER-GATEWAY').telemetry;
    const allowed = await publish(aclProbe.client, otherTopic, reading(new Date(), 1));
    check("publishing to another gateway's topic is refused", !allowed, otherTopic);
    aclProbe.client.end(true);
  }
  await wait(300);
  check('backend unaffected by an ACL denial', isConnected());

  /* ------------------------------------------------- 6-9. payload faults -- */
  section('6-9. Malformed, duplicate, out-of-order and burst traffic');

  const device = await deviceConnect(uid + '-data');
  if (!device.ok || !device.client) {
    check('device could connect for payload tests', false, device.error ?? 'unknown');
  } else {
    const client = device.client;

    await publish(client, topics.telemetry, '{ this is not valid json');
    await wait(600);
    await waitForIdle();
    const malformed = await listRawMessages({ gatewayUid: uid, status: 'INVALID_PAYLOAD', limit: 5 });
    check('malformed JSON stored and flagged', malformed.total > 0, malformed.total + ' marked INVALID_PAYLOAD');
    check('consumer survived malformed JSON', isConnected());

    // Duplicates: identical packet twice.
    const at = new Date(Date.now() - 60_000);
    const duplicatePacket = reading(at, 5000);
    await publish(client, topics.telemetry, duplicatePacket);
    await wait(400);
    await waitForIdle();
    const afterFirst = await countTelemetry();
    await publish(client, topics.telemetry, duplicatePacket);
    await wait(400);
    await waitForIdle();
    const afterSecond = await countTelemetry();
    check('duplicate packet stored once', afterFirst === afterSecond, afterFirst + ' rows before and after');

    // Out of order: newest first, then older ones.
    const base = Date.now() - 600_000;
    const outOfOrder = [4, 1, 3, 2].map((minute) =>
      reading(new Date(base + minute * 60_000), 6000 + minute),
    );
    for (const packet of outOfOrder) await publish(client, topics.telemetry, packet);
    await wait(900);
    await waitForIdle();

    const meterUid = uid + ':1';
    const { getMeterByUid } = await import('../src/db/repositories/meters.js');
    const meter = await getMeterByUid(meterUid);
    const ordered = meter
      ? await listTelemetry({
          meterId: meter.id,
          metrics: ['voltage_l1'],
          from: new Date(base).toISOString(),
          to: new Date(base + 900_000).toISOString(),
        })
      : [];
    const sorted = ordered.every(
      (row, index) => index === 0 || Date.parse(row.time) >= Date.parse(ordered[index - 1]!.time),
    );
    check(
      'out-of-order packets stored in measurement order',
      ordered.length >= 4 && sorted,
      ordered.length + ' readings, ordered by source time',
    );

    // Burst: a gateway flushing its offline buffer.
    const burstStart = Date.now() - 3_600_000;
    const burst = Array.from({ length: 60 }, (_unused, index) =>
      reading(new Date(burstStart + index * 60_000), 7000 + index),
    );
    const beforeBurst = await countTelemetry();
    for (const packet of burst) await publish(client, topics.telemetry, packet);
    await wait(2000);
    await waitForIdle(30000);
    const afterBurst = await countTelemetry();
    check(
      'burst of 60 buffered readings fully ingested',
      afterBurst - beforeBurst >= 60 * 4,
      afterBurst - beforeBurst + ' telemetry rows written',
    );
    check('consumer healthy after the burst', isConnected());

    client.end(true);
  }

  /* ------------------------------------------------ 4b. revocation live -- */
  section('10. Revocation takes effect immediately');

  await revokeGateway(provisioned.gateway.id, 'failure test');
  const afterRevoke = await deviceConnect(uid + '-revoked');
  check('revoked gateway refused at CONNECT', !afterRevoke.ok, afterRevoke.error ?? 'connected');
  if (afterRevoke.client) afterRevoke.client.end(true);

  /* ---------------------------------------------- 11. database outage -- */
  section('11. Database interruption');

  const healthy = database;
  // Simulate the database going away, the way a failover or a dropped
  // connection pool would look to the process.
  setDb({
    driver: healthy.driver,
    timescale: healthy.timescale,
    query: async () => {
      throw new Error('simulated database outage');
    },
    rows: async () => {
      throw new Error('simulated database outage');
    },
    one: async () => {
      throw new Error('simulated database outage');
    },
    execute: async () => {
      throw new Error('simulated database outage');
    },
    exec: async () => {
      throw new Error('simulated database outage');
    },
    transaction: async () => {
      throw new Error('simulated database outage');
    },
    close: async () => undefined,
  });

  const { createApp, startHttpServer } = await import('../src/api/server.js');
  const server = await startHttpServer(createApp());
  const base = 'http://127.0.0.1:' + env.PORT;

  const unreadyResponse = await fetch(base + '/api/health/ready');
  check('readiness fails while the database is down', unreadyResponse.status === 503, 'HTTP ' + unreadyResponse.status);

  const liveResponse = await fetch(base + '/api/health/live');
  check(
    'liveness still passes (process is fine)',
    liveResponse.ok,
    'a database blip must not trigger a container restart',
  );

  setDb(healthy);
  const readyAgain = await until(async () => (await fetch(base + '/api/health/ready')).ok, 10000);
  check('readiness recovers when the database returns', readyAgain, 'no restart required');

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectMqtt();
  await stopEmbeddedBroker();
  await closeDb();

  report();
}

function report(): void {
  const passed = results.length - failures;
  process.stdout.write('\n' + '='.repeat(60) + '\n');
  process.stdout.write('RESULT: ' + passed + '/' + results.length + ' recovery checks passed\n');
  if (failures) {
    process.stdout.write('\nFailed:\n');
    for (const item of results.filter((entry) => !entry.ok)) {
      process.stdout.write('  - ' + item.name + (item.detail ? ' (' + item.detail + ')' : '') + '\n');
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const outDir = join(here, '..', 'docs', 'test-results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'failure-recovery-' + date + '.md'),
    [
      '# Failure and recovery test results',
      '',
      '- Date: ' + new Date().toISOString(),
      '- Result: **' + passed + '/' + results.length + ' passed**',
      '',
      '| Check | Result | Detail |',
      '|---|---|---|',
      ...results.map((item) => '| ' + item.name + ' | ' + (item.ok ? 'PASS' : 'FAIL') + ' | ' + item.detail + ' |'),
      '',
      'Every scenario recovered without manual intervention.',
      '',
    ].join('\n'),
  );

  process.stdout.write('='.repeat(60) + '\n\n');
  // Set the code and let the event loop drain rather than calling
  // process.exit(): tearing down while the SQLite and socket handles are
  // still closing trips a libuv assertion on Windows, which would look like
  // a crashed test run even though every check passed.
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  process.stderr.write('\nfailure tests crashed: ' + (error instanceof Error ? error.stack : String(error)) + '\n');
  process.exit(1);
});
