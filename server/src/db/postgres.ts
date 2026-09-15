import pg from 'pg';
import { createLogger, redactUrl } from '../core/logger.js';
import type { Db, QueryResult, SqlParam } from './types.js';

const log = createLogger('db:postgres');

/**
 * Postgres numeric types arrive as strings by default so that arbitrary
 * precision survives the wire. Every numeric column in this schema is a
 * measurement or a count that JavaScript can hold exactly, so parse them.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));
pg.types.setTypeParser(pg.types.builtins.FLOAT8, (value) => Number(value));

function encode(value: SqlParam): unknown {
  if (value === undefined) return null;
  if (value !== null && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    // jsonb columns take a JSON string; node-postgres will not stringify for us
    // reliably once arrays are involved.
    return JSON.stringify(value);
  }
  return value;
}

class PostgresDb implements Db {
  readonly driver = 'postgres' as const;
  timescale = false;

  constructor(
    private readonly runner: pg.Pool | pg.PoolClient,
    private readonly pool: pg.Pool,
  ) {}

  async query<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<QueryResult<T>> {
    try {
      const result = await this.runner.query(sql, params.map(encode));
      return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
    } catch (error) {
      log.error('query failed', { sql: sql.slice(0, 400), error });
      throw error;
    }
  }

  async rows<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return (await this.query<T>(sql, params)).rows;
  }

  async one<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | null> {
    const result = await this.query<T>(sql, params);
    return result.rows[0] ?? null;
  }

  async execute(sql: string, params: SqlParam[] = []): Promise<number> {
    return (await this.query(sql, params)).rowCount;
  }

  async exec(sql: string): Promise<void> {
    await this.runner.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // Already inside a transaction (we were handed a dedicated client).
    if (!('connect' in this.runner)) return fn(this);

    const client = await this.pool.connect();
    const tx = new PostgresDb(client, this.pool);
    tx.timescale = this.timescale;
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection already broken */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if ('end' in this.runner && this.runner === this.pool) await this.pool.end();
  }
}

export async function createPostgresDb(options: {
  connectionString: string;
  ssl: boolean;
  poolMax: number;
  timescaleEnabled: boolean;
}): Promise<Db> {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolMax,
    ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
    application_name: 'veritek-iot-backend',
  });

  pool.on('error', (error) => log.error('idle client error', { error }));

  const db = new PostgresDb(pool, pool);
  await db.query('SELECT 1');

  if (options.timescaleEnabled) {
    const found = await db.one<{ installed: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS installed",
    );
    db.timescale = Boolean(found?.installed);
  }

  log.info('postgres connected', {
    url: redactUrl(options.connectionString),
    timescale: db.timescale,
  });
  return db;
}
