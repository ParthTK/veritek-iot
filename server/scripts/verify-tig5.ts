/**
 * End-to-end check for a Technode TIG-5, simulated from its manual.
 *
 * Proves the platform reads that device without a code change: it provisions
 * one against the TIG-5 preset, publishes the payload the manual documents on
 * the topics that firmware actually uses, and reads the values back out of the
 * API under our own metric names.
 *
 *   npm run verify:tig5 -- --host mqtt.example.com --api https://api.example.com \
 *     --user admin@example.com --pass '<password>'
 *
 * Without --host it runs against the local development stack.
 */
import mqtt from 'mqtt';

function flag(name: string, fallback = ''): string {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? String(process.argv[index + 1]) : fallback;
}

const API = flag('api', 'http://127.0.0.1:4000').replace(/\/$/, '');
const HOST = flag('host');
const PORT = Number(flag('port', HOST ? '8883' : '1883'));
const USER = flag('user', 'admin@veritek.com');
const PASS = flag('pass', 'Pass@123');

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1;
  else failed += 1;
  process.stdout.write('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (detail ? ' - ' + detail : '') + '\n');
}
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const login = await fetch(API + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: USER, password: PASS }),
  });
  const token = ((await login.json()) as { token?: string }).token;
  if (!token) throw new Error('could not sign in to ' + API);
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

  // An IMEI-shaped id, because that is what this hardware reports as its "ID".
  const imei = '86236' + String(Date.now()).slice(-10);

  const response = await fetch(API + '/api/provisioning/gateways', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      gatewayUid: imei,
      name: 'TIG-5 verification',
      siteId: 'site-abc',
      deviceType: 'technode-tig5',
      meters: [{ slaveId: 1 }],
    }),
  });
  const provisioned = (await response.json()) as {
    connection: Record<string, string | undefined>;
    mqttPassword: string;
    commissioningNotes: string[];
    gateway: { id: string };
  };
  check('provisioned against the TIG-5 preset', response.status === 201, 'HTTP ' + response.status);
  check(
    'data topic is on our namespace',
    provisioned.connection.telemetryTopic === 'energy/v1/gateways/' + imei + '/telemetry',
    provisioned.connection.telemetryTopic,
  );
  check(
    "the firmware's fixed topics are the ones it is granted",
    provisioned.connection.statusTopic === imei + '/connection' &&
      provisioned.connection.commandTopic === imei + '/cmd',
    provisioned.connection.statusTopic + ' , ' + provisioned.connection.commandTopic,
  );
  check('installer gets the model-specific steps', provisioned.commissioningNotes.length > 0,
    provisioned.commissioningNotes.length + ' notes');

  const url = (HOST ? 'mqtts://' + HOST : 'mqtt://127.0.0.1') + ':' + PORT;
  const client = mqtt.connect(url, {
    clientId: imei,
    username: imei,
    password: provisioned.mqttPassword,
    // The TIG-5 speaks MQTT 3.1, which is older than most clients default to.
    protocolVersion: 3,
    protocolId: 'MQIsdp',
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 15000,
  });
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 16000);
  });
  check('device connects speaking MQTT 3.1', true, url);

  // Exactly the shape in the manual, including "Status" capitalised, the
  // epoch-seconds timestamp as a string, and no slave id anywhere.
  const publish = (topic: string, body: unknown): Promise<void> =>
    new Promise((resolve) => client.publish(topic, JSON.stringify(body), { qos: 1 }, () => resolve()));

  await publish(String(provisioned.connection.statusTopic), {
    ID: imei, MODEL: 'TIG5', Status: 'Online', Signal: 74, Location: 'INDIA',
    TS: String(Math.floor(Date.now() / 1000)), DT: '2026-09-24 18:22:50',
  });
  await publish(String(provisioned.connection.telemetryTopic), {
    ID: imei,
    Status: 'Online',
    Signal: 83,
    Location: 'PUMP STATION',
    data: { VRN: 238.7, VYN: 239.1, IR: 14.2, KW: 9.87, PF: 0.962, FREQ: 50.02, KWH: 15432.5 },
    TS: String(Math.floor(Date.now() / 1000)),
    DT: '2026-09-24 18:23:10',
  });
  await wait(2500);
  client.end(true);

  const meters = (await (await fetch(API + '/api/meters', { headers })).json()) as {
    meters: Array<{ id: string; meterUid: string }>;
  };
  const meter = meters.meters.find((entry) => entry.meterUid.startsWith(imei));
  check('a meter was created for the device', Boolean(meter), meter?.meterUid ?? 'none');
  if (!meter) return;

  const live = (await (await fetch(API + '/api/meters/' + meter.id + '/live', { headers })).json()) as {
    reading: { measurements?: Record<string, { value: number }> } | null;
  };
  const m = live.reading?.measurements ?? {};
  check("its variable names became our metrics", m.voltage_l1?.value === 238.7,
    'voltage_l1 = ' + (m.voltage_l1?.value ?? 'missing'));
  check('energy counter stored', m.energy_import_kwh?.value === 15432.5,
    'energy_import_kwh = ' + (m.energy_import_kwh?.value ?? 'missing'));
  check('power factor stored', m.power_factor?.value === 0.962,
    'power_factor = ' + (m.power_factor?.value ?? 'missing'));

  const gateways = (await (await fetch(API + '/api/gateways', { headers })).json()) as {
    gateways: Array<{ gatewayUid: string; liveStatus: string; status: string }>;
  };
  const gateway = gateways.gateways.find((entry) => entry.gatewayUid === imei);
  check("its own connection topic marked the device online", gateway?.status === 'ONLINE',
    'status ' + (gateway?.status ?? 'unknown'));

  process.stdout.write('\nRESULT: ' + passed + '/' + (passed + failed) + ' checks passed\n');
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stdout.write('verify-tig5 failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
