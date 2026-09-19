import type {
  Alert,
  AlertSeverity,
  AlertStatus,
  ConnectionStatus,
  ConsumptionBucket,
  Device,
  DeviceThresholds,
  Meter,
  Reading,
  User,
} from '@/types';

/**
 * The live backend client.
 *
 * This file is the whole of the "real data" seam: it talks HTTP to the
 * ingestion backend and translates its vocabulary into the domain types the UI
 * already speaks. Components are untouched.
 *
 * The backend's model is deliberately more general than the dashboard's — it
 * has gateways with many Modbus meters, metric keys rather than fixed columns —
 * so the mapping below is the one place that knows, for example, that this UI
 * calls a gateway a "Device" and expects phase voltages as vrn/vyn/vbn.
 *
 * Served from the same origin in production, so VITE_API_BASE_URL is only
 * needed when running `npm run dev` against a remote backend.
 */

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const TOKEN_KEY = 'veritek.apiToken';

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing */
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 401) {
    setToken(null);
    throw new ApiError(401, 'Session expired. Please sign in again.');
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message =
      (body as { error?: { message?: string } } | null)?.error?.message ?? 'Request failed (' + response.status + ')';
    throw new ApiError(response.status, message);
  }
  return body as T;
}

/* ------------------------------------------------------------------- auth -- */

interface LoginResponse {
  token: string;
  user: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    role: User['role'];
    active: boolean;
    assignedSites: string[];
    lastLoginAt: string | null;
  };
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export async function apiLogin(email: string, password: string): Promise<User> {
  const body = await request<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  setToken(body.token);

  return {
    id: body.user.id,
    name: body.user.name,
    email: body.user.email,
    phone: body.user.phone ?? '',
    role: body.user.role,
    assignedSites: body.user.assignedSites ?? [],
    assignedDevices: [],
    active: body.user.active,
    lastLogin: body.user.lastLoginAt,
    avatarInitials: initials(body.user.name),
  };
}

export function apiLogout(): void {
  setToken(null);
}

/* ---------------------------------------------------------------- devices -- */

interface ApiGateway {
  id: string;
  gatewayUid: string;
  name: string;
  siteId: string | null;
  status: string;
  liveStatus?: string;
  enabled: boolean;
  connectionType: string | null;
  hardwareModel: string | null;
  firmwareVersion: string | null;
  lastSeenAt: string | null;
  lastDataAt: string | null;
  createdAt: string | null;
  notes: string | null;
  config?: Record<string, unknown> | null;
}

const DEFAULT_THRESHOLDS: DeviceThresholds = {
  voltageMin: 207,
  voltageMax: 253,
  currentMax: 100,
  powerMax: 100,
  energyMax: 100000,
  powerFactorMin: 0.85,
  frequencyMin: 49,
  frequencyMax: 51,
  warningPercent: 80,
  criticalPercent: 95,
  notificationsEnabled: true,
};

function mapStatus(status: string | undefined): ConnectionStatus {
  switch ((status ?? '').toUpperCase()) {
    case 'ONLINE':
      return 'online';
    case 'DEGRADED':
      return 'warning';
    default:
      // OFFLINE and UNKNOWN both mean "not reporting" to this UI.
      return 'offline';
  }
}

function mapCommunication(connectionType: string | null): Device['communicationMode'] {
  const value = (connectionType ?? '').toLowerCase();
  if (value.includes('4g') || value.includes('lte')) return '4G LTE';
  if (value.includes('2g') || value.includes('gprs')) return '2G GPRS';
  if (value.includes('eth')) return 'Ethernet';
  if (value.includes('wifi') || value.includes('wi-fi')) return 'Wi-Fi';
  if (value.includes('485')) return 'RS-485';
  return '4G LTE';
}

function readConfig(gateway: ApiGateway, key: string): string | null {
  const value = gateway.config?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function mapGateway(gateway: ApiGateway, meterCount: number): Device {
  return {
    id: gateway.id,
    deviceId: gateway.gatewayUid,
    name: gateway.name,
    serialNumber: readConfig(gateway, 'serialNumber') ?? gateway.gatewayUid,
    siteId: gateway.siteId ?? '',
    // Where the panel physically is, which is not the same thing as the
    // free-text notes field it used to fall back to.
    location: readConfig(gateway, 'location') ?? gateway.hardwareModel ?? gateway.notes ?? '',
    meterType: 'Energy Monitoring System (EMS)',
    communicationMode: mapCommunication(gateway.connectionType),
    readingInterval: 1,
    status: mapStatus(gateway.liveStatus ?? gateway.status),
    active: gateway.enabled,
    installationDate: gateway.createdAt ?? new Date().toISOString(),
    lastSeen: gateway.lastSeenAt ?? gateway.lastDataAt ?? '',
    modemCount: meterCount,
    assignedUserId: null,
    thresholds: DEFAULT_THRESHOLDS,
  };
}

interface ApiMeter {
  id: string;
  meterUid: string;
  meterName: string;
  gatewayId: string | null;
  siteId: string | null;
  slaveId: number | null;
  status: string;
  lastDataAt: string | null;
}

export function mapMeter(meter: ApiMeter, latest: Record<string, number> = {}): Meter {
  return {
    id: meter.id,
    deviceId: meter.gatewayId ?? '',
    name: meter.meterName,
    kwh: latest.energy_import_kwh ?? 0,
    kvah: latest.apparent_energy_kvah ?? 0,
    kvarh: latest.reactive_energy_kvarh ?? 0,
    lastReadingAt: meter.lastDataAt ?? '',
  };
}

export async function fetchDevicesAndMeters(): Promise<{ devices: Device[]; meters: Meter[] }> {
  const [gatewayResponse, meterResponse] = await Promise.all([
    request<{ gateways: ApiGateway[] }>('/api/gateways'),
    request<{ meters: ApiMeter[] }>('/api/meters'),
  ]);

  const meters = meterResponse.meters ?? [];
  const devices = (gatewayResponse.gateways ?? []).map((gateway) =>
    mapGateway(gateway, meters.filter((meter) => meter.gatewayId === gateway.id).length),
  );

  // Latest values give the meter cards their kWh / kVAh / kVArh figures.
  const withLatest = await Promise.all(
    meters.map(async (meter) => {
      try {
        const live = await request<{
          reading: { measurements?: Record<string, { value: number }> } | null;
        }>('/api/meters/' + meter.id + '/live');
        const measurements = live.reading?.measurements ?? {};
        const flattened = Object.fromEntries(
          Object.entries(measurements).map(([metric, entry]) => [metric, entry.value]),
        );
        return mapMeter(meter, flattened);
      } catch {
        return mapMeter(meter);
      }
    }),
  );

  return { devices, meters: withLatest };
}

/* --------------------------------------------------------------- readings -- */

interface HistoryPoint {
  t: string;
  values: Record<string, number>;
  consumption?: Record<string, number>;
}

interface HistoryResponse {
  points: HistoryPoint[];
  metrics: string[];
  interval: string;
}

/**
 * Metric keys the platform stores, mapped to the fixed columns this UI draws.
 *
 * Where a meter reports only a total (power factor, phase power) the total is
 * used for each phase rather than inventing a per-phase split.
 */
function pointToReading(meterId: string, deviceId: string, point: HistoryPoint): Reading {
  const v = point.values;
  const totalKw = v.active_power_kw ?? 0;
  const perPhaseKw = totalKw / 3;
  const pf = v.power_factor ?? 0;

  return {
    id: meterId + ':' + point.t,
    meterId,
    deviceId,
    timestamp: point.t,
    kwh: v.energy_import_kwh ?? 0,
    kvah: v.apparent_energy_kvah ?? 0,
    kvarh: v.reactive_energy_kvarh ?? 0,
    vrn: v.voltage_l1 ?? 0,
    vyn: v.voltage_l2 ?? 0,
    vbn: v.voltage_l3 ?? 0,
    vry: v.voltage_l12 ?? 0,
    vyb: v.voltage_l23 ?? 0,
    vbr: v.voltage_l31 ?? 0,
    ir: v.current_l1 ?? 0,
    iy: v.current_l2 ?? 0,
    ib: v.current_l3 ?? 0,
    kwR: v.active_power_l1_kw ?? perPhaseKw,
    kwY: v.active_power_l2_kw ?? perPhaseKw,
    kwB: v.active_power_l3_kw ?? perPhaseKw,
    pfR: v.power_factor_l1 ?? pf,
    pfY: v.power_factor_l2 ?? pf,
    pfB: v.power_factor_l3 ?? pf,
    frequency: v.frequency_hz ?? 0,
  };
}

const READING_METRICS = [
  'voltage_l1', 'voltage_l2', 'voltage_l3',
  'voltage_l12', 'voltage_l23', 'voltage_l31',
  'current_l1', 'current_l2', 'current_l3',
  'active_power_kw', 'active_power_l1_kw', 'active_power_l2_kw', 'active_power_l3_kw',
  'power_factor', 'power_factor_l1', 'power_factor_l2', 'power_factor_l3',
  'frequency_hz', 'energy_import_kwh', 'apparent_energy_kvah', 'reactive_energy_kvarh',
].join(',');

/** Recent history for one meter, newest first, as the charts and tables expect. */
export async function fetchReadings(
  meterId: string,
  deviceId: string,
  options: { from?: string; to?: string; interval?: string } = {},
): Promise<Reading[]> {
  const params = new URLSearchParams({
    from: options.from ?? '-24h',
    to: options.to ?? 'now',
    interval: options.interval ?? '1m',
    metrics: READING_METRICS,
  });
  const body = await request<HistoryResponse>('/api/meters/' + meterId + '/history?' + params.toString());
  return (body.points ?? [])
    .map((point) => pointToReading(meterId, deviceId, point))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

/**
 * Consumption buckets for the bar charts.
 *
 * `consumption` comes from the backend's own end-minus-start arithmetic, which
 * handles counter rollovers and meter resets - so the UI never has to subtract
 * cumulative kWh readings itself.
 */
export async function fetchBuckets(
  meterId: string,
  interval: '1h' | '1d',
  from: string,
  labelFor: (at: string) => string,
): Promise<ConsumptionBucket[]> {
  const params = new URLSearchParams({
    from,
    to: 'now',
    interval,
    metrics: 'energy_import_kwh,current_l1,current_l2,current_l3',
  });
  const body = await request<HistoryResponse>('/api/meters/' + meterId + '/history?' + params.toString());

  return (body.points ?? []).map((point) => {
    const currents = [point.values.current_l1, point.values.current_l2, point.values.current_l3]
      .filter((value): value is number => typeof value === 'number');
    return {
      label: labelFor(point.t),
      at: point.t,
      kwh: point.consumption?.energy_import_kwh ?? 0,
      avgCurrent: currents.length ? currents.reduce((total, value) => total + value, 0) / currents.length : 0,
    };
  });
}

/* ----------------------------------------------------------------- alerts -- */

interface ApiAlert {
  id: string;
  gatewayId: string | null;
  meterId: string | null;
  metric: string | null;
  severity: AlertSeverity;
  status: AlertStatus;
  message: string;
  value: number | null;
  threshold: number | null;
  unit: string | null;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export function mapAlert(alert: ApiAlert): Alert {
  return {
    id: alert.id,
    deviceId: alert.gatewayId ?? '',
    meterId: alert.meterId,
    timestamp: alert.openedAt,
    type: alert.metric ?? 'system',
    metric: alert.metric ?? '',
    message: alert.message,
    value: alert.value ?? 0,
    threshold: alert.threshold ?? 0,
    unit: alert.unit ?? '',
    severity: alert.severity,
    status: alert.status,
    acknowledgedAt: alert.acknowledgedAt,
    resolvedAt: alert.resolvedAt,
  };
}

export async function fetchAlerts(): Promise<Alert[]> {
  const body = await request<{ rows: ApiAlert[] }>('/api/alerts?limit=200');
  return (body.rows ?? []).map(mapAlert);
}

export async function updateAlertStatus(id: string, status: 'acknowledged' | 'resolved'): Promise<void> {
  await request('/api/alerts/' + id + '/' + (status === 'acknowledged' ? 'acknowledge' : 'resolve'), {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/* ------------------------------------------------------------ live stream -- */

/**
 * Subscribe to the backend's server-sent events.
 *
 * The same stream the commissioning screen uses: a reading is pushed the moment
 * it is stored, so the dashboard updates without polling.
 */
export function openTelemetryStream(onTelemetry: () => void): () => void {
  const token = getToken();
  if (!token) return () => undefined;

  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const connect = (): void => {
    if (closed) return;
    source = new EventSource(BASE + '/api/stream?access_token=' + encodeURIComponent(token));
    source.addEventListener('telemetry', onTelemetry);
    source.addEventListener('alert.opened', onTelemetry);
    source.addEventListener('alert.closed', onTelemetry);
    source.addEventListener('gateway.status', onTelemetry);
    source.onerror = () => {
      source?.close();
      source = null;
      // The browser closes an EventSource on network loss; reconnect the way
      // the rest of the system does rather than going quiet until a refresh.
      if (!closed) retry = setTimeout(connect, 5000);
    };
  };

  connect();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    source?.close();
  };
}

export function isLiveBackendConfigured(): boolean {
  return true;
}
