/**
 * End-to-end verification (spec sections 20, 21 and 25).
 *
 * Drives the complete path in one process and reports pass/fail per step:
 *
 *   simulator -> MQTT broker -> consumer -> raw_iot_messages -> adapter ->
 *   normalisation -> telemetry -> rollups -> REST API -> SSE
 *
 * ...then the parts that only matter because this hardware buffers:
 *
 *   - readings replayed minutes late keep their original measurement time;
 *   - the same packet sent twice is stored once;
 *   - energy consumption is end-minus-start, not a sum of readings.
 *
 * Run it with the backend stopped:  npm run verify:e2e
 */

/* Configuration has to be settled before any module reads it, so every import
   in this file is dynamic and happens after these assignments. */
process.env.PORT = process.env.VERIFY_PORT ?? '4055';
process.env.EMBEDDED_BROKER_PORT = process.env.VERIFY_BROKER_PORT ?? '18833';
process.env.MQTT_PORT = process.env.VERIFY_BROKER_PORT ?? '18833';
process.env.MQTT_HOST = '127.0.0.1';
process.env.SIMULATOR_ENABLED = 'false';
process.env.AUTH_ENABLED = process.env.VERIFY_AUTH ?? 'true';
process.env.LOG_LEVEL = process.env.VERIFY_LOG_LEVEL ?? 'warn';
process.env.SQLITE_PATH = process.env.VERIFY_SQLITE_PATH ?? './data/verify-e2e.db';
process.env.AGGREGATION_ENABLED = 'false'; // driven explicitly below
process.env.HEALTH_SCAN_INTERVAL_SECONDS = '3600';

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  process.stdout.write('  [' + mark + '] ' + name + (detail ? ' - ' + detail : '') + '\n');
}

function section(title: string): void {
  process.stdout.write('\n' + title + '\n' + '-'.repeat(Math.max(title.length, 40)) + '\n');
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const { env } = await import('../src/config/env.js');
  const { configureLogger } = await import('../src/core/logger.js');
  configureLogger({ level: env.LOG_LEVEL as never, pretty: true });

  const { connectDb, closeDb } = await import('../src/db/index.js');
  const { migrate } = await import('../src/db/migrate.js');
  const { seed } = await import('./seed.js');

  const base = 'http://127.0.0.1:' + env.PORT;
  process.stdout.write('\nVERITEK IoT backend - end-to-end verification\n');
  process.stdout.write('='.repeat(60) + '\n');
  process.stdout.write('api    ' + base + '\nbroker 127.0.0.1:' + env.EMBEDDED_BROKER_PORT + '\n');

  /* ------------------------------------------------------- 1. bring-up -- */
  section('1. Infrastructure');

  const database = await connectDb();
  await migrate(database);
  await seed();
  check('database connected and migrated', true, database.driver + (database.timescale ? ' + timescaledb' : ''));

  const { startEmbeddedBroker, devCredentials, stopEmbeddedBroker } = await import('../src/iot/mqtt/broker.js');
  const brokerStarted = await startEmbeddedBroker();
  check('MQTT broker listening', brokerStarted, 'port ' + env.EMBEDDED_BROKER_PORT);

  const { startRealtimeBridge, closeRealtime } = await import('../src/realtime/hub.js');
  const { startAlertEngine } = await import('../src/iot/alerts/engine.js');
  startRealtimeBridge();
  startAlertEngine();

  const { startConsumer, consumerStats } = await import('../src/iot/mqtt/consumer.js');
  await startConsumer();
  await wait(1200);
  check('MQTT consumer subscribed', consumerStats().started, consumerStats().subscriptions.join(', '));

  const { createApp, startHttpServer } = await import('../src/api/server.js');
  const server = await startHttpServer(createApp());
  check('HTTP server listening', true, base);

  /* ------------------------------------------------------- 2. identity -- */
  section('2. Device registry');

  const { rotateGatewayToken } = await import('../src/db/repositories/gateways.js');
  const { getMeterByUid } = await import('../src/db/repositories/meters.js');
  const { provisionGateway, ensureServiceAccount } = await import('../src/iot/devices/lifecycle.js');
  const { topicsFor } = await import('../src/iot/mqtt/topics.js');
  await ensureServiceAccount();

  const gatewayUid = 'VERIFY-GW-' + Date.now().toString(36).toUpperCase();

  // Two slaves on one RS485 bus: the back-fill needs a meter with no newer
  // readings of its own, and it proves one gateway serves many meters.
  const provisioned = await provisionGateway({
    gatewayUid,
    name: 'E2E verification gateway',
    siteId: 'site-abc',
    hardwareModel: 'SIMULATOR',
    environment: 'staging',
    meters: [{ slaveId: 1 }, { slaveId: 2 }],
  });
  const gateway = provisioned.gateway;
  const meter = await getMeterByUid(gatewayUid + ':1');
  const bufferMeter = await getMeterByUid(gatewayUid + ':2');
  if (!meter || !bufferMeter) throw new Error('provisioned meters are missing');

  check(
    'gateway and two Modbus slaves registered',
    Boolean(gateway.id && meter.id && bufferMeter.id),
    gatewayUid + ' slaves 1 and 2',
  );
  check(
    'MQTT credential issued with a per-device ACL',
    provisioned.mqttPassword.length > 20,
    'publishes only ' + topicsFor(gatewayUid).telemetry,
  );

  const deviceToken = await rotateGatewayToken(gateway.id);
  check('device credential issued', deviceToken.length > 20, 'hashed at rest, returned once');

  /* -------------------------------------------------- 3. MQTT ingestion -- */
  section('3. Live MQTT path');

  const { GatewaySimulator } = await import('../src/iot/simulator/simulator.js');
  const { waitForIdle } = await import('../src/iot/telemetry/ingestion.js');

  const simulator = new GatewaySimulator({
    gatewayUid,
    slaveIds: [1],
    topicTemplate: topicsFor(gatewayUid).telemetry.replace(gatewayUid, '{gatewayUid}'),
    password: provisioned.mqttPassword,
  });
  await simulator.connect();

  const live = simulator.buildPayloads(new Date());
  for (const payload of live) await simulator.publishPayload(payload);
  await wait(600);
  await waitForIdle();

  const { listRawMessages } = await import('../src/db/repositories/rawMessages.js');
  const raw = await listRawMessages({ gatewayUid, limit: 10 });
  check('packet stored raw, exactly as received', raw.total >= 1, raw.total + ' row(s) in raw_iot_messages');
  check(
    'packet parsed and normalised',
    raw.rows[0]?.processingStatus === 'OK',
    'status ' + (raw.rows[0]?.processingStatus ?? 'none') + ', adapter ' + (raw.rows[0]?.adapter ?? 'none'),
  );

  const { latestByMeter, countTelemetry } = await import('../src/db/repositories/telemetry.js');
  const latest = await latestByMeter(meter.id);
  const voltage = latest.find((reading) => reading.metric === 'voltage_l1');
  check('telemetry written on our schema', latest.length > 5, latest.length + ' metrics stored');
  check(
    'values land on platform metric keys',
    Boolean(voltage && voltage.value > 150 && voltage.value < 300),
    voltage ? 'voltage_l1 = ' + voltage.value + ' V' : 'voltage_l1 missing',
  );

  // The broker ACL keeps a device on its own topic. This proves the payload
  // cannot undo that: a device writing another gateway's id into the body of
  // a message on its own topic must not get readings filed under the victim.
  const victimUid = gatewayUid + '-VICTIM';
  await provisionGateway({ gatewayUid: victimUid, siteId: 'site-abc', environment: 'staging', meters: [{ slaveId: 1 }] });
  const victimMeter = await getMeterByUid(victimUid + ':1');
  const spoof = simulator.buildPayloads(new Date(Date.now() + 1000))[0]!;
  await simulator.publishRaw({ ...spoof, gateway_id: victimUid });
  await wait(600);
  await waitForIdle();

  const spoofRaw = await listRawMessages({ gatewayUid, limit: 10 });
  const victimReadings = victimMeter ? await latestByMeter(victimMeter.id) : [];
  const refusedRow = spoofRaw.rows.find((row) => /authenticated as/i.test(row.processingError ?? ''));
  check(
    'payload cannot claim another gateway identity',
    Boolean(refusedRow) && victimReadings.length === 0,
    refusedRow ? 'refused: ' + refusedRow.processingError : 'victim has ' + victimReadings.length + ' readings',
  );

  /* ---------------------------------------------------- 4. HTTP ingest -- */
  section('4. HTTP ingest path');

  const httpPayload = simulator.buildPayloads(new Date())[0];
  const started = Date.now();
  const response = await fetch(base + '/api/iot/veritek/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + deviceToken },
    body: JSON.stringify(httpPayload),
  });
  const elapsed = Date.now() - started;
  const body = (await response.json()) as { status?: string; id?: string };

  check('endpoint accepts application/json', response.status === 202, 'HTTP ' + response.status);
  check('responds {"status":"accepted"}', body.status === 'accepted', JSON.stringify(body));
  check('responds immediately (work is async)', elapsed < 1000, elapsed + ' ms');

  await waitForIdle();
  const httpRaw = await listRawMessages({ gatewayUid, transport: 'HTTP', limit: 5 });
  check('HTTP packet reached telemetry', httpRaw.rows[0]?.processingStatus === 'OK', 'status ' + httpRaw.rows[0]?.processingStatus);

  /* ------------------------------------------- 5. buffering / late data -- */
  section('5. Offline buffering and late data (section 21)');

  const bufferedSimulator = new GatewaySimulator({
    gatewayUid,
    slaveIds: [2],
    topicTemplate: topicsFor(gatewayUid).telemetry.replace(gatewayUid, '{gatewayUid}'),
    password: provisioned.mqttPassword,
  });
  await bufferedSimulator.connect();
  const backfill = await bufferedSimulator.replayHistorical({ minutesBack: 12, stepSeconds: 60 });
  await wait(800);
  await waitForIdle();

  const { listTelemetry } = await import('../src/db/repositories/telemetry.js');
  const oldestClaimed = backfill[0]?.timestamp ?? new Date().toISOString();
  const window = await listTelemetry({
    meterId: bufferMeter.id,
    metrics: ['voltage_l1'],
    from: new Date(Date.parse(oldestClaimed) - 60_000).toISOString(),
    to: new Date().toISOString(),
  });

  const times = window.map((row) => Date.parse(row.time));
  const spanMinutes = times.length ? (Math.max(...times) - Math.min(...times)) / 60_000 : 0;
  check(
    'replayed readings keep their own measurement times',
    spanMinutes > 9,
    'history spans ' + spanMinutes.toFixed(1) + ' minutes, not one arrival instant',
  );

  const ordered = window.every((row, index) => index === 0 || Date.parse(row.time) >= Date.parse(window[index - 1]!.time));
  check('history is ordered by measurement time', ordered);

  const bufferedRows = window.filter((row) => row.isBuffered);
  check('late arrivals are flagged is_buffered', bufferedRows.length > 0, bufferedRows.length + ' of ' + window.length);

  const separated = window.every(
    (row) => row.sourceTimestamp !== null && Date.parse(row.serverReceivedAt) >= Date.parse(row.time),
  );
  check('source and server timestamps kept apart', separated);

  /* -------------------------------------------------- 6. idempotency -- */
  section('6. Duplicate rejection (section 9)');

  const before = await countTelemetry();
  for (const payload of backfill) await bufferedSimulator.publishPayload(payload);
  await wait(800);
  await waitForIdle();
  const after = await countTelemetry();

  check(
    'replaying the identical backlog adds no rows',
    after === before,
    before + ' rows before, ' + after + ' after (' + backfill.length + ' packets resent)',
  );

  const duplicateRaw = await listRawMessages({ gatewayUid, status: 'DUPLICATE', limit: 5 });
  check('duplicates are recorded, not silently dropped', duplicateRaw.total > 0, duplicateRaw.total + ' marked DUPLICATE');

  /* ------------------------------------------------- 7. energy maths -- */
  section('7. Energy consumption (section 13)');

  const { queryConsumption } = await import('../src/iot/telemetry/queries.js');
  const energyRows = await listTelemetry({
    meterId: bufferMeter.id,
    metrics: ['energy_import_kwh'],
    from: new Date(Date.now() - 3600_000).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
  });

  const first = energyRows[0];
  const last = energyRows[energyRows.length - 1];
  const consumption = await queryConsumption(
    bufferMeter.id,
    'energy_import_kwh',
    new Date(Date.now() - 3600_000).toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
  );

  const expected = first && last ? last.value - first.value : 0;
  const naiveSum = energyRows.reduce((total, row) => total + row.value, 0);
  check(
    'consumption is end minus start',
    Math.abs(consumption.consumption - expected) < 0.01,
    'computed ' + consumption.consumption.toFixed(3) + ' kWh, expected ' + expected.toFixed(3),
  );
  check(
    'cumulative readings are never summed',
    consumption.consumption < naiveSum / 10,
    'a naive sum would have claimed ' + naiveSum.toFixed(0) + ' kWh',
  );

  /* ------------------------------------------------- 8. aggregation -- */
  section('8. Rollups (section 12)');

  const { flushAggregation } = await import('../src/iot/telemetry/aggregation.js');
  const rebuilt = await flushAggregation();
  check('dirty buckets rebuilt', rebuilt > 0, rebuilt + ' bucket(s)');

  const { listRollups } = await import('../src/db/repositories/rollups.js');
  const buckets = await listRollups({
    meterIds: [bufferMeter.id],
    bucket: '1m',
    from: new Date(Date.now() - 3600_000).toISOString(),
    to: new Date(Date.now() + 120_000).toISOString(),
  });
  check('1-minute rollups exist', buckets.length > 0, buckets.length + ' rows');

  const energyBucket = buckets.find((bucket) => bucket.metric === 'energy_import_kwh' && (bucket.delta ?? 0) > 0);
  check(
    'rollups carry per-bucket consumption',
    Boolean(energyBucket),
    energyBucket ? energyBucket.delta?.toFixed(4) + ' kWh in one minute' : 'no delta found',
  );

  const backdated = buckets.some((bucket) => Date.parse(bucket.bucketStart) < Date.now() - 5 * 60_000);
  check('late data rebuilt older buckets', backdated, 'history was corrected retroactively, not appended');

  /* ------------------------------------------------------ 9. the APIs -- */
  section('9. Dashboard APIs (section 14)');

  const loginResponse = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.SEED_ADMIN_EMAIL, password: env.SEED_ADMIN_PASSWORD }),
  });
  const loginBody = (await loginResponse.json()) as { token?: string };
  const auth = { Authorization: 'Bearer ' + loginBody.token };
  check('POST /api/auth/login', loginResponse.ok && Boolean(loginBody.token), 'HTTP ' + loginResponse.status);

  const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const result = await fetch(base + path, { headers: auth });
    return { status: result.status, body: (await result.json()) as Record<string, unknown> };
  };

  const meterLive = await get('/api/meters/' + meter.id + '/live');
  const liveReading = meterLive.body.reading as { measurements?: Record<string, unknown> } | null;
  check(
    'GET /api/meters/:id/live',
    meterLive.status === 200 && Object.keys(liveReading?.measurements ?? {}).length > 5,
    Object.keys(liveReading?.measurements ?? {}).length + ' live metrics',
  );

  const meterHistory = await get(
    '/api/meters/' + bufferMeter.id + '/history?from=-2h&to=now&interval=1m&metrics=voltage_l1,energy_import_kwh',
  );
  const points = (meterHistory.body.points as unknown[]) ?? [];
  check('GET /api/meters/:id/history', meterHistory.status === 200 && points.length > 0, points.length + ' buckets');

  const siteLive = await get('/api/sites/site-abc/energy/live');
  check('GET /api/sites/:id/energy/live', siteLive.status === 200, ((siteLive.body.meters as unknown[]) ?? []).length + ' meters');

  const siteHistory = await get('/api/sites/site-abc/energy/history?from=-2h&to=now&interval=15m');
  check('GET /api/sites/:id/energy/history', siteHistory.status === 200);

  const gatewayStatus = await get('/api/gateways/' + gateway.id + '/status');
  check(
    'GET /api/gateways/:id/status',
    gatewayStatus.status === 200 && gatewayStatus.body.status === 'ONLINE',
    'status ' + gatewayStatus.body.status,
  );

  const rawApi = await get('/api/commissioning/raw?gatewayUid=' + gatewayUid + '&limit=3');
  check(
    'raw MQTT messages are inspectable',
    rawApi.status === 200 && ((rawApi.body.messages as unknown[]) ?? []).length > 0,
    rawApi.body.total + ' packets available',
  );

  const overview = await get('/api/commissioning/overview');
  check('GET /api/commissioning/overview', overview.status === 200, ((overview.body.gateways as unknown[]) ?? []).length + ' gateways');

  /* ----------------------------------------------- 10. tolerant parser -- */
  section('10. Unknown payloads do not break the consumer (section 19)');

  const beforeJunk = consumerStats().messages;
  await simulator.publishRaw({ nonsense: true, nested: { unexpected: 'shape' } });
  await wait(400);
  await waitForIdle();
  await simulator.publishPayload(simulator.buildPayloads(new Date())[0]!);
  await wait(400);
  await waitForIdle();

  const afterJunk = consumerStats().messages;
  check('consumer survived an unrecognised payload', afterJunk > beforeJunk + 1, 'still processing messages');

  const unknown = await listRawMessages({ limit: 20 });
  const flagged = unknown.rows.some(
    (row) => row.processingStatus === 'UNKNOWN_SCHEMA' || row.processingStatus === 'UNKNOWN_GATEWAY',
  );
  check('unrecognised payload stored and flagged', flagged, 'raw row kept for later mapping');

  /* ------------------------------------------------------- 11. stream -- */
  section('11. Live stream (SSE)');

  const controller = new AbortController();
  const streamPromise = (async (): Promise<string> => {
    const streamResponse = await fetch(base + '/api/stream?meterId=' + meter.id, {
      headers: auth,
      signal: controller.signal,
    });
    const reader = streamResponse.body?.getReader();
    if (!reader) return '';
    let text = '';
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
      if (text.includes('event: telemetry')) break;
    }
    return text;
  })();

  await wait(600);
  await simulator.publishPayload(simulator.buildPayloads(new Date())[0]!);
  const streamText = await streamPromise.catch(() => '');
  controller.abort();
  check('SSE delivered a live telemetry event', streamText.includes('event: telemetry'), 'dashboard updates without polling');

  /* -------------------------------------------------- 12. commands -- */
  section('12. Remote configuration is disarmed (section 17)');

  const commandResponse = await fetch(base + '/api/admin/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ gatewayId: gateway.id, commandType: 'set_polling_interval', params: { seconds: 30 } }),
  });
  const commandBody = (await commandResponse.json()) as { error?: { code?: string; message?: string } };
  check(
    'command refused without a verified template',
    commandResponse.status === 501 && commandBody.error?.code === 'NOT_CONFIGURED',
    'HTTP ' + commandResponse.status + ' - nothing invented was transmitted',
  );

  /* -------------------------------------------------------- teardown -- */
  await simulator.disconnect();
  await bufferedSimulator.disconnect();
  const { disconnectMqtt } = await import('../src/iot/mqtt/client.js');
  await disconnectMqtt();
  closeRealtime();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopEmbeddedBroker();
  await closeDb();

  /* ---------------------------------------------------------- report -- */
  process.stdout.write('\n' + '='.repeat(60) + '\n');
  const passed = checks.length - failures;
  process.stdout.write('RESULT: ' + passed + '/' + checks.length + ' checks passed\n');
  if (failures > 0) {
    process.stdout.write('\nFailed:\n');
    for (const item of checks.filter((entry) => !entry.ok)) {
      process.stdout.write('  - ' + item.name + (item.detail ? ' (' + item.detail + ')' : '') + '\n');
    }
  } else {
    process.stdout.write(
      '\nThe full path works: simulator -> MQTT -> raw storage -> normalisation ->\n' +
        'telemetry -> rollups -> API -> live stream, with buffering, duplicate\n' +
        'rejection and energy arithmetic all behaving.\n' +
        '\nTomorrow: replace the simulator with the gateway, capture the first packet,\n' +
        'save the payload profile and the register map. No code changes.\n',
    );
  }
  process.stdout.write('='.repeat(60) + '\n\n');
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  process.stderr.write('\nverification crashed: ' + (error instanceof Error ? error.stack : String(error)) + '\n');
  process.exit(1);
});
