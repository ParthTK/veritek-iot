/**
 * Domain model for the VERITEK IoT energy-monitoring platform.
 *
 * These interfaces describe the shapes the UI consumes. The service layer in
 * `src/services` is the only place that knows where the data actually comes
 * from, so swapping the mock generators for a real API means reimplementing
 * the services against these same types.
 */

export type UserRole = 'Super Admin' | 'Admin' | 'Operator' | 'Viewer';

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  /** Site ids this user may access. */
  assignedSites: string[];
  /** Device ids this user may access; empty means "all in assigned sites". */
  assignedDevices: string[];
  active: boolean;
  lastLogin: string | null;
  avatarInitials: string;
}

export interface Site {
  id: string;
  name: string;
  code: string;
  city: string;
  state: string;
  address: string;
}

export type ConnectionStatus = 'online' | 'offline' | 'warning';
export type CommunicationMode = '4G LTE' | '2G GPRS' | 'Ethernet' | 'Wi-Fi' | 'RS-485';
export type MeterType = 'Energy Monitoring System (EMS)' | 'Tri-Vector Meter' | 'CT Operated' | 'Sub-Meter';

export interface Device {
  id: string;
  /** SIM / gateway identifier, e.g. GW-ABC-0001 */
  deviceId: string;
  name: string;
  serialNumber: string;
  siteId: string;
  /** Free-text location within the site, e.g. "Plant 1 — Feeder A" */
  location: string;
  meterType: MeterType;
  communicationMode: CommunicationMode;
  /** Polling interval in minutes. */
  readingInterval: number;
  status: ConnectionStatus;
  active: boolean;
  installationDate: string;
  lastSeen: string;
  modemCount: number;
  assignedUserId: string | null;
  thresholds: DeviceThresholds;
}

export interface DeviceThresholds {
  voltageMin: number;
  voltageMax: number;
  currentMax: number;
  powerMax: number;
  energyMax: number;
  powerFactorMin: number;
  frequencyMin: number;
  frequencyMax: number;
  warningPercent: number;
  criticalPercent: number;
  notificationsEnabled: boolean;
}

/** A physical energy meter hanging off a device/gateway. */
export interface Meter {
  id: string;
  deviceId: string;
  name: string;
  kwh: number;
  kvah: number;
  kvarh: number;
  lastReadingAt: string;
}

/**
 * One polled sample from a meter. Field names follow the reference capture's
 * column headers (VRN/VYN/VBN line-to-neutral, VRY/VYB/VBR line-to-line).
 */
export interface Reading {
  id: string;
  meterId: string;
  deviceId: string;
  timestamp: string;
  kwh: number;
  kvah: number;
  kvarh: number;
  vrn: number;
  vyn: number;
  vbn: number;
  vry: number;
  vyb: number;
  vbr: number;
  ir: number;
  iy: number;
  ib: number;
  kwR: number;
  kwY: number;
  kwB: number;
  pfR: number;
  pfY: number;
  pfB: number;
  frequency: number;
}

export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertStatus = 'active' | 'acknowledged' | 'resolved';

export interface Alert {
  id: string;
  deviceId: string;
  meterId: string | null;
  timestamp: string;
  type: string;
  metric: string;
  message: string;
  value: number;
  threshold: number;
  unit: string;
  severity: AlertSeverity;
  status: AlertStatus;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export type TriggerCondition = 'above' | 'below';

export interface AlertTrigger {
  id: string;
  meterId: string;
  metric: string;
  metricLabel: string;
  condition: TriggerCondition;
  threshold: number;
  emailEnabled: boolean;
  email: string;
  createdAt: string;
}

export interface DiagnosticEvent {
  id: string;
  deviceId: string;
  timestamp: string;
  kind:
    | 'normal-voltage'
    | 'high-voltage'
    | 'low-power-factor'
    | 'consumption-spike'
    | 'device-disconnected';
  label: string;
  detail: string;
  severity: AlertSeverity;
}

export interface NotificationSettings {
  emailNotifications: boolean;
  smsNotifications: boolean;
  systemAlerts: boolean;
  warningAlerts: boolean;
  criticalAlerts: boolean;
  dailySummary: boolean;
  weeklyReport: boolean;
  recipientEmail: string;
  recipientPhone: string;
}

export interface GeneralSettings {
  organisationName: string;
  timezone: string;
  dateFormat: string;
  currency: string;
  unitPrice: number;
  defaultRefreshSeconds: number;
  rowsPerPage: number;
}

/** Aggregated bucket used by the bar charts. */
export interface ConsumptionBucket {
  label: string;
  /** ISO timestamp for the start of the bucket. */
  at: string;
  kwh: number;
  avgCurrent: number;
}

export type DateRangeKey = 'today' | 'yesterday' | 'last24h' | 'last7d' | 'last30d' | 'custom';

export interface DateRange {
  key: DateRangeKey;
  from: string;
  to: string;
  label: string;
}

export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Session {
  user: User;
  loginAt: string;
}
