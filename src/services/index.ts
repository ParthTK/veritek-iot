import { DIAGNOSTIC_EVENTS, SITES } from '@/data/seed';
import type {
  Alert,
  AlertStatus,
  AlertTrigger,
  ConsumptionBucket,
  Device,
  DiagnosticEvent,
  Meter,
  Reading,
  Session,
  Site,
  User,
} from '@/types';
import { STORAGE_KEYS, readStore, removeStore, writeStore } from './storage';
import {
  ApiError,
  apiLogin,
  apiLogout,
  fetchAlerts,
  fetchBuckets,
  fetchDevicesAndMeters,
  fetchReadings,
  getToken,
  openTelemetryStream,
  updateAlertStatus,
} from './api';
import {
  getState,
  setAlerts,
  setDevices,
  setLiveDevicesAndMeters,
  setMeters,
  setReadings,
  setTriggers,
  setUsers,
} from './dataStore';

export {
  getState,
  resetDemoData,
  setGeneral,
  setNotifications,
  subscribe,
} from './dataStore';

/* ------------------------------------------------------------------ auth -- */

export interface LoginResult {
  ok: boolean;
  error?: string;
  session?: Session;
}

/**
 * Sign in against the backend.
 *
 * The response carries a JWT, which api.ts stores and attaches to every later
 * request. A failure is reported with the same wording for every cause, so the
 * form cannot be used to discover which addresses have accounts.
 */
export async function login(email: string, password: string): Promise<LoginResult> {
  try {
    const user = await apiLogin(email.trim(), password);
    const session: Session = { user, loginAt: new Date().toISOString() };
    writeStore(STORAGE_KEYS.session, session);
    // Pull the estate immediately so the first screen after sign-in has data.
    void refreshLiveData();
    return { ok: true, session };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return { ok: false, error: 'Incorrect email or password. Please try again.' };
    }
    return {
      ok: false,
      error:
        error instanceof Error
          ? 'Could not reach the server: ' + error.message
          : 'Could not reach the server.',
    };
  }
}

export function getSession(): Session | null {
  return readStore<Session | null>(STORAGE_KEYS.session, null);
}

export function logout(): void {
  apiLogout();
  stopLiveUpdates();
  removeStore(STORAGE_KEYS.session);
  removeStore(STORAGE_KEYS.selectedDevice);
}

export function updateSessionUser(user: User): void {
  const session = getSession();
  if (session) writeStore(STORAGE_KEYS.session, { ...session, user });
}

/* ----------------------------------------------------------------- sites -- */

export function listSites(): Site[] {
  return SITES;
}

export function getSite(id: string): Site | undefined {
  return SITES.find((s) => s.id === id);
}

export function siteName(id: string): string {
  return getSite(id)?.name ?? '—';
}

/* --------------------------------------------------------------- devices -- */

export function listDevices(): Device[] {
  return getState().devices;
}

export function getDevice(id: string): Device | undefined {
  return getState().devices.find((d) => d.id === id);
}

export function saveDevice(device: Device): void {
  const devices = getState().devices;
  const index = devices.findIndex((d) => d.id === device.id);
  if (index === -1) setDevices([...devices, device]);
  else setDevices(devices.map((d) => (d.id === device.id ? device : d)));
}

export function deleteDevice(id: string): void {
  setDevices(getState().devices.filter((d) => d.id !== id));
  setMeters(getState().meters.filter((m) => m.deviceId !== id));
}

export function toggleDeviceActive(id: string): void {
  setDevices(
    getState().devices.map((d) => (d.id === id ? { ...d, active: !d.active } : d)),
  );
}

export function createDeviceId(): string {
  const existing = getState().devices.length + 1;
  return `dev-${String(existing).padStart(3, '0')}-${Date.now().toString(36).slice(-4)}`;
}

export function getSelectedDeviceId(): string | null {
  return readStore<string | null>(STORAGE_KEYS.selectedDevice, null);
}

export function setSelectedDeviceId(id: string | null): void {
  if (id === null) removeStore(STORAGE_KEYS.selectedDevice);
  else writeStore(STORAGE_KEYS.selectedDevice, id);
}

/* ---------------------------------------------------------------- meters -- */

export function listMeters(deviceId?: string): Meter[] {
  const meters = getState().meters;
  return deviceId ? meters.filter((m) => m.deviceId === deviceId) : meters;
}

export function getMeter(id: string): Meter | undefined {
  return getState().meters.find((m) => m.id === id);
}

/* -------------------------------------------------------------- readings -- */

/**
 * Reading history comes from the backend.
 *
 * The accessors stay synchronous so no component had to change: they return
 * whatever is cached in the store, and kick off a fetch when it is missing or
 * stale. The fetch writes into the store, which notifies subscribers, and the
 * views re-render with real data.
 */
const READING_TTL_MS = 30_000;
const readingFetchedAt = new Map<string, number>();
const inFlight = new Set<string>();

function ensureReadings(meterId: string): void {
  const last = readingFetchedAt.get(meterId) ?? 0;
  if (inFlight.has(meterId) || Date.now() - last < READING_TTL_MS) return;

  inFlight.add(meterId);
  const meter = getMeter(meterId);
  void fetchReadings(meterId, meter?.deviceId ?? '')
    .then((rows) => {
      readingFetchedAt.set(meterId, Date.now());
      setReadings(meterId, rows);
    })
    .catch(() => {
      // Leave the cache alone on failure; the next render retries after the TTL.
      readingFetchedAt.set(meterId, Date.now());
    })
    .finally(() => inFlight.delete(meterId));
}

export function listReadings(meterId: string): Reading[] {
  ensureReadings(meterId);
  return getState().readings[meterId] ?? [];
}

export function latestReading(meterId: string): Reading | undefined {
  return listReadings(meterId)[0];
}

export function listReadingsInRange(meterId: string, from: string, to: string): Reading[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return listReadings(meterId).filter((r) => {
    const t = Date.parse(r.timestamp);
    return t >= start && t <= end;
  });
}

/** Every reading across every meter, for the cross-device historical table. */
export function listAllReadings(): Reading[] {
  return getState()
    .meters.flatMap((m) => listReadings(m.id))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

/* Consumption buckets are computed by the backend - it owns the end-minus-start
   arithmetic, including counter rollovers and meter resets. */
const bucketCache = new Map<string, ConsumptionBucket[]>();
const bucketFetchedAt = new Map<string, number>();
const bucketInFlight = new Set<string>();

function ensureBuckets(
  key: string,
  meterId: string,
  interval: '1h' | '1d',
  from: string,
  labelFor: (at: string) => string,
): void {
  const last = bucketFetchedAt.get(key) ?? 0;
  if (bucketInFlight.has(key) || Date.now() - last < READING_TTL_MS) return;

  bucketInFlight.add(key);
  void fetchBuckets(meterId, interval, from, labelFor)
    .then((rows) => {
      bucketCache.set(key, rows);
      bucketFetchedAt.set(key, Date.now());
      // Nudge subscribers so views holding the old buckets re-render.
      setReadings(meterId, getState().readings[meterId] ?? []);
    })
    .catch(() => bucketFetchedAt.set(key, Date.now()))
    .finally(() => bucketInFlight.delete(key));
}

export function getHourlyBuckets(meterId: string): ConsumptionBucket[] {
  const key = meterId + '|1h';
  ensureBuckets(key, meterId, '1h', '-24h', (at) =>
    new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  );
  return bucketCache.get(key) ?? [];
}

export function getDailyBuckets(meterId: string, days = 7): ConsumptionBucket[] {
  const key = meterId + '|1d|' + days;
  ensureBuckets(key, meterId, '1d', '-' + days + 'd', (at) =>
    new Date(at).toLocaleDateString([], { day: '2-digit', month: 'short' }),
  );
  return bucketCache.get(key) ?? [];
}

/* ---------------------------------------------------------------- alerts -- */

export function listAlerts(): Alert[] {
  return [...getState().alerts].sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
  );
}

export function setAlertStatus(id: string, status: AlertStatus): void {
  // Optimistic: update locally so the row reacts immediately, then persist.
  const now = new Date().toISOString();
  setAlerts(
    getState().alerts.map((a) => {
      if (a.id !== id) return a;
      if (status === 'acknowledged') return { ...a, status, acknowledgedAt: now };
      if (status === 'resolved') {
        return { ...a, status, resolvedAt: now, acknowledgedAt: a.acknowledgedAt ?? now };
      }
      return { ...a, status };
    }),
  );

  if (status === 'acknowledged' || status === 'resolved') {
    void updateAlertStatus(id, status)
      // Re-read from the backend so the row reflects what was actually stored,
      // including a rejection we optimistically showed as applied.
      .then(() => refreshAlerts())
      .catch(() => refreshAlerts());
  }
}

export function listTriggers(meterId?: string): AlertTrigger[] {
  const triggers = getState().triggers;
  return meterId ? triggers.filter((t) => t.meterId === meterId) : triggers;
}

export function saveTrigger(trigger: AlertTrigger): void {
  const triggers = getState().triggers;
  const index = triggers.findIndex((t) => t.id === trigger.id);
  if (index === -1) setTriggers([...triggers, trigger]);
  else setTriggers(triggers.map((t) => (t.id === trigger.id ? trigger : t)));
}

export function deleteTrigger(id: string): void {
  setTriggers(getState().triggers.filter((t) => t.id !== id));
}

/* ----------------------------------------------------------- diagnostics -- */

export function listDiagnosticEvents(deviceId?: string): DiagnosticEvent[] {
  return deviceId
    ? DIAGNOSTIC_EVENTS.filter((e) => e.deviceId === deviceId)
    : DIAGNOSTIC_EVENTS;
}

/* ----------------------------------------------------------------- users -- */

export function listUsers(): User[] {
  return getState().users;
}

export function getUser(id: string): User | undefined {
  return getState().users.find((u) => u.id === id);
}

export function saveUser(user: User): void {
  const users = getState().users;
  const index = users.findIndex((u) => u.id === user.id);
  if (index === -1) setUsers([...users, user]);
  else setUsers(users.map((u) => (u.id === user.id ? user : u)));
}

export function deleteUser(id: string): void {
  setUsers(getState().users.filter((u) => u.id !== id));
}

export function toggleUserActive(id: string): void {
  setUsers(getState().users.map((u) => (u.id === id ? { ...u, active: !u.active } : u)));
}

export function createUserId(): string {
  return `usr-${Date.now().toString(36).slice(-6)}`;
}

/* ------------------------------------------------------------ live data -- */

/**
 * Pull the estate from the backend into the store.
 *
 * Called after sign-in, on app start when a token is already held, and whenever
 * the live stream reports something changed.
 */
export async function refreshLiveData(): Promise<void> {
  if (!getToken()) return;
  try {
    const { devices, meters } = await fetchDevicesAndMeters();
    setLiveDevicesAndMeters(devices, meters);
  } catch {
    // Offline or signed out. The last known estate stays on screen rather than
    // the dashboard emptying itself.
  }
  await refreshAlerts();
}

export async function refreshAlerts(): Promise<void> {
  if (!getToken()) return;
  try {
    setAlerts(await fetchAlerts());
  } catch {
    /* keep what we have */
  }
}

let stopStream: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let pendingRefresh: ReturnType<typeof setTimeout> | null = null;

/**
 * Start following the backend: server-sent events for immediate updates, plus a
 * slow poll so a dropped stream cannot leave the dashboard silently stale.
 */
export function startLiveUpdates(): void {
  if (!getToken() || stopStream) return;

  void refreshLiveData();

  stopStream = openTelemetryStream(() => {
    // A busy site emits many readings a second; coalesce them into one refresh.
    if (pendingRefresh) clearTimeout(pendingRefresh);
    pendingRefresh = setTimeout(() => {
      readingFetchedAt.clear();
      bucketFetchedAt.clear();
      void refreshLiveData();
    }, 1000);
  });

  refreshTimer = setInterval(() => void refreshLiveData(), 60_000);
}

export function stopLiveUpdates(): void {
  stopStream?.();
  stopStream = null;
  if (refreshTimer) clearInterval(refreshTimer);
  if (pendingRefresh) clearTimeout(pendingRefresh);
  refreshTimer = null;
  pendingRefresh = null;
  readingFetchedAt.clear();
  bucketFetchedAt.clear();
  bucketCache.clear();
}

/** True once the backend has answered at least once. */
export function isLiveDataLoaded(): boolean {
  return getState().liveDataLoaded;
}
