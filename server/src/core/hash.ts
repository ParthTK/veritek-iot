import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

/** SHA-256 hex digest of the bytes exactly as they were received. */
export function payloadHash(payload: Buffer | string): string {
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Deterministic JSON: object keys sorted at every depth so that two logically
 * identical payloads hash identically regardless of key order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([k, v]) => [k, sortDeep(v)]));
  }
  if (typeof value === 'number') {
    // Round to 6 dp so float noise does not defeat duplicate detection.
    return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
  }
  return value;
}

export interface FingerprintInput {
  gatewayUid: string;
  slaveId: number | null;
  sourceTimestamp: string | null;
  measurements: Record<string, unknown>;
}

/**
 * Idempotency key for one meter sample (spec section 9).
 *
 * The gateway buffers readings while the cellular link is down and replays them
 * on reconnect, so the same measurement can legitimately arrive more than once.
 * Keying on gateway + slave + *source* time + the values themselves means a
 * replay collapses onto the row that already exists instead of double-counting
 * energy.
 */
export function sampleFingerprint(input: FingerprintInput): string {
  const canonical = [
    input.gatewayUid,
    input.slaveId === null ? '-' : String(input.slaveId),
    input.sourceTimestamp ?? '-',
    canonicalJson(input.measurements),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/* ------------------------------------------------------------ credentials -- */

const SCRYPT_KEYLEN = 32;

/** Hash a device secret or user password. Format: `scrypt$<saltHex>$<hashHex>`. */
export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(secret, salt, SCRYPT_KEYLEN);
  return 'scrypt$' + salt.toString('hex') + '$' + derived.toString('hex');
}

export function verifySecret(secret: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  try {
    const derived = scryptSync(secret, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN);
    const expected = Buffer.from(hashHex, 'hex');
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Short, non-reversible lookup key for a bearer token, so an inbound token can
 * be located with an index lookup before the (deliberately slow) scrypt compare.
 */
export function tokenLookupKey(token: string, pepper: string): string {
  return createHmac('sha256', pepper).update(token).digest('hex').slice(0, 32);
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function newId(prefix: string): string {
  return prefix + '_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

export { randomUUID };
