import { env } from '../src/config/env.js';
import { configureLogger, createLogger } from '../src/core/logger.js';
import { connectDb, closeDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { upsertAlertRule } from '../src/db/repositories/alerts.js';
import { upsertGateway, rotateGatewayToken } from '../src/db/repositories/gateways.js';
import { upsertMeter, upsertMeterModel } from '../src/db/repositories/meters.js';
import { upsertMetricDefinition } from '../src/db/repositories/metrics.js';
import { upsertProfile } from '../src/db/repositories/profiles.js';
import { upsertSite } from '../src/db/repositories/sites.js';
import { countUsers, upsertUser } from '../src/db/repositories/users.js';
import { METRIC_CATALOG } from '../src/config/metricCatalog.js';

const log = createLogger('seed');

/**
 * Baseline data.
 *
 * Deliberately NOT seeded:
 *   - Modbus register addresses, datatypes, byte order or scaling. Those come
 *     from the meter's own manual (spec section 5). A plausible-looking guess
 *     here would be worse than an empty table, because someone would trust it.
 *   - A `veritek_schema_v1` payload profile. That needs a real captured
 *     packet; a placeholder row is created, disabled and marked unverified, so
 *     the slot is obvious tomorrow.
 */
export async function seed(): Promise<void> {
  const database = await connectDb();
  await migrate(database);

  /* ------------------------------------------------ metric definitions -- */
  for (const metric of METRIC_CATALOG) await upsertMetricDefinition(metric);
  log.info('metric catalogue loaded', { metrics: METRIC_CATALOG.length });

  /* ----------------------------------------------------------- admin -- */
  if ((await countUsers()) === 0) {
    await upsertUser({
      name: 'Admin User',
      email: env.SEED_ADMIN_EMAIL,
      role: 'Super Admin',
      password: env.SEED_ADMIN_PASSWORD,
      active: true,
      assignedSites: [],
    });
    log.info('administrator account created', { email: env.SEED_ADMIN_EMAIL });
    if (env.SEED_ADMIN_PASSWORD === 'Pass@123') {
      log.warn('the seeded administrator password is the documented default - change it before production.');
    }
  }

  /* ------------------------------------------------------------ site -- */
  const site = await upsertSite({
    id: 'site-abc',
    name: 'ABC Manufacturing',
    code: 'ABC',
    city: 'Mumbai',
    state: 'Maharashtra',
    address: '1 Example Industrial Estate, Unit A, Mumbai 400001',
    timezone: env.DEFAULT_SITE_TIMEZONE,
    tariffPerKwh: 8.5,
    currency: 'INR',
  });

  /* ---------------------------------------------------- meter model -- */
  // An empty shell on purpose: the register table is one of the four things we
  // are still waiting on. `verified: false` keeps that visible in the UI.
  const model = await upsertMeterModel({
    manufacturer: 'UNSPECIFIED',
    model: 'PENDING-REGISTER-TABLE',
    protocol: 'MODBUS_RTU',
    defaultBaudRate: null,
    defaultParity: null,
    defaultStopBits: null,
    defaultDataBits: null,
    defaultSlaveId: null,
    defaultPollIntervalSeconds: null,
    verified: false,
    notes:
      'Placeholder. Fill in from the energy meter manual: baud rate, parity, stop bits, and one ' +
      'register-map row per metric (address, datatype, byte/word order, scale, unit). Until then ' +
      'this model decodes nothing and values arrive only if the gateway pre-decodes them. ' +
      'See docs/register-map.template.json.',
  });

  /* --------------------------------------------------- test gateway -- */
  const gateway = await upsertGateway({
    gatewayUid: env.SIMULATOR_GATEWAY_UID,
    name: 'Simulated Gateway (' + env.SIMULATOR_GATEWAY_UID + ')',
    siteId: site.id,
    hardwareModel: 'SIMULATOR',
    connectionType: 'MQTT',
    topicNamespace: 'veritek/' + env.SIMULATOR_GATEWAY_UID,
    sourceUtcOffset: env.DEFAULT_SOURCE_UTC_OFFSET,
    enabled: true,
    notes:
      'Test gateway for the simulator. Delete or disable it once the physical gateway is ' +
      'commissioned; it exists so the whole path can be verified before hardware arrives.',
  });

  const slaveIds = env.SIMULATOR_SLAVE_IDS.map(Number).filter(Number.isFinite);
  for (const slaveId of slaveIds.length ? slaveIds : [1]) {
    await upsertMeter({
      meterUid: env.SIMULATOR_GATEWAY_UID + ':' + slaveId,
      meterName: 'Simulated Meter ' + slaveId,
      siteId: site.id,
      gatewayId: gateway.id,
      meterModelId: model.id,
      slaveId,
      // Left null on purpose: the real serial settings come from the meter, and
      // an invented 9600/none/1 here would be a guess dressed up as a fact.
      baudRate: null,
      parity: null,
      stopBits: null,
      enabled: true,
      installedAt: new Date().toISOString(),
      notes: 'Created for the simulator. Set the real serial parameters at commissioning.',
    });
  }

  /* ------------------------------------------------- payload profiles -- */

  // The simulator's own format. Real, verified - for the simulator.
  await upsertProfile({
    name: 'simulator_v1',
    vendor: 'veritek',
    version: 1,
    enabled: true,
    priority: 50,
    verified: true,
    matchRules: {
      requiredPaths: ['gateway_id', 'registers'],
    },
    spec: {
      gatewayIdPaths: ['gateway_id'],
      slaveIdPaths: ['slave_id'],
      timestampPaths: ['timestamp'],
      timestampFormat: 'auto',
      assumeUtcOffset: env.DEFAULT_SOURCE_UTC_OFFSET,
      sequencePaths: ['seq'],
      bufferedFlagPaths: ['buffered'],
      measurementPaths: ['registers'],
      // The simulator already emits platform metric keys, so no translation is
      // needed. A real gateway's profile is where keyMap earns its keep.
      keyMap: {},
      passthroughUnmapped: true,
    },
    notes:
      'Decodes the LOCAL SIMULATOR payload. This is NOT gateway format - it is a test ' +
      'harness shape invented for this repository. Disable it once the real gateway is mapped.',
  });

  // The slot tomorrow's real mapping goes into. Disabled and unverified.
  await upsertProfile({
    name: 'veritek_schema_v1',
    vendor: 'veritek',
    version: 1,
    enabled: false,
    priority: 10,
    verified: false,
    matchRules: {},
    spec: {
      gatewayIdPaths: [],
      slaveIdPaths: [],
      timestampPaths: [],
      timestampFormat: 'auto',
      assumeUtcOffset: env.DEFAULT_SOURCE_UTC_OFFSET,
      measurementPaths: [],
      keyMap: {},
      passthroughUnmapped: false,
    },
    notes:
      'EMPTY PLACEHOLDER. The manufacturer does not publish the production JSON schema, so this ' +
      'cannot be filled in until a real packet is captured. Workflow: let the gateway publish, ' +
      'open /commissioning, call GET /api/commissioning/suggest-profile?gatewayUid=..., check the ' +
      'draft with POST /api/commissioning/test-parse, save it here, then enable and verify it.',
  });

  /* ------------------------------------------------------ alert rules -- */
  // Thresholds for a 230 V / 50 Hz Indian LT supply. Every one is editable per
  // site or per meter; these are starting points, not policy.
  const rules = [
    { name: 'Over-voltage L1', metric: 'voltage_l1', condition: 'gt' as const, threshold: 253, severity: 'warning' as const },
    { name: 'Under-voltage L1', metric: 'voltage_l1', condition: 'lt' as const, threshold: 207, severity: 'warning' as const },
    { name: 'Low power factor', metric: 'power_factor', condition: 'lt' as const, threshold: 0.85, severity: 'warning' as const },
    { name: 'Frequency out of band', metric: 'frequency_hz', condition: 'outside' as const, threshold: 49.0, thresholdHigh: 51.0, severity: 'critical' as const },
  ];

  for (const rule of rules) {
    await upsertAlertRule({
      id: 'rule-' + rule.metric + '-' + rule.condition,
      name: rule.name,
      scope: 'global',
      metric: rule.metric,
      condition: rule.condition,
      threshold: rule.threshold,
      thresholdHigh: 'thresholdHigh' in rule ? rule.thresholdHigh : null,
      severity: rule.severity,
      enabled: true,
      messageTemplate: '{meter}: {metric} is {value} {unit}',
    });
  }

  await upsertAlertRule({
    id: 'rule-gateway-offline',
    name: 'Gateway stopped reporting',
    scope: 'global',
    condition: 'device_offline',
    durationSeconds: env.GATEWAY_OFFLINE_AFTER_SECONDS,
    severity: 'critical',
    enabled: true,
    messageTemplate: '{meter} has stopped reporting',
  });

  await upsertAlertRule({
    id: 'rule-meter-no-data',
    name: 'Meter stopped reporting',
    scope: 'global',
    condition: 'no_data',
    durationSeconds: env.METER_STALE_AFTER_SECONDS,
    severity: 'warning',
    enabled: true,
  });

  log.info('seed complete', {
    site: site.id,
    gateway: gateway.gatewayUid,
    meters: slaveIds.length || 1,
    alertRules: rules.length + 2,
  });
}

const isEntryPoint = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/seed.ts');
if (isEntryPoint) {
  configureLogger({ level: env.LOG_LEVEL as never, pretty: env.LOG_PRETTY });
  seed()
    .then(async () => {
      // A device credential is only useful if it is shown once, at creation.
      if (process.argv.includes('--with-token')) {
        const { getGatewayByUid } = await import('../src/db/repositories/gateways.js');
        const gateway = await getGatewayByUid(env.SIMULATOR_GATEWAY_UID);
        if (gateway) {
          const token = await rotateGatewayToken(gateway.id);
          log.warn('device token for ' + gateway.gatewayUid + ' (shown once): ' + token);
        }
      }
      await closeDb();
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      log.error('seed failed', { error });
      await closeDb();
      process.exit(1);
    });
}
