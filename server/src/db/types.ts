export type DbDriver = 'postgres' | 'sqlite';

export type SqlParam =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date
  | Buffer
  // Objects and arrays are serialised to JSON by the driver for jsonb / TEXT
  // columns; a declared interface is as valid here as a loose record.
  | object;

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  readonly driver: DbDriver;
  /** True when the connected Postgres has the TimescaleDB extension loaded. */
  readonly timescale: boolean;

  query<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<QueryResult<T>>;
  rows<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | null>;
  execute(sql: string, params?: SqlParam[]): Promise<number>;
  /** Run raw, multi-statement DDL. No parameters. */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------- row codecs -- */

/** Postgres hands back a Date; SQLite hands back the ISO string we stored. */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  const text = String(value);
  if (!text) return null;
  // SQLite CURRENT_TIMESTAMP yields 'YYYY-MM-DD HH:MM:SS' with no zone marker.
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? text.replace(' ', 'T') + 'Z'
    : text;
  const date = new Date(normalised);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

/** Postgres jsonb arrives parsed; SQLite arrives as text. */
export function toJson<T = unknown>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value === 'string') {
    if (value.trim() === '') return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return /^(1|t|true|yes|on)$/i.test(value);
  return false;
}

export function toNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toInt(value: unknown): number | null {
  const parsed = toNum(value);
  return parsed === null ? null : Math.trunc(parsed);
}

export function toStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}
