/**
 * Thin localStorage wrapper. Everything the demo persists goes through here so
 * "Reset demo data" only has to clear one namespace, and so a real backend can
 * replace the services above without touching component code.
 */

const NAMESPACE = 'technode';

/**
 * Bump whenever the shipped seed changes in a way that persisted copies would
 * contradict — renamed demo credentials, reshaped entities, new fixtures.
 * A mismatch discards the cached copy so returning visitors pick the new seed
 * up instead of being stranded on stale data.
 */
export const SEED_VERSION = '2';

export const STORAGE_KEYS = {
  seedVersion: `${NAMESPACE}.seedVersion`,
  session: `${NAMESPACE}.session`,
  devices: `${NAMESPACE}.devices`,
  meters: `${NAMESPACE}.meters`,
  users: `${NAMESPACE}.users`,
  alerts: `${NAMESPACE}.alerts`,
  triggers: `${NAMESPACE}.triggers`,
  notifications: `${NAMESPACE}.notifications`,
  general: `${NAMESPACE}.general`,
  selectedDevice: `${NAMESPACE}.selectedDevice`,
} as const;

/**
 * Drops every cached entry, including the session, when the shipped seed has
 * moved on. Runs once at module load, before any reads.
 */
export function migrateStoreIfStale(): void {
  if (typeof window === 'undefined') return;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEYS.seedVersion);
    if (stored === JSON.stringify(SEED_VERSION)) return;
    Object.values(STORAGE_KEYS).forEach((key) => window.localStorage.removeItem(key));
    window.localStorage.setItem(STORAGE_KEYS.seedVersion, JSON.stringify(SEED_VERSION));
  } catch {
    // Storage unavailable; the app falls back to the in-memory seed anyway.
  }
}

export function readStore<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt or unreadable entry — fall back to the seed rather than crash.
    return fallback;
  }
}

export function writeStore<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or private mode; the demo still works from memory.
  }
}

export function removeStore(key: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(key);
}

/**
 * Clears the keys this app owns, leaving other origins' data alone.
 *
 * `keep` exists so "Reset demo data" can restore the seed without also
 * dropping the session key and bouncing the signed-in user to the login page.
 */
export function clearAllStores(keep: readonly string[] = []): void {
  if (typeof window === 'undefined') return;
  Object.values(STORAGE_KEYS)
    .filter((key) => !keep.includes(key))
    .forEach((key) => window.localStorage.removeItem(key));
}
