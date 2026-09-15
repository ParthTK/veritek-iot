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
