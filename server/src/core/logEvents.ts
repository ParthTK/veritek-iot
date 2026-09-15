/**
 * Canonical log event codes.
 *
 * Every meaningful step of the ingest pipeline emits one of these so that a
 * commissioning engineer can `grep` a single token and follow one packet from
 * the broker all the way to the telemetry table.
 */
export const LogEvent = {
  /* ---------------------------------------------------------------- mqtt -- */
  MQTT_CONNECTED: 'MQTT_CONNECTED',
  MQTT_DISCONNECTED: 'MQTT_DISCONNECTED',
  MQTT_RECONNECTED: 'MQTT_RECONNECTED',
  MQTT_SUBSCRIBED: 'MQTT_SUBSCRIBED',
  MQTT_PUBLISHED: 'MQTT_PUBLISHED',
  MQTT_ERROR: 'MQTT_ERROR',
  BROKER_STARTED: 'BROKER_STARTED',
  BROKER_CLIENT_CONNECTED: 'BROKER_CLIENT_CONNECTED',
  BROKER_CLIENT_DISCONNECTED: 'BROKER_CLIENT_DISCONNECTED',
  BROKER_AUTH_FAILED: 'BROKER_AUTH_FAILED',
  BROKER_ACL_DENIED: 'BROKER_ACL_DENIED',

  /* -------------------------------------------------------------- ingest -- */
  GATEWAY_MESSAGE_RECEIVED: 'GATEWAY_MESSAGE_RECEIVED',
  RAW_MESSAGE_STORED: 'RAW_MESSAGE_STORED',
  MESSAGE_PARSED: 'MESSAGE_PARSED',
  METER_IDENTIFIED: 'METER_IDENTIFIED',
  TELEMETRY_SAVED: 'TELEMETRY_SAVED',

  /* ------------------------------------------------------------ problems -- */
  UNKNOWN_GATEWAY: 'UNKNOWN_GATEWAY',
  UNKNOWN_SLAVE: 'UNKNOWN_SLAVE',
  UNKNOWN_REGISTER: 'UNKNOWN_REGISTER',
  UNKNOWN_SCHEMA: 'UNKNOWN_SCHEMA',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  DUPLICATE_PACKET: 'DUPLICATE_PACKET',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  AUTH_FAILED: 'AUTH_FAILED',

  /* -------------------------------------------------------------- health -- */
  DEVICE_STALE: 'DEVICE_STALE',
  DEVICE_OFFLINE: 'DEVICE_OFFLINE',
  DEVICE_RECOVERED: 'DEVICE_RECOVERED',
  BUFFERED_DATA_RECEIVED: 'BUFFERED_DATA_RECEIVED',
  CLOCK_SKEW_DETECTED: 'CLOCK_SKEW_DETECTED',

  /* -------------------------------------------------------------- energy -- */
  COUNTER_RESET_DETECTED: 'COUNTER_RESET_DETECTED',
  COUNTER_ROLLOVER_DETECTED: 'COUNTER_ROLLOVER_DETECTED',
  VALUE_SPIKE_DETECTED: 'VALUE_SPIKE_DETECTED',

  /* -------------------------------------------------------------- alerts -- */
  ALERT_OPENED: 'ALERT_OPENED',
  ALERT_CLOSED: 'ALERT_CLOSED',

  /* ------------------------------------------------------------ commands -- */
  COMMAND_QUEUED: 'COMMAND_QUEUED',
  COMMAND_SENT: 'COMMAND_SENT',
  COMMAND_ACKNOWLEDGED: 'COMMAND_ACKNOWLEDGED',
  COMMAND_BLOCKED: 'COMMAND_BLOCKED',

  /* ------------------------------------------------------------ lifecycle -- */
  SERVER_STARTED: 'SERVER_STARTED',
  SERVER_STOPPING: 'SERVER_STOPPING',
  DB_MIGRATED: 'DB_MIGRATED',
  AGGREGATION_RUN: 'AGGREGATION_RUN',
  SIMULATOR_PUBLISHED: 'SIMULATOR_PUBLISHED',
} as const;

export type LogEventCode = (typeof LogEvent)[keyof typeof LogEvent];
