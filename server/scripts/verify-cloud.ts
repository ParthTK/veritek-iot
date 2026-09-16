/**
 * Cloud acceptance test (spec sections 25, 26 and 34).
 *
 * THE test. Everything else can pass while the system is still only working on
 * somebody's laptop; this one proves the real path:
 *
 *   this machine
 *      -> public internet (or a mobile hotspot)
 *      -> DNS name
 *      -> cloud MQTT broker, TLS, authenticated, ACL-enforced
 *      -> MQTT consumer
 *      -> raw ingestion
 *      -> normalisation
 *      -> telemetry database
 *      -> REST API
 *      -> live stream the dashboard consumes
 *
 * It talks to the deployment over the network only. It never imports the
 * backend's own modules or touches the database directly, because a test that
 * can reach the database is not testing what the gateway will experience.
 *
 *   npm run verify:cloud -- \
 *     --host mqtt-staging.energy.example.com \
 *     --api  https://api-staging.energy.example.com \
 *     --gateway GW-TEST-001 --password '<mqtt password>' \
 *     --user admin@example.com --pass '<dashboard password>'
 *
 *   --plain      use port 1883 instead of TLS 8883 (commissioning only)
 *   --insecure   accept an untrusted certificate (diagnosis only, never a pass)
 *
 * Run it twice: once on office wifi, once tethered to a phone (section 26).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect as tlsConnect } from 'node:tls';
import mqtt from 'mqtt';

const here = dirname(fileURLToPath(import.meta.url));

function flag(name: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : 'true';
}
const has = (name: string): boolean => process.argv.includes('--' + name);

const options = {
  host: flag('host'),
  port: Number(flag('port') ?? (has('plain') ? 1883 : 8883)),
  tls: !has('plain'),
  insecure: has('insecure'),
  gatewayUid: flag('gateway'),
  mqttPassword: flag('password'),
  api: (flag('api') ?? '').replace(/\/$/, ''),
  user: flag('user'),
  pass: flag('pass'),
  topicRoot: flag('topic-root') ?? 'energy/v1',
  network: flag('network') ?? 'unspecified',
};

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (detail ? ' - ' + detail : '') + '\n');
}

function section(title: string): void {
  process.stdout.write('\n' + title + '\n' + '-'.repeat(Math.max(title.length, 48)) + '\n');
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function usage(): never {
  process.stderr.write(
    '\nMissing required options.\n\n' +
      '  --host      MQTT hostname, e.g. mqtt-staging.energy.example.com\n' +
      '  --gateway   provisioned gateway uid (also the MQTT username)\n' +
      '  --password  that gateway\'s MQTT password\n' +
      '  --api       backend base URL, e.g. https://api-staging.energy.example.com\n' +
      '  --user/--pass  dashboard credentials, to read the data back\n\n',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  if (!options.host || !options.gatewayUid || !options.mqttPassword || !options.api) usage();

  const scheme = options.tls ? 'mqtts' : 'mqtt';
  const url = scheme + '://' + options.host + ':' + options.port;

  process.stdout.write('\nCLOUD ACCEPTANCE TEST\n' + '='.repeat(64) + '\n');
  process.stdout.write('broker    ' + url + '\n');
  process.stdout.write('api       ' + options.api + '\n');
  process.stdout.write('gateway   ' + options.gatewayUid + '\n');
  process.stdout.write('network   ' + options.network + '\n');

  /* ------------------------------------------------------------ 1. DNS -- */
  section('1. Name resolution and reachability');

  const dns = await import('node:dns/promises');
  let addresses: string[] = [];
  try {
    addresses = (await dns.lookup(options.host, { all: true })).map((entry) => entry.address);
    check('DNS resolves ' + options.host, addresses.length > 0, addresses.join(', '));
  } catch (error) {
    check('DNS resolves ' + options.host, false, error instanceof Error ? error.message : String(error));
    report();
    return;
  }

  const isPrivate = addresses.every((address) =>
    /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fe80:)/.test(address),
  );
  check(
    'resolves to a public address',
    !isPrivate,
    isPrivate ? 'private/loopback only - a 4G gateway could not reach this' : addresses[0] ?? '',
  );

  /* ------------------------------------------------------------ 2. TLS -- */
  if (options.tls) {
    section('2. TLS');

    const certificate = await new Promise<{
      ok: boolean;
      authorized: boolean;
      subject?: string;
      issuer?: string;
      validTo?: string;
      daysRemaining?: number;
      error?: string;
    }>((resolve) => {
      const socket = tlsConnect(
        {
          host: options.host,
          port: options.port,
          servername: options.host,
          rejectUnauthorized: false,
          timeout: 15000,
        },
        () => {
          const peer = socket.getPeerX509Certificate?.();
          const authorized = socket.authorized;
          const authError = socket.authorizationError;
          socket.end();
          if (!peer) return resolve({ ok: false, authorized: false, error: 'no certificate presented' });
          const validTo = new Date(peer.validTo);
          resolve({
            ok: true,
            authorized,
            subject: peer.subject,
            issuer: peer.issuer,
            validTo: validTo.toISOString(),
            daysRemaining: Math.floor((validTo.getTime() - Date.now()) / 86_400_000),
            error: authorized ? undefined : String(authError ?? 'not trusted'),
          });
        },
      );
      socket.on('timeout', () => {
        socket.destroy();
        resolve({ ok: false, authorized: false, error: 'timed out' });
      });
      socket.on('error', (error: Error) => resolve({ ok: false, authorized: false, error: error.message }));
    });

    check('TLS listener answers on ' + options.port, certificate.ok, certificate.error ?? '');
    check(
      'certificate is trusted by a public CA',
      certificate.authorized,
      certificate.authorized ? (certificate.issuer ?? '').replace(/\n/g, ' ') : (certificate.error ?? ''),
    );
    check(
      'certificate is not near expiry',
      (certificate.daysRemaining ?? -1) > 21,
      certificate.validTo ? certificate.daysRemaining + ' days remaining (expires ' + certificate.validTo + ')' : '',
    );
  } else {
    section('2. TLS');
    check(
      'TLS in use',
      false,
      '--plain was passed. Acceptable only inside a commissioning window; production must use 8883.',
    );
  }

  /* -------------------------------------------------- 3. authentication -- */
  section('3. Broker authentication over the public internet');

  const anonymous = await new Promise<string>((resolve) => {
    const client = mqtt.connect(url, {
      clientId: 'acceptance-anon-' + Date.now(),
      reconnectPeriod: 0,
      connectTimeout: 15000,
      rejectUnauthorized: !options.insecure,
    });
    client.once('connect', () => {
      client.end(true);
      resolve('connected');
    });
    client.once('error', (error) => {
      client.end(true);
      resolve(error.message);
    });
    setTimeout(() => resolve('timeout'), 16000);
  });
  check('anonymous connection refused', anonymous !== 'connected', anonymous);

  const connectStarted = Date.now();
  const device = await new Promise<{ ok: boolean; client?: mqtt.MqttClient; error?: string }>((resolve) => {
    const client = mqtt.connect(url, {
      clientId: options.gatewayUid,
      username: options.gatewayUid,
      password: options.mqttPassword,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 20000,
      rejectUnauthorized: !options.insecure,
    });
    client.once('connect', () => resolve({ ok: true, client }));
    client.once('error', (error) => {
      client.end(true);
      resolve({ ok: false, error: error.message });
    });
    setTimeout(() => resolve({ ok: false, error: 'timeout' }), 21000);
  });

  check(
    'gateway credential accepted',
    device.ok,
    device.ok ? Date.now() - connectStarted + 'ms to CONNACK' : (device.error ?? ''),
  );
  if (!device.ok || !device.client) {
    report();
    return;
  }
  const client = device.client;

  /* ------------------------------------------------------ 4. publishing -- */
  section('4. Telemetry through the cloud');

  const marker = Math.round(1000 + Math.random() * 8000) / 10;
  const measuredAt = new Date();
  const telemetryTopic = options.topicRoot + '/gateways/' + options.gatewayUid + '/telemetry';

  const payload = {
    gateway_id: options.gatewayUid,
    slave_id: 1,
    timestamp: measuredAt.toISOString(),
    registers: {
      // A distinctive voltage so the value can be found again at the far end.
      voltage_l1: marker,
      voltage_l2: 229.8,
      voltage_l3: 231.2,
      current_l1: 12.4,
      active_power_kw: 8.2,
      power_factor: 0.95,
      frequency_hz: 50.01,
      energy_import_kwh: 20000 + Math.round(Math.random() * 1000),
    },
  };

  const publishStarted = Date.now();
  const published = await new Promise<boolean>((resolve) => {
    client.publish(telemetryTopic, JSON.stringify(payload), { qos: 1 }, (error) => resolve(!error));
    setTimeout(() => resolve(false), 15000);
  });
  check('publish accepted with QoS 1 acknowledgement', published, Date.now() - publishStarted + 'ms to PUBACK');

  const wrongTopic = options.topicRoot + '/gateways/NOT-THIS-GATEWAY/telemetry';
  const refused = await new Promise<boolean>((resolve) => {
    client.publish(wrongTopic, '{}', { qos: 1 }, (error) => resolve(Boolean(error)));
    setTimeout(() => resolve(true), 8000);
  });
  check("publishing as another gateway is refused over the wire", refused, wrongTopic);

  /* --------------------------------------------------------- 5. the API -- */
  section('5. Data readable through the API');

  const api = async (path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(options.api + path, init);
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: response.status, body };
  };

  const health = await api('/api/health');
  check('API reachable over HTTPS', health.status === 200, 'HTTP ' + health.status);

  if (!options.user || !options.pass) {
    check('dashboard credentials supplied', false, 'pass --user and --pass to verify the data end to end');
    client.end(true);
    report();
    return;
  }

  const login = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: options.user, password: options.pass }),
  });
  const token = String(login.body.token ?? '');
  check('dashboard sign-in', login.status === 200 && Boolean(token), 'HTTP ' + login.status);
  if (!token) {
    client.end(true);
    report();
    return;
  }
  const auth = { Authorization: 'Bearer ' + token };

  // Give the pipeline a moment: broker -> consumer -> raw -> normalise -> store.
  let found: { value: number; at: string } | null = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !found) {
    await wait(1500);
    const meters = await api('/api/meters', { headers: auth });
    const list = (meters.body.meters as Array<Record<string, unknown>>) ?? [];
    const meter = list.find((entry) => String(entry.meterUid ?? '').startsWith(options.gatewayUid + ':'));
    if (!meter) continue;

    const live = await api('/api/meters/' + String(meter.id) + '/live', { headers: auth });
    const reading = live.body.reading as { measurements?: Record<string, { value: number; at: string }> } | null;
    const voltage = reading?.measurements?.voltage_l1;
    if (voltage && Math.abs(voltage.value - marker) < 0.05) {
      found = { value: voltage.value, at: voltage.at };
    }
  }

  check(
    'the published reading is readable through the API',
    Boolean(found),
    found
      ? 'voltage_l1 = ' + found.value + ' V at ' + found.at
      : 'the distinctive value never appeared - check the consumer and the payload profile',
  );

  if (found) {
    const drift = Math.abs(Date.parse(found.at) - measuredAt.getTime()) / 1000;
    check(
      'measurement time preserved end to end',
      drift < 5,
      Math.round(drift) + 's between what we sent and what was stored',
    );
  }

  /* ------------------------------------------------------ 6. live stream -- */
  section('6. Live stream to the dashboard');

  const controller = new AbortController();
  const streamPromise = (async (): Promise<string> => {
    try {
      const response = await fetch(options.api + '/api/stream?access_token=' + encodeURIComponent(token), {
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) return '';
      let text = '';
      const until = Date.now() + 25_000;
      while (Date.now() < until) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
        if (text.includes('event: telemetry')) break;
      }
      return text;
    } catch {
      return '';
    }
  })();

  await wait(1500);
  const secondMarker = Math.round(2000 + Math.random() * 300) / 10;

  // The refused publish above is answered with deny_action = disconnect, so
  // this client is very likely already gone. Reconnect before publishing.
  let publisher = client;
  if (!client.connected) {
    const reconnected = await new Promise<mqtt.MqttClient | null>((resolve) => {
      const next = mqtt.connect(url, {
        clientId: options.gatewayUid + '-stream',
        username: options.gatewayUid,
        password: options.mqttPassword,
        clean: true,
        reconnectPeriod: 0,
        connectTimeout: 20000,
        rejectUnauthorized: !options.insecure,
      });
      next.once('connect', () => resolve(next));
      next.once('error', () => resolve(null));
      setTimeout(() => resolve(null), 21000);
    });
    if (!reconnected) {
      check('reconnected for the live-stream test', false, 'could not reconnect after the ACL denial');
      controller.abort();
      report();
      return;
    }
    publisher = reconnected;
  }

  await new Promise<void>((resolve) => {
    publisher.publish(
      telemetryTopic,
      JSON.stringify({
        ...payload,
        timestamp: new Date().toISOString(),
        registers: { ...payload.registers, voltage_l1: secondMarker },
      }),
      { qos: 1 },
      () => resolve(),
    );
    setTimeout(resolve, 10000);
  });

  const stream = await streamPromise;
  controller.abort();
  if (publisher !== client) publisher.end(true);
  check(
    'dashboard receives a live update without polling',
    stream.includes('event: telemetry'),
    stream.includes('event: telemetry') ? 'SSE telemetry event delivered' : 'no telemetry event within 25s',
  );

  client.end(true);
  report();
}

function report(): void {
  const passed = checks.length - failures;
  process.stdout.write('\n' + '='.repeat(64) + '\n');
  process.stdout.write('RESULT: ' + passed + '/' + checks.length + ' acceptance checks passed\n');

  if (failures) {
    process.stdout.write('\nFailed:\n');
    for (const item of checks.filter((entry) => !entry.ok)) {
      process.stdout.write('  - ' + item.name + (item.detail ? ' (' + item.detail + ')' : '') + '\n');
    }
  } else {
    process.stdout.write(
      '\nThe full cloud path works from this machine:\n' +
        '  simulator -> internet -> DNS -> TLS broker -> auth -> ACL -> consumer\n' +
        '  -> raw -> normalisation -> telemetry -> API -> live dashboard stream.\n' +
        '\nRun it again from a mobile hotspot (spec section 26), then swap this\n' +
        'script for the Technode gateway.\n',
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  const outDir = join(here, '..', 'docs', 'test-results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'cloud-acceptance-' + options.network.replace(/[^a-z0-9]+/gi, '-') + '-' + date + '.md'),
    [
      '# Cloud acceptance test',
      '',
      '- Date: ' + new Date().toISOString(),
      '- Network: ' + options.network,
      '- Broker: ' + (options.tls ? 'mqtts' : 'mqtt') + '://' + options.host + ':' + options.port,
      '- API: ' + options.api,
      '- Result: **' + passed + '/' + checks.length + ' passed**',
      '',
      '| Check | Result | Detail |',
      '|---|---|---|',
      ...checks.map((item) => '| ' + item.name + ' | ' + (item.ok ? 'PASS' : 'FAIL') + ' | ' + item.detail + ' |'),
      '',
    ].join('\n'),
  );
  process.stdout.write('='.repeat(64) + '\n\n');
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  process.stderr.write('\nacceptance test crashed: ' + (error instanceof Error ? error.stack : String(error)) + '\n');
  process.exitCode = 1;
});
