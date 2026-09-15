import { env } from '../src/config/env.js';
import { configureLogger, createLogger } from '../src/core/logger.js';
import { connectDb } from '../src/db/index.js';
import { devCredentials, startEmbeddedBroker } from '../src/iot/mqtt/broker.js';

const log = createLogger('broker:cli');

/**
 * Run the embedded MQTT broker on its own.
 *
 * Useful when the backend is being restarted a lot during commissioning and you
 * do not want gateways or the simulator dropping their connection each time.
 * Set EMBEDDED_BROKER_ENABLED=false on the backend so the two do not fight over
 * the port.
 */
async function main(): Promise<void> {
  configureLogger({ level: env.LOG_LEVEL as never, pretty: env.LOG_PRETTY });

  // Gateway credentials are validated against the database.
  await connectDb();

  const started = await startEmbeddedBroker();
  if (!started) {
    log.error('broker did not start; EMBEDDED_BROKER_ENABLED is false or aedes is missing.');
    process.exit(1);
  }

  const credentials = devCredentials();
  log.info('broker ready', {
    port: env.EMBEDDED_BROKER_PORT,
    anonymous: env.EMBEDDED_BROKER_ALLOW_ANONYMOUS,
    username: credentials?.username,
  });
  log.info('Ctrl+C to stop.');
}

main().catch((error: unknown) => {
  log.error('broker failed to start', { error });
  process.exit(1);
});
