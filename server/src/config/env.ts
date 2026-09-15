import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ quiet: true });

/* ------------------------------------------------------------- coercions -- */

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      return /^(1|true|yes|on)$/i.test(value.trim());
    });

const int = (fallback: number, min?: number, max?: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      let result = Math.trunc(parsed);
      if (min !== undefined) result = Math.max(min, result);
      if (max !== undefined) result = Math.min(max, result);
      return result;
    });

const str = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : value));

const optionalStr = () =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? undefined : value));

const csv = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      return value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    });

/* ----------------------------------------------------------------- schema -- */

const schema = z.object({
  /* runtime */
  NODE_ENV: str('development'),
  PORT: int(4000, 1, 65535),
  HOST: str('0.0.0.0'),
  LOG_LEVEL: str('info'),
  LOG_PRETTY: bool(true),
  PUBLIC_BASE_URL: str('http://localhost:4000'),
  CORS_ORIGINS: csv(['http://localhost:5173', 'http://127.0.0.1:5173']),

  /* ---------------------------------------------------------- database -- */
  // 'auto' picks postgres when DATABASE_URL is set, otherwise the embedded
  // SQLite file so the stack boots with no infrastructure at all.
  DB_DRIVER: str('auto'),
  DATABASE_URL: optionalStr(),
  DATABASE_SSL: bool(false),
  DATABASE_POOL_MAX: int(10, 1, 100),
  SQLITE_PATH: str('./data/veritek-iot.db'),
  /** Create Timescale hypertables when the extension is present. */
  TIMESCALE_ENABLED: bool(true),
  DB_AUTO_MIGRATE: bool(true),

  /* -------------------------------------------------------------- mqtt -- */
  // Every one of these is a placeholder until the Technode unit is on the
  // bench. Nothing about the topic tree or payload shape is compiled in.
  MQTT_ENABLED: bool(true),
  MQTT_HOST: str('127.0.0.1'),
  MQTT_PORT: int(1883, 1, 65535),
  /** mqtt | mqtts | ws | wss - set by MQTT_TLS unless given explicitly. */
  MQTT_PROTOCOL: optionalStr(),
  MQTT_USERNAME: optionalStr(),
  MQTT_PASSWORD: optionalStr(),
  MQTT_CLIENT_ID: str('veritek-backend'),
  /** Topic the backend publishes telemetry echoes / test packets to. */
  MQTT_TELEMETRY_TOPIC: str('technode/+/telemetry'),
  /** Topic template for outbound remote-configuration commands. */
  MQTT_COMMAND_TOPIC: str('technode/{gatewayUid}/command'),
  /** Topic the gateway is expected to publish connection state on. */
  MQTT_STATUS_TOPIC: str('technode/{gatewayUid}/status'),
  MQTT_TLS: bool(false),
  MQTT_TLS_CA_PATH: optionalStr(),
  MQTT_TLS_CERT_PATH: optionalStr(),
  MQTT_TLS_KEY_PATH: optionalStr(),
  MQTT_TLS_REJECT_UNAUTHORIZED: bool(true),
  MQTT_QOS: int(1, 0, 2),
  MQTT_RETAIN: bool(false),
  /** 4 = MQTT 3.1.1, 5 = MQTT 5.0. Unknown for this unit until it connects. */
  MQTT_PROTOCOL_VERSION: int(4, 3, 5),
  MQTT_CLEAN_SESSION: bool(true),
  MQTT_KEEPALIVE_SECONDS: int(60, 0, 65535),
  MQTT_RECONNECT_PERIOD_MS: int(5000, 500, 300000),
  MQTT_CONNECT_TIMEOUT_MS: int(30000, 1000, 300000),
  /**
   * Commissioning default is deliberately broad - the real topic is unknown, so
   * we listen to the whole vendor namespace, discover the actual topic from the
   * first packet, then narrow this to the device-specific topic.
   */
  MQTT_SUBSCRIBE_TOPICS: csv(['technode/#']),
  MQTT_LWT_TOPIC: optionalStr(),
  MQTT_LWT_PAYLOAD: str('{"status":"offline"}'),
  MQTT_LWT_QOS: int(1, 0, 2),
  MQTT_LWT_RETAIN: bool(true),

  /* ---------------------------------------------- embedded dev broker -- */
  // Lets the whole path be exercised without Mosquitto/EMQX installed. Turn it
  // off in production and point MQTT_HOST at the real broker.
  EMBEDDED_BROKER_ENABLED: bool(true),
  EMBEDDED_BROKER_PORT: int(1883, 1, 65535),
  EMBEDDED_BROKER_WS_PORT: int(0, 0, 65535),
  /** Off by default: section 18 forbids an anonymous public topic tree. */
  EMBEDDED_BROKER_ALLOW_ANONYMOUS: bool(false),
  /** Shared credentials used by the simulator and by gateways with no row yet. */
  EMBEDDED_BROKER_DEFAULT_USERNAME: str('veritek-gateway'),
  EMBEDDED_BROKER_DEFAULT_PASSWORD: optionalStr(),

  /* ------------------------------------------------------------ ingest -- */
  INGEST_MAX_PAYLOAD_BYTES: int(262144, 512, 16 * 1024 * 1024),
  INGEST_RATE_LIMIT_PER_MINUTE: int(600, 1, 100000),
  INGEST_QUEUE_MAX: int(10000, 10, 1000000),
  INGEST_WORKERS: int(2, 1, 32),
  /** Raw packets are retained for forensic replay; 0 disables pruning. */
  RAW_RETENTION_DAYS: int(30, 0, 3650),
  /**
   * Create a gateway/meter row on first sight of an unknown id. Handy during
   * commissioning, should be turned off once the estate is known.
   */
  AUTO_PROVISION_GATEWAYS: bool(true),
  AUTO_PROVISION_METERS: bool(true),
  /** Require a device token on the HTTP ingest endpoint. */
  INGEST_REQUIRE_AUTH: bool(false),

  /* ---------------------------------------------------------- time -- */
  DEFAULT_SITE_TIMEZONE: str('Asia/Kolkata'),
  /**
   * Applied when a device timestamp carries no offset. The Technode unit has an
   * RTC; whether it stamps UTC or local time is unknown until we see a packet.
   */
  DEFAULT_SOURCE_UTC_OFFSET: str('+05:30'),
  /** Lag beyond which a reading is treated as replayed from the gateway buffer. */
  BUFFERED_THRESHOLD_SECONDS: int(120, 1, 86400),
  /** Source timestamps further in the past than this are rejected as bogus. */
  MAX_PAST_SKEW_SECONDS: int(60 * 60 * 24 * 30, 60, 60 * 60 * 24 * 365),
  /** Source timestamps further in the future than this fall back to server time. */
  MAX_FUTURE_SKEW_SECONDS: int(300, 0, 86400),

  /* ---------------------------------------------------------- health -- */
  GATEWAY_STALE_AFTER_SECONDS: int(300, 10, 86400),
  GATEWAY_OFFLINE_AFTER_SECONDS: int(900, 10, 604800),
  METER_STALE_AFTER_SECONDS: int(900, 10, 604800),
  HEALTH_SCAN_INTERVAL_SECONDS: int(30, 5, 3600),

  /* ----------------------------------------------------- aggregation -- */
  AGGREGATION_ENABLED: bool(true),
  AGGREGATION_INTERVAL_SECONDS: int(20, 5, 3600),
  AGGREGATION_BATCH: int(500, 10, 20000),

  /* ---------------------------------------------------------- energy -- */
  /** Guard rails for cumulative-counter sanity checks (spec section 13). */
  ENERGY_MAX_DELTA_PER_HOUR: int(100000, 1, 100000000),
  ENERGY_COUNTER_ROLLOVER_VALUES: csv(['999999.9', '999999', '4294967295', '99999999']),
  ENERGY_BACKWARD_TOLERANCE: str('0.001'),

  /* ---------------------------------------------------------- alerts -- */
  ALERTS_ENABLED: bool(true),

  /* -------------------------------------------------------- commands -- */
  /**
   * Remote configuration stays disarmed until Technode's exact command syntax
   * is known and loaded as a command template (spec section 17).
   */
  COMMANDS_ENABLED: bool(false),
  COMMAND_TIMEOUT_SECONDS: int(120, 5, 86400),

  /* ------------------------------------------------------------ auth -- */
  AUTH_ENABLED: bool(true),
  JWT_SECRET: str('dev-only-change-me'),
  JWT_TTL_SECONDS: int(43200, 60, 2592000),
  /** HMAC pepper for device-token lookup keys. */
  TOKEN_PEPPER: str('dev-only-change-me'),
  API_RATE_LIMIT_PER_MINUTE: int(600, 10, 100000),
  SEED_ADMIN_EMAIL: str('admin@veritek.com'),
  SEED_ADMIN_PASSWORD: str('Pass@123'),

  /* ------------------------------------------------------- simulator -- */
  SIMULATOR_ENABLED: bool(false),
  SIMULATOR_GATEWAY_UID: str('TEST-GW-001'),
  SIMULATOR_SLAVE_IDS: csv(['1', '2']),
  SIMULATOR_INTERVAL_SECONDS: int(15, 1, 3600),
  SIMULATOR_JITTER_SECONDS: int(5, 0, 600),
  SIMULATOR_TOPIC: str('technode/{gatewayUid}/telemetry'),
  SIMULATOR_TRANSPORT: str('mqtt'),
  SIMULATOR_DEVICE_TOKEN: optionalStr(),
});

export type Env = z.infer<typeof schema>;

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Never dump process.env here - it is full of credentials.
  const issues = parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('\n  ');
  throw new Error('Invalid environment configuration:\n  ' + issues);
}

export const env: Env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Resolved MQTT scheme, honouring MQTT_TLS unless MQTT_PROTOCOL says otherwise. */
export function mqttProtocol(): 'mqtt' | 'mqtts' | 'ws' | 'wss' {
  const explicit = env.MQTT_PROTOCOL?.toLowerCase();
  if (explicit === 'mqtt' || explicit === 'mqtts' || explicit === 'ws' || explicit === 'wss') {
    return explicit;
  }
  return env.MQTT_TLS ? 'mqtts' : 'mqtt';
}

/** Broker URL with the password removed - safe to log. */
export function mqttDisplayUrl(): string {
  return mqttProtocol() + '://' + env.MQTT_HOST + ':' + env.MQTT_PORT;
}

/** Warn loudly about defaults that must not survive into production. */
export function productionConfigWarnings(): string[] {
  const warnings: string[] = [];
  if (!isProduction) return warnings;
  if (env.JWT_SECRET === 'dev-only-change-me') warnings.push('JWT_SECRET is still the development default.');
  if (env.TOKEN_PEPPER === 'dev-only-change-me') warnings.push('TOKEN_PEPPER is still the development default.');
  if (env.EMBEDDED_BROKER_ENABLED) warnings.push('EMBEDDED_BROKER_ENABLED is on; use a managed broker in production.');
  if (env.EMBEDDED_BROKER_ALLOW_ANONYMOUS) warnings.push('Anonymous MQTT access is enabled.');
  if (!env.MQTT_TLS) warnings.push('MQTT_TLS is off; telemetry and credentials cross the network in clear text.');
  if (!env.INGEST_REQUIRE_AUTH) warnings.push('INGEST_REQUIRE_AUTH is off; the HTTP ingest endpoint is unauthenticated.');
  if (env.AUTO_PROVISION_GATEWAYS) warnings.push('AUTO_PROVISION_GATEWAYS is on; unknown devices will create their own records.');
  return warnings;
}
