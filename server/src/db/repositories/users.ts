import { hashSecret, newId, verifySecret } from '../../core/hash.js';
import { nowIso } from '../../core/time.js';
import { db } from '../index.js';
import { toBool, toIso, toJson, toStr } from '../types.js';

export type UserRole = 'Super Admin' | 'Admin' | 'Operator' | 'Viewer';

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  active: boolean;
  /** Empty array means every site. */
  assignedSites: string[];
  lastLoginAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function map(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    phone: toStr(row.phone),
    role: (toStr(row.role) as UserRole) ?? 'Viewer',
    active: toBool(row.active),
    assignedSites: toJson<string[]>(row.assigned_sites, []),
    lastLoginAt: toIso(row.last_login_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function listUsers(): Promise<User[]> {
  return (await db().rows('SELECT * FROM users ORDER BY name')).map(map);
}

export async function getUser(id: string): Promise<User | null> {
  const row = await db().one('SELECT * FROM users WHERE id = $1', [id]);
  return row ? map(row) : null;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const row = await db().one('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
  return row ? map(row) : null;
}

/** Verify a sign-in. Returns null on any failure, without saying which. */
export async function authenticate(email: string, password: string): Promise<User | null> {
  // Case- and whitespace-insensitive: the address is an identifier, not a secret.
  const row = await db().one('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
  if (!row) return null;
  if (!verifySecret(password, toStr(row.password_hash))) return null;
  const user = map(row);
  if (!user.active) return null;
  await db().execute('UPDATE users SET last_login_at = $2 WHERE id = $1', [user.id, nowIso()]);
  return user;
}

export interface UserInput {
  id?: string;
  name: string;
  email: string;
  phone?: string | null;
  role?: UserRole;
  password?: string;
  active?: boolean;
  assignedSites?: string[];
}

export async function upsertUser(input: UserInput): Promise<User> {
  const existing = await getUserByEmail(input.email);
  const id = existing?.id ?? input.id ?? newId('usr');
  const now = nowIso();

  if (existing) {
    await db().execute(
      'UPDATE users SET name = $2, phone = $3, role = $4, active = $5, assigned_sites = $6, updated_at = $7 ' +
        'WHERE id = $1',
      [
        id, input.name, input.phone ?? null, input.role ?? 'Viewer', input.active ?? true,
        input.assignedSites ?? [], now,
      ],
    );
    if (input.password) {
      await db().execute('UPDATE users SET password_hash = $2, updated_at = $3 WHERE id = $1', [
        id, hashSecret(input.password), now,
      ]);
    }
  } else {
    if (!input.password) throw new Error('A password is required when creating a user.');
    await db().execute(
      'INSERT INTO users (id, name, email, phone, role, password_hash, active, assigned_sites, created_at, updated_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)',
      [
        id, input.name, input.email, input.phone ?? null, input.role ?? 'Viewer',
        hashSecret(input.password), input.active ?? true, input.assignedSites ?? [], now,
      ],
    );
  }

  const user = await getUser(id);
  if (!user) throw new Error('Failed to persist user');
  return user;
}

export async function deleteUser(id: string): Promise<boolean> {
  return (await db().execute('DELETE FROM users WHERE id = $1', [id])) > 0;
}

export async function countUsers(): Promise<number> {
  const row = await db().one<{ total: number }>('SELECT COUNT(*) AS total FROM users');
  return Number(row?.total ?? 0);
}

/* -------------------------------------------------------------- audit log -- */

export interface AuditEntry {
  actor: string | null;
  actorType?: 'user' | 'system' | 'device';
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Append to the audit trail. Remote-configuration commands must always land
 * here (spec section 18: "audit remote configuration commands").
 */
export async function audit(entry: AuditEntry): Promise<void> {
  await db().execute(
    'INSERT INTO audit_log (id, at, actor, actor_type, action, entity_type, entity_id, detail, ip) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      newId('aud'), nowIso(), entry.actor ?? null, entry.actorType ?? 'user', entry.action,
      entry.entityType ?? null, entry.entityId ?? null, entry.detail ?? {}, entry.ip ?? null,
    ],
  );
}

export async function listAuditLog(limit = 200): Promise<Array<Record<string, unknown>>> {
  return db().rows('SELECT * FROM audit_log ORDER BY at DESC LIMIT $1', [
    Math.min(Math.max(limit, 1), 1000),
  ]);
}

/* ----------------------------------------------------------- app settings -- */

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db().one('SELECT value FROM app_settings WHERE key = $1', [key]);
  return row ? toJson<T>(row.value, fallback) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db().execute(
    'INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,$3) ' +
      'ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [key, value as Record<string, unknown>, nowIso()],
  );
}
