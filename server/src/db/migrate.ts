import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogEvent } from '../core/logEvents.js';
import { createLogger } from '../core/logger.js';
import { payloadHash } from '../core/hash.js';
import type { Db } from './types.js';

const log = createLogger('db:migrate');

const here = dirname(fileURLToPath(import.meta.url));
// src/db -> server/migrations, and dist/db -> server/migrations once compiled.
const MIGRATIONS_ROOT = join(here, '..', '..', 'migrations');

interface MigrationFile {
  id: string;
  path: string;
  sql: string;
}

function loadMigrations(driver: 'postgres' | 'sqlite', timescale: boolean): MigrationFile[] {
  const dir = join(MIGRATIONS_ROOT, driver);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const selected: MigrationFile[] = [];
  for (const name of files) {
    if (name.includes('timescale') && !timescale) {
      log.info('skipping Timescale migration (extension not installed)', { file: name });
      continue;
    }
    selected.push({ id: name, path: join(dir, name), sql: readFileSync(join(dir, name), 'utf8') });
  }
  return selected;
}

async function ensureMigrationTable(database: Db): Promise<void> {
  const timestampType = database.driver === 'postgres' ? 'TIMESTAMPTZ' : 'TEXT';
  await database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
      '  id TEXT PRIMARY KEY,' +
      '  checksum TEXT NOT NULL,' +
      '  applied_at ' + timestampType + ' NOT NULL' +
      ')',
  );
}

/**
 * Apply every pending migration. Idempotent: the DDL itself is written with
 * IF NOT EXISTS so a re-run against a live database is safe.
 */
export async function migrate(database: Db): Promise<string[]> {
  await ensureMigrationTable(database);

  const applied = new Map<string, string>();
  for (const row of await database.rows<{ id: string; checksum: string }>(
    'SELECT id, checksum FROM schema_migrations',
  )) {
    applied.set(row.id, row.checksum);
  }

  const pending: string[] = [];
  for (const migration of loadMigrations(database.driver, database.timescale)) {
    const checksum = payloadHash(migration.sql).slice(0, 32);
    const existing = applied.get(migration.id);

    if (existing) {
      if (existing !== checksum) {
        log.warn('migration file changed after it was applied', { id: migration.id });
      }
      continue;
    }

    log.info('applying migration', { id: migration.id });
    await database.exec(migration.sql);
    await database.execute(
      'INSERT INTO schema_migrations (id, checksum, applied_at) VALUES ($1, $2, $3)',
      [migration.id, checksum, new Date().toISOString()],
    );
    pending.push(migration.id);
  }

  log.info(pending.length ? 'migrations applied' : 'schema already up to date', {
    event: LogEvent.DB_MIGRATED,
    driver: database.driver,
    timescale: database.timescale,
    applied: pending,
  });
  return pending;
}
