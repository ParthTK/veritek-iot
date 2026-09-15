import { DEMO_CREDENTIALS, DIAGNOSTIC_EVENTS, SITES } from '@/data/seed';
import {
  dailyBuckets,
  generateReadings,
  hourlyBuckets,
  sortByTimeDesc,
} from '@/data/readings';
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
  getState,
  setAlerts,
  setDevices,
  setMeters,
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
 * Mock sign-in. Accepts the demo credentials, or any known user's email with
 * the demo password, so the role-based views can be explored.
 */
export async function login(email: string, password: string): Promise<LoginResult> {
  // A short delay so the button's loading state is actually visible.
  await new Promise((resolve) => setTimeout(resolve, 700));

  const trimmed = email.trim().toLowerCase();
  const user = getState().users.find((u) => u.email.toLowerCase() === trimmed);

  if (!user) {
    return { ok: false, error: 'No account found for that email address.' };
  }
  if (password !== DEMO_CREDENTIALS.password) {
    return { ok: false, error: 'Incorrect email or password. Please try again.' };
  }
  if (!user.active) {
    return { ok: false, error: 'This account has been deactivated. Contact your administrator.' };
  }

  const session: Session = { user, loginAt: new Date().toISOString() };
  writeStore(STORAGE_KEYS.session, session);
  return { ok: true, session };
}

export function getSession(): Session | null {
  return readStore<Session | null>(STORAGE_KEYS.session, null);
}

export function logout(): void {
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
 * Reading history is derived, not stored: regenerating from a per-meter seed
 * keeps localStorage small and the series identical between sessions. Results
 * are memoised because the charts ask for them on every render.
 */
const readingCache = new Map<string, Reading[]>();

export function listReadings(meterId: string): Reading[] {
  const cached = readingCache.get(meterId);
  if (cached) return cached;

  const meter = getMeter(meterId);
  if (!meter) return [];

  const rows = sortByTimeDesc(generateReadings(meter));
  readingCache.set(meterId, rows);
  return rows;
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

export function getHourlyBuckets(meterId: string): ConsumptionBucket[] {
  return hourlyBuckets(listReadings(meterId));
}

export function getDailyBuckets(meterId: string, days = 7): ConsumptionBucket[] {
  const meter = getMeter(meterId);
  if (!meter) return [];
  return dailyBuckets(meter, listReadings(meterId), days);
}

/* ---------------------------------------------------------------- alerts -- */

export function listAlerts(): Alert[] {
  return [...getState().alerts].sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
  );
}

export function setAlertStatus(id: string, status: AlertStatus): void {
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
