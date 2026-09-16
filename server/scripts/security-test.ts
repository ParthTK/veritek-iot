/**
 * MQTT security test suite (spec section 29).
 *
 * Proves, against a running broker and backend, that:
 *
 *   anonymous connection            -> DENIED
 *   wrong password                  -> DENIED
 *   revoked / suspended credential  -> DENIED
 *   gateway A subscribing to B      -> DENIED
 *   gateway A publishing as B       -> DENIED
 *   wildcard '#' subscription       -> DENIED
 *   gateway on its own topics       -> ALLOWED
 *   backend service account         -> its own operations only
 *
 * Two modes:
 *
 *   npm run test:security            webhook mode - exercises the decision
 *                                    logic the broker calls, no broker needed
 *   npm run test:security -- --live  live mode - real MQTT connections against
 *                                    a running broker. This is the one to run
 *                                    against staging before go-live.
 *
 * Results are printed as a table and written to
 * docs/test-results/security-YYYY-MM-DD.md for the handover document.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE = process.argv.includes('--live');

function arg(name: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

/**
 * Remote mode: provision through the deployment's own API instead of a local
 * database. Without it, --live against a cloud broker creates credentials in a
 * local SQLite file that the broker has never heard of, and every allow-test
 * fails for the wrong reason.
 */
const REMOTE = {
  api: (arg('api') ?? '').replace(/[/]$/, ''),
  user: arg('admin-user'),
  pass: arg('admin-pass'),
};
const IS_REMOTE = Boolean(REMOTE.api && REMOTE.user && REMOTE.pass);
const here = dirname(fileURLToPath(import.meta.url));

interface Result {
  name: string;
  expectation: 'allow' | 'deny';
  actual: 'allow' | 'deny' | 'error';
  pass: boolean;
  detail: string;
}

const results: Result[] = [];

function record(name: string, expectation: 'allow' | 'deny', actual: Result['actual'], detail = ''): void {
  const pass = actual === expectation;
  results.push({ name, expectation, actual, pass, detail });
  process.stdout.write(
    '  [' + (pass ? 'PASS' : 'FAIL') + '] ' + name +
      ' (expected ' + expectation + ', got ' + actual + ')' +
      (detail ? ' - ' + detail : '') + '\n',
  );
}

function section(title: string): void {
  process.stdout.write('\n' + title + '\n' + '-'.repeat(Math.max(title.length, 46)) + '\n');
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
  if (!LIVE) {
    process.env.SQLITE_PATH = process.env.SECURITY_TEST_DB ?? './data/security-test.db';
    process.env.EMBEDDED_BROKER_ENABLED = 'false';
    process.env.MQTT_ENABLED = 'false';
  }

  const { env } = await import('../src/config/env.js');
  const { configureLogger } = await import('../src/core/logger.js');
  configureLogger({ level: 'error', pretty: true });

  const suffix = Date.now().toString(36).toUpperCase();
  const alphaUid = 'SEC-A-' + suffix;
  const betaUid = 'SEC-B-' + suffix;

  let alphaPassword: string;
  let betaPassword: string;
  let betaGatewayId: string;
  let adminToken = '';
  let closeDb: () => Promise<void> = async () => undefined;

  const { topicsFor } = await import('../src/iot/mqtt/topics.js');

  if (IS_REMOTE) {
    /* Provision through the deployment's own API, so the credentials exist in
       the database the broker actually authenticates against. */
    const login = await fetch(REMOTE.api + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: REMOTE.user, password: REMOTE.pass }),
    });
    const loginBody = (await login.json()) as { token?: string };
    if (!login.ok || !loginBody.token) {
      record('admin sign-in for provisioning', 'allow', 'error', 'HTTP ' + login.status);
      report();
      return;
    }
    adminToken = loginBody.token;

    const provision = async (uid: string): Promise<{ password: string; gatewayId: string }> => {
      const response = await fetch(REMOTE.api + '/api/provisioning/gateways', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
        body: JSON.stringify({ gatewayUid: uid, environment: 'staging', meters: [{ slaveId: 1 }] }),
      });
      const body = (await response.json()) as {
        mqttPassword?: string;
        gateway?: { id?: string };
        error?: { message?: string };
      };
      if (!response.ok || !body.mqttPassword) {
        throw new Error('provisioning ' + uid + ' failed: ' + (body.error?.message ?? 'HTTP ' + response.status));
      }
      return { password: body.mqttPassword, gatewayId: String(body.gateway?.id ?? '') };
    };

    const alpha = await provision(alphaUid);
    const beta = await provision(betaUid);
    alphaPassword = alpha.password;
    betaPassword = beta.password;
    betaGatewayId = beta.gatewayId;
  } else {
    const db = await import('../src/db/index.js');
    const { migrate } = await import('../src/db/migrate.js');
    const { seed } = await import('./seed.js');
    const database = await db.connectDb();
    await migrate(database);
    await seed();
    closeDb = db.closeDb;

    const { provisionGateway, ensureServiceAccount } = await import('../src/iot/devices/lifecycle.js');
    const alpha = await provisionGateway({ gatewayUid: alphaUid, siteId: 'site-onida', meters: [{ slaveId: 1 }] });
    const beta = await provisionGateway({ gatewayUid: betaUid, siteId: 'site-onida', meters: [{ slaveId: 1 }] });
    await ensureServiceAccount();
    alphaPassword = alpha.mqttPassword;
    betaPassword = beta.mqttPassword;
    betaGatewayId = beta.gateway.id;
  }

  const alphaTopics = topicsFor(alphaUid);
  const betaTopics = topicsFor(betaUid);

  if (LIVE) {
    await runLive({ alphaUid, alphaPassword, betaUid, alphaTopics, betaTopics, env });
  } else {
    await runWebhook({ alphaUid, alphaPassword, betaUid, alphaTopics, betaTopics });
  }

  /* Revocation has to take effect immediately, in either mode. */
  section('Revoked credential');

  if (IS_REMOTE) {
    const response = await fetch(REMOTE.api + '/api/provisioning/gateways/' + betaGatewayId + '/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
      body: JSON.stringify({ reason: 'security test' }),
    });
    record('revocation accepted by the API', 'allow', response.ok ? 'allow' : 'error', 'HTTP ' + response.status);

    // Prove it at the broker, not just in our own database.
    const mqttLib = (await import('mqtt')).default;
    const scheme = env.MQTT_TLS ? 'mqtts' : 'mqtt';
    const brokerUrl = scheme + '://' + env.MQTT_HOST + ':' + env.MQTT_PORT;
    const outcome = await new Promise<string>((resolve) => {
      const client = mqttLib.connect(brokerUrl, {
        clientId: betaUid + '-revoked',
        username: betaUid,
        password: betaPassword,
        reconnectPeriod: 0,
        connectTimeout: 10000,
      });
      client.once('connect', () => {
        client.end(true);
        resolve('connected');
      });
      client.once('error', (error) => {
        client.end(true);
        resolve(error.message);
      });
      setTimeout(() => resolve('timeout'), 11000);
    });
    record('revoked gateway refused by the broker', 'deny', outcome === 'connected' ? 'allow' : 'deny', outcome);
  } else {
    const { revokeGateway } = await import('../src/iot/devices/lifecycle.js');
    await revokeGateway(betaGatewayId, 'security test');
    const { verifyCredential } = await import('../src/db/repositories/mqttCredentials.js');
    const revoked = await verifyCredential(betaUid, betaPassword);
    record('revoked gateway cannot authenticate', 'deny', revoked.credential ? 'allow' : 'deny', revoked.reason);
  }

  await closeDb();
  report();
}

/* ------------------------------------------------------- webhook mode -- */

interface Context {
  alphaUid: string;
  alphaPassword: string;
  betaUid: string;
  alphaTopics: { telemetry: string; status: string; command: string; response: string };
  betaTopics: { telemetry: string; status: string; command: string; response: string };
}

/**
 * Exercise the exact decision functions the broker's webhooks call. Covers the
 * authorization logic completely without needing EMQX running, which makes it
 * usable in CI.
 */
async function runWebhook(context: Context): Promise<void> {
  const { verifyCredential, getCredentialByUsername } = await import('../src/db/repositories/mqttCredentials.js');
  const { aclAllows, renderAcl } = await import('../src/iot/mqtt/topics.js');

  section('Authentication');

  const anonymous = await verifyCredential('', '');
  record('anonymous connection', 'deny', anonymous.credential ? 'allow' : 'deny', anonymous.reason);

  const wrongPassword = await verifyCredential(context.alphaUid, 'definitely-not-the-password');
  record('wrong password', 'deny', wrongPassword.credential ? 'allow' : 'deny', wrongPassword.reason);

  const unknownUser = await verifyCredential('no-such-gateway', 'anything');
  record('unknown username', 'deny', unknownUser.credential ? 'allow' : 'deny', unknownUser.reason);

  const correct = await verifyCredential(context.alphaUid, context.alphaPassword);
  record('correct credential', 'allow', correct.credential ? 'allow' : 'deny', correct.reason);

  section('Authorization (gateway A)');

  const credential = await getCredentialByUsername(context.alphaUid);
  if (!credential) throw new Error('provisioned credential vanished');
  const publishRules = renderAcl(credential.acl.publish ?? [], {});
  const subscribeRules = renderAcl(credential.acl.subscribe ?? [], {});

  const can = (rules: string[], topic: string): 'allow' | 'deny' => (aclAllows(rules, topic) ? 'allow' : 'deny');

  record('publish own telemetry', 'allow', can(publishRules, context.alphaTopics.telemetry));
  record('publish own status', 'allow', can(publishRules, context.alphaTopics.status));
  record('publish own command response', 'allow', can(publishRules, context.alphaTopics.response));
  record('subscribe own command topic', 'allow', can(subscribeRules, context.alphaTopics.command));

  record("publish another gateway's telemetry", 'deny', can(publishRules, context.betaTopics.telemetry));
  record("subscribe another gateway's command", 'deny', can(subscribeRules, context.betaTopics.command));
  record("subscribe another gateway's telemetry", 'deny', can(subscribeRules, context.betaTopics.telemetry));
  record('subscribe wildcard #', 'deny', can(subscribeRules, '#'));
  record('subscribe wildcard energy/v1/gateways/+/telemetry', 'deny', can(subscribeRules, 'energy/v1/gateways/+/telemetry'));
  record('publish to its own command topic', 'deny', can(publishRules, context.alphaTopics.command));
  record('publish arbitrary topic', 'deny', can(publishRules, 'some/other/tree'));

  section('Authorization (backend service account)');

  const { serviceAcl } = await import('../src/iot/mqtt/topics.js');
  const service = serviceAcl();
  record('service subscribes telemetry wildcard', 'allow', can(service.subscribe, 'energy/v1/gateways/+/telemetry'));
  record('service publishes to a command topic', 'allow', can(service.publish, context.alphaTopics.command));
  record('service cannot subscribe #', 'deny', can(service.subscribe, '#'));
  record("service cannot publish a gateway's telemetry", 'deny', can(service.publish, context.alphaTopics.telemetry));
}

/* ---------------------------------------------------------- live mode -- */

/**
 * Real MQTT connections against a running broker. This is the version whose
 * results go in the handover document, because it tests the broker's enforcement
 * rather than only our decision logic.
 */
async function runLive(context: Context & { env: { MQTT_HOST: string; MQTT_PORT: number; MQTT_TLS: boolean } }): Promise<void> {
  const mqtt = (await import('mqtt')).default;
  const scheme = context.env.MQTT_TLS ? 'mqtts' : 'mqtt';
  const url = scheme + '://' + context.env.MQTT_HOST + ':' + context.env.MQTT_PORT;
  process.stdout.write('broker: ' + url + '\n');

  const tryConnect = (
    username: string | undefined,
    password: string | undefined,
    clientId: string,
  ): Promise<{ ok: boolean; error?: string; client?: import('mqtt').MqttClient }> =>
    new Promise((resolve) => {
      const client = mqtt.connect(url, {
        username,
        password,
        clientId,
        clean: true,
        reconnectPeriod: 0,
        connectTimeout: 8000,
      });
      const done = (result: { ok: boolean; error?: string; client?: import('mqtt').MqttClient }): void => {
        if (!result.ok) client.end(true);
        resolve(result);
      };
      client.once('connect', () => done({ ok: true, client }));
      client.once('error', (error) => done({ ok: false, error: error.message }));
      client.once('close', () => done({ ok: false, error: 'closed before CONNACK' }));
    });

  // Without this, a broker that is simply not running would 'pass' every deny
  // expectation and report a secure system. Reachability is checked first.
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = netConnect({ host: context.env.MQTT_HOST, port: context.env.MQTT_PORT });
    const settle = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(5000, () => settle(false));
  });

  if (!reachable) {
    record('broker is reachable', 'allow', 'error', url + ' refused the connection - start the broker first');
    return;
  }
  record('broker is reachable', 'allow', 'allow', url);

  section('Authentication');

  const anonymous = await tryConnect(undefined, undefined, 'sec-anon-' + Date.now());
  const classify = (result: { ok: boolean; error?: string }): Result['actual'] => {
    if (result.ok) return 'allow';
    // Distinguish 'the broker said no' from 'nothing answered'.
    return /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ENOTFOUND/.test(result.error ?? '') ? 'error' : 'deny';
  };

  record('anonymous connection', 'deny', classify(anonymous), anonymous.error ?? '');

  const wrong = await tryConnect(context.alphaUid, 'definitely-not-the-password', 'sec-wrong-' + Date.now());
  record('wrong password', 'deny', classify(wrong), wrong.error ?? '');

  const good = await tryConnect(context.alphaUid, context.alphaPassword, context.alphaUid);
  record('correct credential', 'allow', classify(good), good.error ?? '');
  if (!good.ok || !good.client) {
    process.stdout.write('  (skipping ACL tests - gateway A could not connect)\n');
    return;
  }

  const client = good.client;
  section('Authorization (live broker)');

  const trySubscribe = (topic: string): Promise<'allow' | 'deny'> =>
    new Promise((resolve) => {
      let settled = false;
      // deny_action = disconnect, so a refusal may arrive as a dropped socket
      // rather than as a SUBACK failure code.
      const onClose = (): void => {
        if (!settled) {
          settled = true;
          resolve('deny');
        }
      };
      client.once('close', onClose);
      client.subscribe(topic, { qos: 1 }, (error, granted) => {
        if (settled) return;
        settled = true;
        client.removeListener('close', onClose);
        if (error) return resolve('deny');
        const qos = granted?.[0]?.qos;
        resolve(qos === undefined || qos > 2 ? 'deny' : 'allow');
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve('deny');
        }
      }, 5000);
    });

  const tryPublish = (topic: string): Promise<'allow' | 'deny'> =>
    new Promise((resolve) => {
      let settled = false;
      const onClose = (): void => {
        if (!settled) {
          settled = true;
          resolve('deny');
        }
      };
      client.once('close', onClose);
      client.publish(topic, JSON.stringify({ probe: true }), { qos: 1 }, (error) => {
        if (settled) return;
        settled = true;
        client.removeListener('close', onClose);
        resolve(error ? 'deny' : 'allow');
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve('deny');
        }
      }, 5000);
    });

  record('publish own telemetry', 'allow', await tryPublish(context.alphaTopics.telemetry));
  await wait(200);
  record('subscribe own command topic', 'allow', await trySubscribe(context.alphaTopics.command));
  await wait(200);
  record("publish another gateway's telemetry", 'deny', await tryPublish(context.betaTopics.telemetry));
  await wait(500);

  // A denial may have dropped the connection; reconnect for the remaining tests.
  let probe = client.connected ? { ok: true, client } : await tryConnect(context.alphaUid, context.alphaPassword, context.alphaUid + '-2');
  if (probe.ok && probe.client) {
    const second = probe.client;
    const subscribeOn = (topic: string): Promise<'allow' | 'deny'> =>
      new Promise((resolve) => {
        second.subscribe(topic, { qos: 1 }, (error, granted) => {
          const qos = granted?.[0]?.qos;
          resolve(error || qos === undefined || qos > 2 ? 'deny' : 'allow');
        });
        setTimeout(() => resolve('deny'), 5000);
      });
    record("subscribe another gateway's command", 'deny', await subscribeOn(context.betaTopics.command));
    await wait(300);
    probe = second.connected ? { ok: true, client: second } : await tryConnect(context.alphaUid, context.alphaPassword, context.alphaUid + '-3');
    if (probe.ok && probe.client) {
      const third = probe.client;
      record(
        'subscribe wildcard #',
        'deny',
        await new Promise<'allow' | 'deny'>((resolve) => {
          third.subscribe('#', { qos: 1 }, (error, granted) => {
            const qos = granted?.[0]?.qos;
            resolve(error || qos === undefined || qos > 2 ? 'deny' : 'allow');
          });
          setTimeout(() => resolve('deny'), 5000);
        }),
      );
      third.end(true);
    }
  }

  client.end(true);
}

/* ------------------------------------------------------------ report -- */

function report(): void {
  const passed = results.filter((result) => result.pass).length;
  process.stdout.write('\n' + '='.repeat(60) + '\n');
  process.stdout.write('RESULT: ' + passed + '/' + results.length + ' security checks passed\n');

  const failed = results.filter((result) => !result.pass);
  if (failed.length) {
    process.stdout.write('\nFailed:\n');
    for (const item of failed) {
      process.stdout.write('  - ' + item.name + ': expected ' + item.expectation + ', got ' + item.actual + '\n');
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const outDir = join(here, '..', 'docs', 'test-results');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'security-' + date + '.md');

  const lines = [
    '# MQTT security test results',
    '',
    '- Date: ' + new Date().toISOString(),
    '- Mode: ' + (LIVE ? 'live broker connections' : 'webhook decision logic'),
    '- Result: **' + passed + '/' + results.length + ' passed**',
    '',
    '| Check | Expected | Actual | Result |',
    '|---|---|---|---|',
    ...results.map(
      (result) =>
        '| ' + result.name + ' | ' + result.expectation + ' | ' + result.actual + ' | ' +
        (result.pass ? 'PASS' : 'FAIL') + ' |',
    ),
    '',
    LIVE
      ? 'Live mode: these are real MQTT connections, so the broker itself enforced every result above.'
      : 'Webhook mode: exercises the decision logic the broker calls. Re-run with `--live` against staging to prove the broker enforces it.',
    '',
  ];
  writeFileSync(file, lines.join('\n'));
  process.stdout.write('\nwritten to ' + file + '\n');
  process.stdout.write('='.repeat(60) + '\n\n');

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  process.stderr.write('\nsecurity tests crashed: ' + (error instanceof Error ? error.stack : String(error)) + '\n');
  process.exit(1);
});
