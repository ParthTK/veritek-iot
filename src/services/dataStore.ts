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
import { DATA_MODE, SHOWS_DEMO } from './dataMode';
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
  /**
   * What the views read: the demo fixtures, the live estate, or both,
   * depending on the data mode. Components stay unaware of the difference.
   */
  devices: Device[];
  meters: Meter[];
  /** Per-meter history, filled from the backend. Not persisted: it is live data. */
  readings: Record<string, Reading[]>;
  /** Bumped on every store change, so a useMemo can depend on freshness. */
  version: number;
  /** True once the backend has answered at least once. */
  liveDataLoaded: boolean;
  /** The bundled fixtures, kept apart so live data never overwrites them. */
  demoDevices: Device[];
  demoMeters: Meter[];
  /** What the backend reports. Never persisted: it is somebody else's record. */
  liveDevices: Device[];
  liveMeters: Meter[];
  liveAlerts: Alert[];
  demoAlerts: Alert[];
  users: User[];
  alerts: Alert[];
  triggers: AlertTrigger[];
  notifications: NotificationSettings;
  general: GeneralSettings;
}

function loadState(): StoreShape {
  const demoDevices = readStore(STORAGE_KEYS.devices, DEVICES);
  const demoMeters = readStore(STORAGE_KEYS.meters, METERS);
  return {
    demoDevices,
    demoMeters,
    liveDevices: [],
    liveMeters: [],
    liveAlerts: [],
    demoAlerts: readStore(STORAGE_KEYS.alerts, ALERTS),
    devices: SHOWS_DEMO ? demoDevices : [],
    meters: SHOWS_DEMO ? demoMeters : [],
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

/**
 * Recompute what the views see.
 *
 * Live devices come first: a real device that has just been connected is the
 * one someone is looking for.
 */
function combined(next: StoreShape): StoreShape {
  // The server still holds seeded copies of the demo gateways, under the same
  // ids as the bundled fixtures. Listing both would show every demo device
  // twice, so on a collision the fixture wins: it is the one with freshly
  // generated readings, while the server's copy stopped being written to.
  // Real devices have their own ids and are unaffected.
  const demoIds = new Set(next.demoDevices.map((device) => device.deviceId));
  const liveOnly = next.liveDevices.filter((device) => !demoIds.has(device.deviceId));
  const liveOnlyIds = new Set(liveOnly.map((device) => device.id));

  const devices = DATA_MODE === 'demo' ? next.demoDevices
    : DATA_MODE === 'live' ? next.liveDevices
    : [...liveOnly, ...next.demoDevices];
  const meters = DATA_MODE === 'demo' ? next.demoMeters
    : DATA_MODE === 'live' ? next.liveMeters
    : [...next.liveMeters.filter((meter) => liveOnlyIds.has(meter.deviceId)), ...next.demoMeters];
  const alerts = DATA_MODE === 'demo' ? next.demoAlerts
    : DATA_MODE === 'live' ? next.liveAlerts
    : [...next.liveAlerts, ...next.demoAlerts];
  return { ...next, devices, meters, alerts };
}

export function setDevices(devices: Device[]): void {
  state = combined({ ...state, demoDevices: devices });
  writeStore(STORAGE_KEYS.devices, devices);
  emit();
}

export function setMeters(meters: Meter[]): void {
  state = combined({ ...state, demoMeters: meters });
  writeStore(STORAGE_KEYS.meters, meters);
  emit();
}

export function setUsers(users: User[]): void {
  state = { ...state, users };
  writeStore(STORAGE_KEYS.users, users);
  emit();
}

export function setAlerts(alerts: Alert[]): void {
  state = combined({ ...state, demoAlerts: alerts });
  writeStore(STORAGE_KEYS.alerts, alerts);
  emit();
}

/** Alerts the backend raised, against real devices. */
export function setLiveAlerts(alerts: Alert[]): void {
  state = combined({ ...state, liveAlerts: alerts });
  emit();
}

export function isLiveAlert(id: string): boolean {
  return state.liveAlerts.some((alert) => alert.id === id);
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

/** Replace the live half of the estate with what the backend reports. */
export function setLiveDevicesAndMeters(devices: Device[], meters: Meter[]): void {
  state = combined({ ...state, liveDevices: devices, liveMeters: meters, liveDataLoaded: true });
  emit();
}

/** Did this device come from the backend, or is it a bundled fixture? */
export function isLiveDevice(id: string): boolean {
  return state.liveDevices.some((device) => device.id === id);
}

export function isLiveMeter(id: string): boolean {
  return state.liveMeters.some((meter) => meter.id === id);
}

/** The live estate, for callers that must not touch the fixtures. */
export function liveEstate(): { devices: Device[]; meters: Meter[] } {
  return { devices: state.liveDevices, meters: state.liveMeters };
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
  // Live devices are the backend's record, not demo data: a reset restores the
  // fixtures and leaves them alone.
  const { liveDevices, liveMeters, liveAlerts, liveDataLoaded } = state;
  state = combined({ ...loadState(), liveDevices, liveMeters, liveAlerts, liveDataLoaded });
  emit();
}
