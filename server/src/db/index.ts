import { env } from '../config/env.js';
import { createLogger } from '../core/logger.js';
import { createPostgresDb } from './postgres.js';
import { createSqliteDb } from './sqlite.js';
import type { Db, DbDriver } from './types.js';

const log = createLogger('db');

let instance: Db | null = null;

export function resolveDriver(): DbDriver {
  const configured = env.DB_DRIVER.toLowerCase();
  if (configured === 'postgres' || configured === 'postgresql' || configured === 'pg') return 'postgres';
  if (configured === 'sqlite') return 'sqlite';
  return env.DATABASE_URL ? 'postgres' : 'sqlite';
}

export async function connectDb(): Promise<Db> {
  if (instance) return instance;

  const driver = resolveDriver();
  if (driver === 'postgres') {
    if (!env.DATABASE_URL) {
      throw new Error('DB_DRIVER=postgres requires DATABASE_URL to be set.');
    }
    instance = await createPostgresDb({
      connectionString: env.DATABASE_URL,
      ssl: env.DATABASE_SSL,
      poolMax: env.DATABASE_POOL_MAX,
      timescaleEnabled: env.TIMESCALE_ENABLED,
    });
  } else {
    instance = await createSqliteDb(env.SQLITE_PATH);
    log.warn(
      'running on the embedded SQLite driver - fine for commissioning and tests, ' +
        'set DATABASE_URL to a Postgres/TimescaleDB instance for production.',
    );
  }
  return instance;
}

/** The connected database. Throws if called before {@link connectDb}. */
export function db(): Db {
  if (!instance) throw new Error('Database not connected yet - call connectDb() first.');
  return instance;
}

export async function closeDb(): Promise<void> {
  if (!instance) return;
  await instance.close();
  instance = null;
}

/** Test seam: inject a database built elsewhere. */
export function setDb(next: Db | null): void {
  instance = next;
}

export type { Db } from './types.js';
export { toBool, toInt, toIso, toJson, toNum, toStr } from './types.js';
