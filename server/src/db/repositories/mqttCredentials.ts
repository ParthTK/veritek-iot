import { generateToken, hashSecret, newId, verifySecret } from '../../core/hash.js';
import { nowIso } from '../../core/time.js';
import { db } from '../index.js';
import { toInt, toIso, toJson, toStr } from '../types.js';
import type { AclSpec } from '../../iot/mqtt/topics.js';

/**
 * MQTT identities.
 *
 * One row per physical gateway, plus a small number of service accounts. The
 * broker resolves every CONNECT against this table over HTTP, so:
 *
 *   - a leaked credential is revoked by updating one row, not by editing and
 *     reloading a broker password file (spec section 6);
 *   - provisioning a new site is an API call (section 32);
 *   - a decommissioned gateway loses access immediately (section 33).
 *
 * Passwords are stored only as scrypt hashes. The plaintext is returned exactly
 * once, at issue, and never afterwards - including to the frontend.
 */

export type CredentialKind = 'device' | 'service';
export type CredentialStatus = 'active' | 'suspended' | 'revoked';

export interface MqttCredential {
  id: string;
  gatewayId: string | null;
  gatewayUid: string | null;
  mqttUsername: string;
  kind: CredentialKind;
  status: CredentialStatus;
  acl: AclSpec;
  clientIdPattern: string | null;
  lastAuthAt: string | null;
  lastAuthIp: string | null;
  authSuccessCount: number;
  authFailureCount: number;
  aclDenialCount: number;
  lastRotatedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function map(row: Record<string, unknown>): MqttCredential {
  return {
    id: String(row.id),
    gatewayId: toStr(row.gateway_id),
    gatewayUid: toStr(row.gateway_uid),
    mqttUsername: String(row.mqtt_username),
    kind: (toStr(row.kind) as CredentialKind) ?? 'device',
    status: (toStr(row.status) as CredentialStatus) ?? 'active',
    acl: toJson<AclSpec>(row.acl, { publish: [], subscribe: [] }),
    clientIdPattern: toStr(row.client_id_pattern),
    lastAuthAt: toIso(row.last_auth_at),
    lastAuthIp: toStr(row.last_auth_ip),
    authSuccessCount: toInt(row.auth_success_count) ?? 0,
    authFailureCount: toInt(row.auth_failure_count) ?? 0,
    aclDenialCount: toInt(row.acl_denial_count) ?? 0,
    lastRotatedAt: toIso(row.last_rotated_at),
    revokedAt: toIso(row.revoked_at),
    revokedReason: toStr(row.revoked_reason),
    notes: toStr(row.notes),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/* ------------------------------------------------------------------ reads -- */

export async function getCredentialById(id: string): Promise<MqttCredential | null> {
  const row = await db().one('SELECT * FROM mqtt_credentials WHERE id = $1', [id]);
  return row ? map(row) : null;
}

export async function getCredentialByUsername(username: string): Promise<MqttCredential | null> {
  const row = await db().one('SELECT * FROM mqtt_credentials WHERE mqtt_username = $1', [username]);
  return row ? map(row) : null;
}

export async function listCredentials(
  filter: { gatewayId?: string; kind?: CredentialKind; status?: CredentialStatus } = {},
): Promise<MqttCredential[]> {
  const clauses: string[] = [];
  const params: string[] = [];
  const add = (column: string, value: string): void => {
    params.push(value);
    clauses.push(column + ' = $' + params.length);
  };
  if (filter.gatewayId) add('gateway_id', filter.gatewayId);
  if (filter.kind) add('kind', filter.kind);
  if (filter.status) add('status', filter.status);

  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  return (await db().rows('SELECT * FROM mqtt_credentials' + where + ' ORDER BY created_at DESC', params)).map(map);
}

/**
 * Verify a username/password pair.
 *
 * Returns the credential only when it exists, is active, and the password
 * matches. The caller cannot tell those cases apart, which is deliberate.
 */
export async function verifyCredential(
  username: string,
  password: string,
): Promise<{ credential: MqttCredential | null; reason: string }> {
  const row = await db().one('SELECT * FROM mqtt_credentials WHERE mqtt_username = $1', [username]);
  if (!row) return { credential: null, reason: 'unknown username' };

  const credential = map(row);
  if (credential.status !== 'active') {
    return { credential: null, reason: 'credential is ' + credential.status };
  }
  if (!verifySecret(password, toStr(row.password_hash))) {
    return { credential: null, reason: 'password mismatch' };
  }
  return { credential, reason: 'ok' };
}

/* ----------------------------------------------------------------- writes -- */

export interface IssueCredentialInput {
  gatewayId?: string | null;
  gatewayUid?: string | null;
  mqttUsername: string;
  kind?: CredentialKind;
  acl: AclSpec;
  clientIdPattern?: string | null;
  createdBy?: string | null;
  notes?: string | null;
  /** Supply to pin a known password; otherwise one is generated. */
  password?: string;
}

export interface IssuedCredential {
  credential: MqttCredential;
  /** Shown once. Never stored, never retrievable again. */
  password: string;
}

export async function issueCredential(input: IssueCredentialInput): Promise<IssuedCredential> {
  const existing = await getCredentialByUsername(input.mqttUsername);
  const password = input.password ?? generateToken(24);
  const now = nowIso();

  if (existing) {
    // Re-issuing for an existing username is a rotation, not a duplicate.
    await db().execute(
      'UPDATE mqtt_credentials SET password_hash = $2, acl = $3, client_id_pattern = $4, ' +
        "status = 'active', revoked_at = NULL, revoked_reason = NULL, last_rotated_at = $5, " +
        'updated_at = $5 WHERE id = $1',
      [existing.id, hashSecret(password), input.acl, input.clientIdPattern ?? null, now],
    );
    const rotated = await getCredentialByUsername(input.mqttUsername);
    if (!rotated) throw new Error('Failed to rotate credential ' + input.mqttUsername);
    return { credential: rotated, password };
  }

  const id = newId('cred');
  await db().execute(
    'INSERT INTO mqtt_credentials (id, gateway_id, gateway_uid, mqtt_username, password_hash, kind, status, ' +
      'acl, client_id_pattern, last_rotated_at, created_by, notes, created_at, updated_at) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$11,$9,$9)",
    [
      id, input.gatewayId ?? null, input.gatewayUid ?? null, input.mqttUsername, hashSecret(password),
      input.kind ?? 'device', input.acl, input.clientIdPattern ?? null, now,
      input.createdBy ?? null, input.notes ?? null,
    ],
  );

  const credential = await getCredentialByUsername(input.mqttUsername);
  if (!credential) throw new Error('Failed to issue credential ' + input.mqttUsername);
  return { credential, password };
}

export async function setCredentialStatus(
  id: string,
  status: CredentialStatus,
  reason?: string | null,
): Promise<void> {
  const now = nowIso();
  await db().execute(
    'UPDATE mqtt_credentials SET status = $2, revoked_at = $3, revoked_reason = $4, updated_at = $5 WHERE id = $1',
    [id, status, status === 'revoked' ? now : null, status === 'active' ? null : (reason ?? null), now],
  );
}

export async function setCredentialAcl(id: string, acl: AclSpec): Promise<void> {
  await db().execute('UPDATE mqtt_credentials SET acl = $2, updated_at = $3 WHERE id = $1', [id, acl, nowIso()]);
}

/** Suspend or revoke every credential belonging to a gateway, in one step. */
export async function setGatewayCredentialsStatus(
  gatewayId: string,
  status: CredentialStatus,
  reason?: string | null,
): Promise<number> {
  const now = nowIso();
  return db().execute(
    'UPDATE mqtt_credentials SET status = $2, revoked_at = $3, revoked_reason = $4, updated_at = $5 ' +
      'WHERE gateway_id = $1',
    [gatewayId, status, status === 'revoked' ? now : null, status === 'active' ? null : (reason ?? null), now],
  );
}

export async function recordAuthOutcome(
  id: string,
  success: boolean,
  peerIp: string | null,
): Promise<void> {
  const now = nowIso();
  if (success) {
    await db().execute(
      'UPDATE mqtt_credentials SET auth_success_count = auth_success_count + 1, last_auth_at = $2, ' +
        'last_auth_ip = $3, updated_at = $2 WHERE id = $1',
      [id, now, peerIp],
    );
    return;
  }
  await db().execute(
    'UPDATE mqtt_credentials SET auth_failure_count = auth_failure_count + 1, updated_at = $2 WHERE id = $1',
    [id, now],
  );
}

export async function recordAclDenial(id: string): Promise<void> {
  await db().execute(
    'UPDATE mqtt_credentials SET acl_denial_count = acl_denial_count + 1, updated_at = $2 WHERE id = $1',
    [id, nowIso()],
  );
}

/* ------------------------------------------------------------ auth events -- */

export interface AuthEvent {
  eventType: 'connect' | 'acl_publish' | 'acl_subscribe';
  mqttUsername: string | null;
  clientId: string | null;
  gatewayId: string | null;
  gatewayUid: string | null;
  topic: string | null;
  peerIp: string | null;
  allowed: boolean;
  reason: string | null;
}

export async function recordAuthEvent(event: AuthEvent): Promise<void> {
  await db().execute(
    'INSERT INTO mqtt_auth_events (id, at, event_type, mqtt_username, client_id, gateway_id, gateway_uid, ' +
      'topic, peer_ip, allowed, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      newId('mae'), nowIso(), event.eventType, event.mqttUsername, event.clientId, event.gatewayId,
      event.gatewayUid, event.topic, event.peerIp, event.allowed, event.reason,
    ],
  );
}

export async function listAuthEvents(
  filter: { allowed?: boolean; mqttUsername?: string; limit?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const clauses: string[] = [];
  const params: (string | number | boolean)[] = [];
  if (filter.allowed !== undefined) {
    params.push(filter.allowed);
    clauses.push('allowed = $' + params.length);
  }
  if (filter.mqttUsername) {
    params.push(filter.mqttUsername);
    clauses.push('mqtt_username = $' + params.length);
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  params.push(Math.min(Math.max(filter.limit ?? 100, 1), 1000));
  return db().rows(
    'SELECT * FROM mqtt_auth_events' + where + ' ORDER BY at DESC LIMIT $' + params.length,
    params,
  );
}

/** Authentication-failure rate, for the alerting rule in spec section 20. */
export async function countRecentAuthFailures(sinceIso: string): Promise<number> {
  const row = await db().one<{ total: number }>(
    'SELECT COUNT(*) AS total FROM mqtt_auth_events WHERE allowed = $1 AND at >= $2',
    [false, sinceIso],
  );
  return toInt(row?.total) ?? 0;
}

export async function pruneAuthEvents(olderThanIso: string): Promise<number> {
  return db().execute('DELETE FROM mqtt_auth_events WHERE at < $1', [olderThanIso]);
}
