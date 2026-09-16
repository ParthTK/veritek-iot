import {
  ALERTS,
  ALERT_TRIGGERS,
  DEVICES,
  GENERAL_SETTINGS,
  METERS,
  NOTIFICATION_SETTINGS,
  USERS,
} from '@/data/seed';
import type {
  Alert,
  AlertTrigger,
  Device,
  Reading,
  GeneralSettings,
  Meter,
  NotificationSettings,
  User,
} from '@/types';
import {
  SEED_VERSION,
  STORAGE_KEYS,
  clearAllStores,
  migrateStoreIfStale,
  readStore,
  writeStore,
} from './storage';

// Must run before the first read so a stale cached seed is never loaded.
migrateStoreIfStale();

/**
 * In-memory mirror of the persisted demo data, with a tiny subscription
 * mechanism so React views re-render when a form mutates something.
 *
 * This is deliberately the single mutable seam in the app: swap the bodies of
 * the load/save helpers for HTTP calls and the rest of the UI is unchanged.
 */

interface StoreShape {
  devices: Device[];
  meters: Meter[];
  /** Per-meter history, filled from the backend. Not persisted: it is live data. */
  readings: Record<string, Reading[]>;
  /** Bumped on every store change, so a useMemo can depend on freshness. */
  version: number;
  /** True once the backend has answered at least once. */
  liveDataLoaded: boolean;
  users: User[];
  alerts: Alert[];
  triggers: AlertTrigger[];
  notifications: NotificationSettings;
  general: GeneralSettings;
}

function loadState(): StoreShape {
  return {
    devices: readStore(STORAGE_KEYS.devices, DEVICES),
    meters: readStore(STORAGE_KEYS.meters, METERS),
    users: readStore(STORAGE_KEYS.users, USERS),
    alerts: readStore(STORAGE_KEYS.alerts, ALERTS),
    triggers: readStore(STORAGE_KEYS.triggers, ALERT_TRIGGERS),
    notifications: readStore(STORAGE_KEYS.notifications, NOTIFICATION_SETTINGS),
    general: readStore(STORAGE_KEYS.general, GENERAL_SETTINGS),
    readings: {},
    version: 0,
    liveDataLoaded: false,
  };
}

let state: StoreShape = loadState();

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  state = { ...state, version: state.version + 1 };
  listeners.forEach((l) => l());
}

export function getState(): Readonly<StoreShape> {
  return state;
}

export function setDevices(devices: Device[]): void {
  state = { ...state, devices };
  writeStore(STORAGE_KEYS.devices, devices);
  emit();
}

export function setMeters(meters: Meter[]): void {
  state = { ...state, meters };
  writeStore(STORAGE_KEYS.meters, meters);
  emit();
}

export function setUsers(users: User[]): void {
  state = { ...state, users };
  writeStore(STORAGE_KEYS.users, users);
  emit();
}

export function setAlerts(alerts: Alert[]): void {
  state = { ...state, alerts };
  writeStore(STORAGE_KEYS.alerts, alerts);
  emit();
}

export function setTriggers(triggers: AlertTrigger[]): void {
  state = { ...state, triggers };
  writeStore(STORAGE_KEYS.triggers, triggers);
  emit();
}

export function setNotifications(notifications: NotificationSettings): void {
  state = { ...state, notifications };
  writeStore(STORAGE_KEYS.notifications, notifications);
  emit();
}

export function setGeneral(general: GeneralSettings): void {
  state = { ...state, general };
  writeStore(STORAGE_KEYS.general, general);
  emit();
}

/** Replace the device and meter lists with what the backend reports. */
export function setLiveDevicesAndMeters(devices: Device[], meters: Meter[]): void {
  state = { ...state, devices, meters, liveDataLoaded: true };
  emit();
}

/** Cache one meter's history. */
export function setReadings(meterId: string, readings: Reading[]): void {
  state = { ...state, readings: { ...state.readings, [meterId]: readings } };
  emit();
}

/**
 * Wipes every persisted change and restores the shipped seed data. The active
 * session is preserved — resetting the demo dataset should not sign you out.
 */
export function resetDemoData(): void {
  clearAllStores([STORAGE_KEYS.session]);
  writeStore(STORAGE_KEYS.seedVersion, SEED_VERSION);
  state = loadState();
  emit();
}
