import { env } from '../src/config/env.js';
import { configureLogger, createLogger } from '../src/core/logger.js';
import { closeDb, connectDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';

const log = createLogger('migrate');

configureLogger({ level: env.LOG_LEVEL as never, pretty: env.LOG_PRETTY });

connectDb()
  .then(async (database) => {
    const applied = await migrate(database);
    log.info(applied.length ? 'migrations applied' : 'nothing to apply', { applied });
    await closeDb();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log.error('migration failed', { error });
    await closeDb();
    process.exit(1);
  });
