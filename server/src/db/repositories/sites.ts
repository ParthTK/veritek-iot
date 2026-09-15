import { env } from '../../config/env.js';
import { newId } from '../../core/hash.js';
import { nowIso } from '../../core/time.js';
import { db } from '../index.js';
import { toIso, toNum, toStr } from '../types.js';

export interface Site {
  id: string;
  name: string;
  code: string | null;
  city: string | null;
  state: string | null;
  address: string | null;
  timezone: string;
  tariffPerKwh: number | null;
  currency: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function map(row: Record<string, unknown>): Site {
  return {
    id: String(row.id),
    name: String(row.name),
    code: toStr(row.code),
    city: toStr(row.city),
    state: toStr(row.state),
    address: toStr(row.address),
    timezone: toStr(row.timezone) ?? env.DEFAULT_SITE_TIMEZONE,
    tariffPerKwh: toNum(row.tariff_per_kwh),
    currency: toStr(row.currency),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function listSites(): Promise<Site[]> {
  const rows = await db().rows('SELECT * FROM sites ORDER BY name');
  return rows.map(map);
}

export async function getSite(id: string): Promise<Site | null> {
  const row = await db().one('SELECT * FROM sites WHERE id = $1', [id]);
  return row ? map(row) : null;
}

/** Site timezone, falling back to the configured default. Cached per request. */
export async function siteTimezone(siteId: string | null | undefined): Promise<string> {
  if (!siteId) return env.DEFAULT_SITE_TIMEZONE;
  const row = await db().one<{ timezone: string }>('SELECT timezone FROM sites WHERE id = $1', [siteId]);
  return row?.timezone ?? env.DEFAULT_SITE_TIMEZONE;
}

export interface SiteInput {
  id?: string;
  name: string;
  code?: string | null;
  city?: string | null;
  state?: string | null;
  address?: string | null;
  timezone?: string;
  tariffPerKwh?: number | null;
  currency?: string | null;
}

export async function upsertSite(input: SiteInput): Promise<Site> {
  const id = input.id ?? newId('site');
  const now = nowIso();
  await db().execute(
    'INSERT INTO sites (id, name, code, city, state, address, timezone, tariff_per_kwh, currency, created_at, updated_at) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) ' +
      'ON CONFLICT (id) DO UPDATE SET name = excluded.name, code = excluded.code, city = excluded.city, ' +
      'state = excluded.state, address = excluded.address, timezone = excluded.timezone, ' +
      'tariff_per_kwh = excluded.tariff_per_kwh, currency = excluded.currency, updated_at = excluded.updated_at',
    [
      id,
      input.name,
      input.code ?? null,
      input.city ?? null,
      input.state ?? null,
      input.address ?? null,
      input.timezone ?? env.DEFAULT_SITE_TIMEZONE,
      input.tariffPerKwh ?? null,
      input.currency ?? 'INR',
      now,
    ],
  );
  const site = await getSite(id);
  if (!site) throw new Error('Failed to persist site ' + id);
  return site;
}

export async function deleteSite(id: string): Promise<boolean> {
  return (await db().execute('DELETE FROM sites WHERE id = $1', [id])) > 0;
}
