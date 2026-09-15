import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createLogger } from '../core/logger.js';
import type { Db, QueryResult, SqlParam } from './types.js';

const log = createLogger('db:sqlite');

/**
 * Embedded SQLite driver, backed by Node's built-in `node:sqlite`.
 *
 * Its reason for existing is that the backend has to be provable end to end
 * before any infrastructure is installed: clone, `npm install`, `npm run dev`
 * and the whole ingest path runs. Production points DATABASE_URL at
 * Postgres/TimescaleDB and this file is never loaded.
 *
 * SQL is authored in Postgres dialect ($1 placeholders) and rewritten here, so
 * repositories are written once.
 */

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

/** Rewrite `$1, $2, ...` into SQLite's positional `?`, repeating reused params. */
export function rewritePlaceholders(sql: string, params: SqlParam[]): { sql: string; params: unknown[] } {
  const ordered: unknown[] = [];
  const rewritten = sql.replace(/\$(\d+)/g, (_match, index: string) => {
    ordered.push(params[Number(index) - 1]);
    return '?';
  });
  return { sql: rewritten, params: ordered };
}

function encode(value: SqlParam): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  // Objects and arrays are stored as JSON text; `toJson` reads them back.
  return JSON.stringify(value);
}

class SqliteDb implements Db {
  readonly driver = 'sqlite' as const;
  readonly timescale = false;

  private readonly db: SqliteDatabase;
  private readonly cache = new Map<string, SqliteStatement>();
  /** Serialises transactions - SQLite has no nested BEGIN. */
  private lock: Promise<unknown> = Promise.resolve();
  private inTransaction = false;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  private statement(sql: string): SqliteStatement {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  async query<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<QueryResult<T>> {
    const prepared = rewritePlaceholders(sql, params);
    const encoded = prepared.params.map((p) => encode(p as SqlParam));
    try {
      const rows = this.statement(prepared.sql).all(...encoded) as T[];
      // node:sqlite returns null-prototype objects; normalise for downstream code.
      const plain = rows.map((row) => ({ ...(row as object) }) as T);
      return { rows: plain, rowCount: plain.length };
    } catch (error) {
      log.error('query failed', { sql: prepared.sql.slice(0, 400), error });
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
    const prepared = rewritePlaceholders(sql, params);
    const encoded = prepared.params.map((p) => encode(p as SqlParam));
    try {
      // A statement with RETURNING must be stepped with all(), not run().
      if (/\breturning\b/i.test(prepared.sql)) {
        return this.statement(prepared.sql).all(...encoded).length;
      }
      const info = this.statement(prepared.sql).run(...encoded);
      return Number(info.changes ?? 0);
    } catch (error) {
      log.error('execute failed', { sql: prepared.sql.slice(0, 400), error });
      throw error;
    }
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this);

    const run = async (): Promise<T> => {
      this.inTransaction = true;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* the transaction was already unwound */
        }
        throw error;
      } finally {
        this.inTransaction = false;
      }
    };

    const next = this.lock.then(run, run);
    this.lock = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    this.cache.clear();
    this.db.close();
  }
}

export async function createSqliteDb(path: string): Promise<Db> {
  let DatabaseSync: new (path: string, options?: unknown) => SqliteDatabase;
  try {
    ({ DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string, options?: unknown) => SqliteDatabase;
    });
  } catch {
    throw new Error(
      'node:sqlite is unavailable in this Node build (needs Node 22.5+). ' +
        'Set DATABASE_URL to use Postgres instead.',
    );
  }

  const absolute = path === ':memory:' ? path : resolve(path);
  if (absolute !== ':memory:') mkdirSync(dirname(absolute), { recursive: true });

  const db = new DatabaseSync(absolute);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  log.info('embedded SQLite opened', { path: absolute });
  return new SqliteDb(db);
}
