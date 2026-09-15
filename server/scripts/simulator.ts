import { env } from '../src/config/env.js';
import { configureLogger, createLogger } from '../src/core/logger.js';
import { GatewaySimulator } from '../src/iot/simulator/simulator.js';

const log = createLogger('simulator:cli');

/**
 * Standalone simulator.
 *
 *   npm run simulator
 *   npm run simulator -- --interval 10 --slaves 1,2,3
 *   npm run simulator -- --transport http
 *   npm run simulator -- --buffer-test          # offline-buffer scenario
 *   npm run simulator -- --replay 10 --duplicate
 *
 * Runs against a backend that is already up (`npm run dev` in another shell).
 */

function flag(name: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : 'true';
}

function has(name: string): boolean {
  return process.argv.includes('--' + name);
}

async function main(): Promise<void> {
  configureLogger({ level: env.LOG_LEVEL as never, pretty: env.LOG_PRETTY });

  const slaves = flag('slaves');
  const simulator = new GatewaySimulator({
    gatewayUid: flag('gateway') ?? env.SIMULATOR_GATEWAY_UID,
    slaveIds: slaves ? slaves.split(',').map(Number).filter(Number.isFinite) : undefined,
    intervalSeconds: flag('interval') ? Number(flag('interval')) : undefined,
    transport: (flag('transport') as 'mqtt' | 'http' | undefined) ?? undefined,
    password: flag('password') ?? env.EMBEDDED_BROKER_DEFAULT_PASSWORD,
    deviceToken: flag('token') ?? env.SIMULATOR_DEVICE_TOKEN,
  });

  await simulator.connect();

  /* -- replay: back-fill historical readings in one burst ----------------- */
  if (has('replay')) {
    const minutes = Number(flag('replay')) || 10;
    log.warn('publishing ' + minutes + ' minutes of historical readings in one burst', {
      duplicate: has('duplicate'),
    });
    const payloads = await simulator.replayHistorical({
      minutesBack: minutes,
      stepSeconds: Number(flag('step')) || 60,
      duplicate: has('duplicate'),
    });
    log.info('replay complete', {
      readings: payloads.length,
      oldest: payloads[0]?.timestamp,
      newest: payloads[payloads.length - 1]?.timestamp,
      note: 'History should show these at their own timestamps, not at the moment they arrived.',
    });
    await simulator.disconnect();
    return;
  }

  /* -- buffer test: live, then a simulated outage, then a flush ----------- */
  if (has('buffer-test')) {
    const outageSeconds = Number(flag('outage')) || 60;
    log.warn('offline-buffer scenario starting', { outageSeconds });

    simulator.start();
    await wait(Math.max(2, simulator.stats.published === 0 ? 3 : 3) * 1000);

    simulator.goOffline();
    log.warn('network is "down" - readings are accumulating on the device');
    await wait(outageSeconds * 1000);

    const flushed = await simulator.goOnline();
    log.info('buffer flushed', {
      readings: flushed,
      note: 'Every one keeps its original measurement time; duplicates are rejected by fingerprint.',
    });

    await wait(5000);
    await simulator.disconnect();
    return;
  }

  /* -- default: publish continuously -------------------------------------- */
  simulator.start();
  log.info('simulator running - Ctrl+C to stop', simulator.stats);

  process.on('SIGINT', () => {
    void simulator.disconnect().then(() => {
      log.info('simulator stopped', simulator.stats);
      process.exit(0);
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  log.error('simulator failed', { error });
  process.exit(1);
});
