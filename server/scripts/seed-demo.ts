/**
 * Load a demonstration dataset: sites, gateways, meters and enough historical
 * telemetry for the dashboard to show real numbers and real charts.
 *
 * This is NOT part of `npm run seed`. That script loads only what a production
 * deployment legitimately needs (the metric catalogue, one administrator, the
 * empty meter-model shell). This one invents readings, so it is deliberately a
 * separate, explicitly-invoked command - nobody should be able to fill a
 * customer's database with fiction by accident.
 *
 * Every company, site and serial number here is a placeholder (ABC, XYZ, DEF,
 * GHI, JKL). None of it refers to a real organisation.
 *
 * The readings are synthetic but internally consistent: the cumulative energy
 * counters are the integral of the active power curve, so consumption computed
 * as end - start (spec section 13) agrees with the power chart instead of
 * contradicting it.
 *
 *   npm run seed:demo -- --days 30 --interval 15 --purge-test
 *   npm run seed:demo -- --live            # then keep appending, forever
 *
 * `--live` matters because a gateway's badge is computed from how long it has
 * been silent. Seeded history alone goes DEGRADED after five minutes and
 * OFFLINE after fifteen, so without something still writing, a demo dashboard
 * is all red within the quarter hour.
 */
import { env } from '../src/config/env.js';
import { configureLogger, createLogger } from '../src/core/logger.js';
import { closeDb, connectDb, db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import {
  deleteGateway, listGateways, setGatewayStatus, touchGatewayData, touchGatewaySeen, upsertGateway,
} from '../src/db/repositories/gateways.js';
import { deleteMeter, listMeters, setMeterStatus, touchMeterData, upsertMeter } from '../src/db/repositories/meters.js';
import { upsertMetricDefinition } from '../src/db/repositories/metrics.js';
import { markDirty } from '../src/db/repositories/rollups.js';
import { upsertSite } from '../src/db/repositories/sites.js';
import { insertTelemetry, latestByMeter, type TelemetryInsert } from '../src/db/repositories/telemetry.js';
import { AGGREGATION_BUCKETS, flushAggregation } from '../src/iot/telemetry/aggregation.js';
import { METRIC_CATALOG } from '../src/config/metricCatalog.js';
import { bucketStart } from '../src/core/time.js';

const log = createLogger('seed-demo');

/* ------------------------------------------------------------------ data -- */

interface DemoSite {
  id: string;
  name: string;
  code: string;
  city: string;
  state: string;
  address: string;
}

const SITES: DemoSite[] = [
  { id: 'site-abc', name: 'ABC Manufacturing', code: 'ABC', city: 'Mumbai', state: 'Maharashtra', address: '1 Example Industrial Estate, Unit A, Mumbai 400001' },
  { id: 'site-xyz', name: 'XYZ Industrial Park', code: 'XYZ', city: 'Navi Mumbai', state: 'Maharashtra', address: '44 Example Industrial Area, Navi Mumbai 400700' },
  { id: 'site-def', name: 'DEF Plant II', code: 'DEF', city: 'Pune', state: 'Maharashtra', address: '221 Example Industrial Phase II, Pune 410500' },
  { id: 'site-ghi', name: 'GHI Assembly Unit', code: 'GHI', city: 'Chennai', state: 'Tamil Nadu', address: 'Example Industrial Park, Chennai 602100' },
  { id: 'site-jkl', name: 'JKL Office Park', code: 'JKL', city: 'Noida', state: 'Uttar Pradesh', address: '56 Example Business Park, Noida 201300' },
];

interface DemoMeter {
  /** Modbus slave address behind its gateway. */
  slaveId: number;
  name: string;
  /** Typical running load in kW - the scale everything else is derived from. */
  baseKw: number;
  /** Where the cumulative import counter starts, so totals look established. */
  startKwh: number;
  powerFactor: number;
}

interface DemoGateway {
  uid: string;
  name: string;
  siteId: string;
  location: string;
  serial: string;
  hardwareModel: string;
  connectionType: string;
  pollMinutes: number;
  installedAt: string;
  status: 'ONLINE' | 'OFFLINE' | 'DEGRADED';
  /**
   * Minutes since the last packet. `liveStatus` is recomputed from this on
   * every request, so it - not the stored status - is what decides the badge:
   * under 5 minutes reads ONLINE, 5-15 DEGRADED, beyond 15 OFFLINE.
   */
  staleMinutes: number;
  meters: DemoMeter[];
}

const GATEWAYS: DemoGateway[] = [
  {
    uid: 'GW-ABC-0001', name: 'ABC Main Incomer', siteId: 'site-abc',
    location: 'Plant 1 - HT Panel / Incomer', serial: 'VTK-EMS-4410-0091',
    hardwareModel: 'VERITEK EMS-4410', connectionType: '4G LTE', pollMinutes: 1,
    installedAt: '2024-08-14', status: 'ONLINE', staleMinutes: 0,
    meters: [
      { slaveId: 1, name: 'EM-2000', baseKw: 182, startKwh: 4265.71, powerFactor: 0.94 },
      { slaveId: 2, name: 'EM-1000', baseKw: 124, startKwh: 2891.44, powerFactor: 0.91 },
    ],
  },
  {
    uid: 'GW-ABC-0002', name: 'ABC Utility Block', siteId: 'site-abc',
    location: 'Plant 1 - Compressor Room', serial: 'VTK-EMS-4410-0092',
    hardwareModel: 'VERITEK EMS-4410', connectionType: '4G LTE', pollMinutes: 5,
    installedAt: '2024-09-02', status: 'ONLINE', staleMinutes: 0,
    meters: [{ slaveId: 1, name: 'EM-3000', baseKw: 58, startKwh: 1176.9, powerFactor: 0.89 }],
  },
  {
    uid: 'GW-DEF-0001', name: 'DEF Feeder A', siteId: 'site-def',
    location: 'DEF Plant II - Feeder A', serial: 'VTK-TVM-3320-0145',
    hardwareModel: 'VERITEK TVM-3320', connectionType: 'Ethernet', pollMinutes: 1,
    installedAt: '2024-03-21', status: 'DEGRADED', staleMinutes: 9,
    meters: [{ slaveId: 1, name: 'EM-4000', baseKw: 341, startKwh: 8842.06, powerFactor: 0.96 }],
  },
  {
    uid: 'GW-GHI-0001', name: 'GHI Line 3', siteId: 'site-ghi',
    location: 'GHI - Assembly Line 3', serial: 'VTK-CTO-2210-0338',
    hardwareModel: 'VERITEK CTO-2210', connectionType: 'RS-485', pollMinutes: 5,
    installedAt: '2025-01-09', status: 'ONLINE', staleMinutes: 0,
    meters: [{ slaveId: 1, name: 'EM-5000', baseKw: 216, startKwh: 5307.28, powerFactor: 0.88 }],
  },
  {
    uid: 'GW-XYZ-0001', name: 'XYZ Cold Storage', siteId: 'site-xyz',
    location: 'XYZ - Cold Storage Bay 2', serial: 'VTK-EMS-4410-0177',
    hardwareModel: 'VERITEK EMS-4410', connectionType: '2G GPRS', pollMinutes: 15,
    installedAt: '2023-11-30', status: 'OFFLINE', staleMinutes: 13 * 60,
    // Refrigeration: runs around the clock, so its curve is nearly flat.
    meters: [{ slaveId: 1, name: 'EM-6000', baseKw: 147, startKwh: 3620.15, powerFactor: 0.93 }],
  },
  {
    uid: 'GW-JKL-0001', name: 'JKL Utility Panel', siteId: 'site-jkl',
    location: 'JKL - Basement LT Room', serial: 'VTK-SUB-1180-0412',
    hardwareModel: 'VERITEK SUB-1180', connectionType: 'Wi-Fi', pollMinutes: 5,
    installedAt: '2025-04-18', status: 'ONLINE', staleMinutes: 0,
    meters: [{ slaveId: 1, name: 'EM-7000', baseKw: 41, startKwh: 942.6, powerFactor: 0.97 }],
  },
];

/** Gateways created by the verification and load runs, not by anyone real. */
const TEST_UID_PATTERN = /^(GW-TEST-|TEST-GW-|SEC-[AB]-|LOAD-|E2E-|VERIFY-)/i;

/* ------------------------------------------------------------- waveform -- */

/**
 * A deterministic pseudo-random number in [-1, 1].
 *
 * Seeded rather than Math.random so that re-running the loader reproduces the
 * same history: the telemetry primary key is (meter, metric, time), so a rerun
 * is a no-op instead of quietly leaving two different versions of yesterday.
 */
function hashString(text: string): number {
  // FNV-1a. Only needs to scatter well, not to be cryptographic.
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash % 100000);
}

function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * Fraction of base load being drawn at a given moment: a two-shift industrial
 * pattern, damped at weekends, with a slow seasonal drift.
 *
 * `flat` is for loads like refrigeration that do not follow shift hours.
 */
function loadFactor(at: Date, siteOffsetMinutes: number, flat: boolean, seed: number, phaseHours: number): number {
  const local = new Date(at.getTime() + siteOffsetMinutes * 60_000);
  // Sites do not all start their shift at the same minute; without this every
  // meter's curve is the same shape and the dashboard looks obviously fake.
  const hour = (local.getUTCHours() + local.getUTCMinutes() / 60 + phaseHours + 24) % 24;
  const day = local.getUTCDay();

  if (flat) {
    // Cold storage: compressors cycle, and work a little harder in the afternoon.
    const duty = 0.82 + 0.13 * Math.sin(((hour - 15) / 24) * 2 * Math.PI);
    return duty + 0.04 * noise(seed);
  }

  let factor: number;
  if (hour < 6) factor = 0.28;                                  // night, idle plant
  else if (hour < 9) factor = 0.28 + ((hour - 6) / 3) * 0.62;   // first shift ramping up
  else if (hour < 13) factor = 0.9 + 0.08 * Math.sin(hour);     // full production
  else if (hour < 14) factor = 0.62;                            // lunch break
  else if (hour < 18) factor = 0.88 + 0.07 * Math.sin(hour * 1.3);
  else if (hour < 22) factor = 0.88 - ((hour - 18) / 4) * 0.5;  // second shift winding down
  else factor = 0.3;

  if (day === 0) factor *= 0.35;        // Sunday
  else if (day === 6) factor *= 0.68;   // Saturday half-day

  return Math.max(0.05, factor + 0.05 * noise(seed));
}

interface Sample {
  metric: string;
  value: number;
  unit: string | null;
}

/** One meter's full instrument reading at a moment in time. */
function readingAt(
  meter: DemoMeter, at: Date, kwhCounter: number, seed: number, flat: boolean, phaseHours: number,
): Sample[] {
  const factor = loadFactor(at, 330, flat, seed, phaseHours); // +05:30 sites
  const kw = meter.baseKw * factor;
  const pf = Math.min(0.99, Math.max(0.72, meter.powerFactor + 0.03 * noise(seed + 7)));
  const kva = kw / pf;
  const kvar = Math.sqrt(Math.max(0, kva * kva - kw * kw));

  // Supply voltage sags slightly under load, as it does in a real installation.
  const vBase = 415 - 6 * factor + 4 * noise(seed + 13);
  const v1 = vBase + 1.4 * noise(seed + 17);
  const v2 = vBase + 1.4 * noise(seed + 19);
  const v3 = vBase + 1.4 * noise(seed + 23);
  const vAvg = (v1 + v2 + v3) / 3;

  const aTotal = (kva * 1000) / (Math.sqrt(3) * vAvg);
  const a1 = aTotal * (1 + 0.03 * noise(seed + 29));
  const a2 = aTotal * (1 + 0.03 * noise(seed + 31));
  const a3 = aTotal * (1 + 0.03 * noise(seed + 37));

  const round = (n: number, dp: number): number => Number(n.toFixed(dp));

  return [
    { metric: 'voltage_l1', value: round(v1, 1), unit: 'V' },
    { metric: 'voltage_l2', value: round(v2, 1), unit: 'V' },
    { metric: 'voltage_l3', value: round(v3, 1), unit: 'V' },
    { metric: 'voltage_avg', value: round(vAvg, 1), unit: 'V' },
    { metric: 'current_l1', value: round(a1, 2), unit: 'A' },
    { metric: 'current_l2', value: round(a2, 2), unit: 'A' },
    { metric: 'current_l3', value: round(a3, 2), unit: 'A' },
    { metric: 'current_avg', value: round((a1 + a2 + a3) / 3, 2), unit: 'A' },
    { metric: 'active_power_kw', value: round(kw, 3), unit: 'kW' },
    { metric: 'reactive_power_kvar', value: round(kvar, 3), unit: 'kVAr' },
    { metric: 'apparent_power_kva', value: round(kva, 3), unit: 'kVA' },
    { metric: 'power_factor', value: round(pf, 3), unit: null },
    { metric: 'frequency_hz', value: round(50 + 0.08 * noise(seed + 41), 2), unit: 'Hz' },
    { metric: 'energy_import_kwh', value: round(kwhCounter, 3), unit: 'kWh' },
    { metric: 'apparent_energy_kvah', value: round(kwhCounter / pf, 3), unit: 'kVAh' },
    { metric: 'reactive_energy_kvarh', value: round(kwhCounter * 0.29, 3), unit: 'kVArh' },
  ];
}

/* ------------------------------------------------------------------ run -- */

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? String(process.argv[index + 1]) : fallback;
}

/** Append one reading at the current instant for every demo meter. */
async function tick(meterIds: Map<string, string>): Promise<void> {
  const now = new Date();

  for (const gateway of GATEWAYS) {
    // A gateway that is meant to look offline has to stay silent, or the badge
    // it exists to demonstrate turns green.
    if (gateway.staleMinutes > env.GATEWAY_OFFLINE_AFTER_SECONDS / 60) continue;

    const flat = gateway.uid === 'GW-XYZ-0001';
    const at = new Date(now.getTime() - gateway.staleMinutes * 60_000);
    const iso = at.toISOString();

    for (const meter of gateway.meters) {
      const meterId = meterIds.get(gateway.uid + ':' + meter.slaveId);
      if (!meterId) continue;

      const latest = await latestByMeter(meterId);
      const previous = latest.find((row) => row.metric === 'energy_import_kwh');
      const elapsedMinutes = previous
        ? Math.max(0, (at.getTime() - Date.parse(previous.time)) / 60_000)
        : 1;
      if (elapsedMinutes === 0) continue; // same instant; the key would collide

      const identity = hashString(gateway.uid + ':' + meter.slaveId);
      const phaseHours = ((identity % 13) - 6) / 10;
      const seed = identity + Math.floor(at.getTime() / 60_000);

      let counter = previous?.value ?? meter.startKwh;
      const preview = readingAt(meter, at, counter, seed, flat, phaseHours);
      const kw = preview.find((row) => row.metric === 'active_power_kw')?.value ?? 0;
      counter += (kw * elapsedMinutes) / 60;

      const samples = readingAt(meter, at, counter, seed, flat, phaseHours);
      await insertTelemetry(samples.map((sample) => ({
        time: iso, meterId, metric: sample.metric, value: sample.value,
        gatewayId: null, siteId: gateway.siteId, unit: sample.unit, quality: 'GOOD' as const,
        sourceTimestamp: iso, serverReceivedAt: iso, isBuffered: false,
        rawMessageId: null, fingerprint: null,
      })));

      await markDirty(AGGREGATION_BUCKETS.map((bucket) => ({
        bucket, meterId, bucketStart: bucketStart(iso, bucket, env.DEFAULT_SITE_TIMEZONE).toISOString(),
      })));
      await touchMeterData(meterId, iso);
    }

    const persisted = await upsertGateway({ gatewayUid: gateway.uid });
    await touchGatewaySeen(persisted.id, iso);
    await touchGatewayData(persisted.id, iso);
    await setGatewayStatus(persisted.id, gateway.status);
  }

  await flushAggregation(5000);
}

/**
 * Remove everything keyed to a meter.
 *
 * These tables carry no foreign key to `meters` - telemetry is a hypertable,
 * so the partitioning column has to stay free of them - which means deleting a
 * meter silently strands its rows instead of being refused. The alert list is
 * where that shows: orphaned events keep listing a device that is gone.
 */
async function purgeMeterData(meterId: string): Promise<void> {
  for (const table of [
    'telemetry', 'telemetry_fingerprints', 'telemetry_rollups', 'rollup_dirty',
    'energy_counter_state', 'energy_counter_events', 'alert_events',
  ]) {
    await db().execute('DELETE FROM ' + table + ' WHERE meter_id = $1', [meterId]);
  }
}

async function run(): Promise<void> {
  configureLogger({ level: env.LOG_LEVEL as never, pretty: env.LOG_PRETTY });

  const days = Math.max(1, Math.min(365, Number(flag('days', '30'))));
  const intervalMinutes = Math.max(1, Math.min(60, Number(flag('interval', '15'))));
  const purgeTest = process.argv.includes('--purge-test');

  const database = await connectDb();
  await migrate(database);

  for (const metric of METRIC_CATALOG) await upsertMetricDefinition(metric);

  /* ------------------------------------------------------------- sites -- */
  for (const site of SITES) {
    await upsertSite({
      id: site.id, name: site.name, code: site.code, city: site.city, state: site.state,
      address: site.address, timezone: env.DEFAULT_SITE_TIMEZONE, tariffPerKwh: 8.5, currency: 'INR',
    });
  }
  log.info('demo sites loaded', { sites: SITES.length });

  /* -------------------------------------------- gateways and their meters -- */
  const meterIds = new Map<string, string>();
  const now = new Date();

  for (const gateway of GATEWAYS) {
    const row = await upsertGateway({
      gatewayUid: gateway.uid,
      name: gateway.name,
      siteId: gateway.siteId,
      hardwareModel: gateway.hardwareModel,
      connectionType: gateway.connectionType,
      notes: 'Demonstration gateway - serial ' + gateway.serial + '. Not a physical device.',
      enabled: true,
      config: { serialNumber: gateway.serial, location: gateway.location },
    });

    for (const meter of gateway.meters) {
      const persisted = await upsertMeter({
        meterUid: gateway.uid + ':' + meter.slaveId,
        siteId: gateway.siteId,
        gatewayId: row.id,
        meterName: meter.name,
        location: gateway.location,
        slaveId: meter.slaveId,
        pollIntervalSeconds: gateway.pollMinutes * 60,
        enabled: true,
        installedAt: gateway.installedAt,
      });
      meterIds.set(gateway.uid + ':' + meter.slaveId, persisted.id);
    }
  }
  log.info('demo gateways loaded', {
    gateways: GATEWAYS.length,
    meters: meterIds.size,
  });

  /* --------------------------------------------------------- telemetry -- */
  const stepMs = intervalMinutes * 60_000;
  const dirty: Array<{ bucket: (typeof AGGREGATION_BUCKETS)[number]; meterId: string; bucketStart: string }> = [];
  let written = 0;

  for (const gateway of GATEWAYS) {
    const flat = gateway.uid === 'GW-XYZ-0001';
    // An offline gateway stopped reporting some hours ago; that gap is the
    // whole point of its "offline" badge, so its history has to end early.
    const end = new Date(now.getTime() - gateway.staleMinutes * 60_000);
    const start = new Date(end.getTime() - days * 86_400_000);

    for (const meter of gateway.meters) {
      const meterId = meterIds.get(gateway.uid + ':' + meter.slaveId);
      if (!meterId) continue;

      let counter = meter.startKwh;
      let meterRows = 0;
      const batch: TelemetryInsert[] = [];
      const seenBuckets = new Set<string>();
      // Seeded from the identity, not its length: every demo gateway id is
      // eleven characters, so a length-based seed gave five different sites
      // byte-identical voltages.
      const identity = hashString(gateway.uid + ':' + meter.slaveId);
      const phaseHours = ((identity % 13) - 6) / 10; // roughly +/- 36 minutes
      let seed = identity;

      for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
        const at = new Date(t);
        seed += 1;

        const samples = readingAt(meter, at, counter, seed, flat, phaseHours);
        // Advance the counter by the energy actually drawn over this interval,
        // so the cumulative total and the power curve tell the same story.
        const kw = samples.find((s) => s.metric === 'active_power_kw')?.value ?? 0;
        counter += (kw * intervalMinutes) / 60;

        const iso = at.toISOString();
        for (const sample of samples) {
          batch.push({
            time: iso,
            meterId,
            metric: sample.metric,
            value: sample.value,
            gatewayId: null,
            siteId: gateway.siteId,
            unit: sample.unit,
            quality: 'GOOD',
            sourceTimestamp: iso,
            serverReceivedAt: iso,
            isBuffered: false,
            rawMessageId: null,
            fingerprint: null,
          });
        }

        for (const bucket of AGGREGATION_BUCKETS) {
          const bStart = bucketStart(iso, bucket, env.DEFAULT_SITE_TIMEZONE).toISOString();
          const key = bucket + '|' + bStart;
          if (seenBuckets.has(key)) continue;
          seenBuckets.add(key);
          dirty.push({ bucket, meterId, bucketStart: bStart });
        }

        if (batch.length >= 600) {
          meterRows += await insertTelemetry(batch.splice(0, batch.length));
        }
      }

      if (batch.length > 0) meterRows += await insertTelemetry(batch);
      written += meterRows;

      const lastAt = new Date(end.getTime()).toISOString();
      await touchMeterData(meterId, lastAt);
      await setMeterStatus(meterId, gateway.status === 'OFFLINE' ? 'OFFLINE' : 'ONLINE');
      log.info('telemetry written', { meter: gateway.uid + ':' + meter.slaveId, rows: meterRows });
    }

    // Gateway presence mirrors the meter history that was just written.
    const seenAt = new Date(now.getTime() - gateway.staleMinutes * 60_000).toISOString();
    const persisted = await upsertGateway({ gatewayUid: gateway.uid });
    await touchGatewaySeen(persisted.id, seenAt);
    await touchGatewayData(persisted.id, seenAt);
    await setGatewayStatus(persisted.id, gateway.status);
  }

  log.info('telemetry loaded', { rows: written, days, intervalMinutes });

  /* ----------------------------------------------------------- rollups -- */
  await markDirty(dirty);
  log.info('rebuilding rollups', { buckets: dirty.length });
  const rebuilt = await flushAggregation(100_000);
  log.info('rollups rebuilt', { buckets: rebuilt });

  /* --------------------------------------------------- test leftovers -- */
  if (purgeTest) {
    let removedMeters = 0;
    let removedGateways = 0;
    for (const gateway of await listGateways()) {
      if (!TEST_UID_PATTERN.test(gateway.gatewayUid)) continue;
      for (const meter of await listMeters({ gatewayId: gateway.id })) {
        await purgeMeterData(meter.id);
        await deleteMeter(meter.id);
        removedMeters += 1;
      }
      // Gateway-level events carry no meter id, so purging by meter misses them.
      await db().execute('DELETE FROM alert_events WHERE gateway_id = $1', [gateway.id]);
      await deleteGateway(gateway.id);
      removedGateways += 1;
    }
    // Meters whose gateway was already gone.
    for (const meter of await listMeters()) {
      if (!TEST_UID_PATTERN.test(meter.meterUid)) continue;
      await purgeMeterData(meter.id);
      await deleteMeter(meter.id);
      removedMeters += 1;
    }
    log.info('verification leftovers removed', { gateways: removedGateways, meters: removedMeters });
  }

  log.info('demo dataset ready');

  /* --------------------------------------------------------------- live -- */
  if (process.argv.includes('--live')) {
    const everySeconds = Math.max(30, Math.min(900, Number(flag('live-interval', '60'))));
    log.info('live mode: appending readings', { everySeconds });

    let stopping = false;
    const stop = (): void => { stopping = true; };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    while (!stopping) {
      await new Promise((resolve) => setTimeout(resolve, everySeconds * 1000));
      if (stopping) break;
      try {
        await tick(meterIds);
      } catch (error: unknown) {
        // One bad tick must not end the run; the next one usually succeeds.
        log.warn('live tick failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    log.info('live mode stopped');
  }

  await closeDb();
}

run().catch((error: unknown) => {
  log.error('demo seeding failed', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
