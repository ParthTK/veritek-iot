-- SQLite dialect of migrations/postgres/001_init.sql.
--
-- Generated from the Postgres schema so the two never drift: same table and
-- column names, SQLite storage classes. This driver exists so the whole ingest
-- path can be exercised with no database server installed; production runs the
-- Postgres/TimescaleDB files.

/* ----------------------------------------------------------------- sites -- */

CREATE TABLE IF NOT EXISTS sites (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  code          TEXT,
  city          TEXT,
  state         TEXT,
  address       TEXT,
  timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  tariff_per_kwh REAL,
  currency      TEXT DEFAULT 'INR',
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

/* -------------------------------------------------------------- gateways -- */

CREATE TABLE IF NOT EXISTS gateways (
  id                 TEXT PRIMARY KEY,
  gateway_uid        TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  site_id            TEXT REFERENCES sites(id) ON DELETE SET NULL,
  imei               TEXT,
  sim_number         TEXT,
  iccid              TEXT,
  mqtt_client_id     TEXT,
  mqtt_username      TEXT,
  hardware_model     TEXT,
  firmware_version   TEXT,
  connection_type    TEXT,
  -- Topic prefix this gateway is allowed to publish under (MQTT ACL, sec. 18).
  topic_namespace    TEXT,
  -- Last topic we actually saw it publish on; filled in at commissioning.
  observed_topic     TEXT,
  -- Which payload profile decodes this gateway's JSON. NULL = auto-detect.
  payload_profile_id TEXT,
  -- Offset assumed for RTC timestamps that carry no timezone marker.
  source_utc_offset  TEXT,
  last_seen_at       TEXT,
  last_data_at       TEXT,
  status             TEXT NOT NULL DEFAULT 'UNKNOWN',
  enabled            INTEGER NOT NULL DEFAULT 1,
  auth_token_hash    TEXT,
  auth_token_lookup  TEXT,
  config             TEXT NOT NULL DEFAULT '{}',
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS gateways_site_idx ON gateways(site_id);
CREATE INDEX IF NOT EXISTS gateways_status_idx ON gateways(status);
CREATE INDEX IF NOT EXISTS gateways_token_lookup_idx ON gateways(auth_token_lookup);

/* ---------------------------------------------------------- meter models -- */

CREATE TABLE IF NOT EXISTS meter_models (
  id                          TEXT PRIMARY KEY,
  manufacturer                TEXT NOT NULL,
  model                       TEXT NOT NULL,
  protocol                    TEXT NOT NULL DEFAULT 'MODBUS_RTU',
  default_baud_rate           INTEGER,
  default_parity              TEXT,
  default_stop_bits           INTEGER,
  default_data_bits           INTEGER,
  default_slave_id            INTEGER,
  default_poll_interval_seconds INTEGER,
  -- Set TRUE only once the register table has been checked against the meter
  -- manual. Everything shipped before hardware arrives is FALSE.
  verified                    INTEGER NOT NULL DEFAULT 0,
  notes                       TEXT,
  created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (manufacturer, model)
);

/* --------------------------------------------------- modbus register map -- */

CREATE TABLE IF NOT EXISTS modbus_register_maps (
  id               TEXT PRIMARY KEY,
  meter_model_id   TEXT NOT NULL REFERENCES meter_models(id) ON DELETE CASCADE,
  metric_key       TEXT NOT NULL,
  display_name     TEXT,
  slave_id         INTEGER,
  function_code    INTEGER NOT NULL DEFAULT 3,
  register_type    TEXT NOT NULL DEFAULT 'HOLDING',
  register_address INTEGER NOT NULL,
  register_length  INTEGER NOT NULL DEFAULT 2,
  datatype         TEXT NOT NULL,
  byte_order       TEXT NOT NULL DEFAULT 'big',
  word_order       TEXT NOT NULL DEFAULT 'big',
  bit_mask         INTEGER,
  bit_offset       INTEGER,
  scale            REAL NOT NULL DEFAULT 1,
  value_offset     REAL NOT NULL DEFAULT 0,
  unit             TEXT,
  writable         INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1,
  -- Alias used when the gateway already decodes the register and sends it by
  -- name; lets one map serve both raw-register and decoded-JSON payloads.
  source_key       TEXT,
  poll_interval_seconds INTEGER,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (meter_model_id, metric_key)
);

CREATE INDEX IF NOT EXISTS register_maps_model_idx ON modbus_register_maps(meter_model_id);
CREATE INDEX IF NOT EXISTS register_maps_address_idx ON modbus_register_maps(meter_model_id, register_address);
CREATE INDEX IF NOT EXISTS register_maps_source_key_idx ON modbus_register_maps(meter_model_id, source_key);

/* ---------------------------------------------------------------- meters -- */

CREATE TABLE IF NOT EXISTS meters (
  id             TEXT PRIMARY KEY,
  meter_uid      TEXT NOT NULL UNIQUE,
  site_id        TEXT REFERENCES sites(id) ON DELETE SET NULL,
  gateway_id     TEXT REFERENCES gateways(id) ON DELETE CASCADE,
  meter_model_id TEXT REFERENCES meter_models(id) ON DELETE SET NULL,
  meter_name     TEXT NOT NULL,
  location       TEXT,
  slave_id       INTEGER,
  baud_rate      INTEGER,
  parity         TEXT,
  stop_bits      INTEGER,
  data_bits      INTEGER,
  poll_interval_seconds INTEGER,
  enabled        INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_data_at   TEXT,
  installed_at   TEXT,
  config         TEXT NOT NULL DEFAULT '{}',
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One gateway serves many Modbus slaves; the slave id is unique per gateway.
CREATE UNIQUE INDEX IF NOT EXISTS meters_gateway_slave_idx
  ON meters(gateway_id, slave_id) WHERE slave_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS meters_site_idx ON meters(site_id);

/* --------------------------------------------------- metric definitions -- */

CREATE TABLE IF NOT EXISTS metric_definitions (
  metric_key    TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  unit          TEXT,
  category      TEXT,
  -- 'instant' values are averaged over a bucket; 'cumulative' counters are
  -- differenced (spec section 13: never sum a cumulative kWh register).
  kind          TEXT NOT NULL DEFAULT 'instant',
  aggregation   TEXT NOT NULL DEFAULT 'avg',
  decimals      INTEGER NOT NULL DEFAULT 2,
  min_valid     REAL,
  max_valid     REAL,
  sort_order    INTEGER NOT NULL DEFAULT 100
);

/* ------------------------------------------------------ payload profiles -- */

CREATE TABLE IF NOT EXISTS payload_profiles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  vendor     TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  enabled    INTEGER NOT NULL DEFAULT 1,
  priority   INTEGER NOT NULL DEFAULT 100,
  -- Set TRUE only after being checked against a real captured packet.
  verified   INTEGER NOT NULL DEFAULT 0,
  match_rules TEXT NOT NULL DEFAULT '{}',
  spec       TEXT NOT NULL DEFAULT '{}',
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Every distinct JSON path seen from a device, so commissioning can read the
-- real payload shape off the screen instead of guessing it.
CREATE TABLE IF NOT EXISTS payload_field_observations (
  id            TEXT PRIMARY KEY,
  gateway_uid   TEXT NOT NULL,
  topic         TEXT,
  json_path     TEXT NOT NULL,
  value_type    TEXT,
  sample_value  TEXT,
  occurrences   INTEGER NOT NULL DEFAULT 1,
  mapped_metric TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (gateway_uid, json_path)
);

/* ------------------------------------------------------- raw ingest log -- */

CREATE TABLE IF NOT EXISTS raw_iot_messages (
  id                 TEXT PRIMARY KEY,
  gateway_id         TEXT REFERENCES gateways(id) ON DELETE SET NULL,
  gateway_uid        TEXT,
  transport          TEXT NOT NULL,
  mqtt_topic         TEXT,
  mqtt_client_id     TEXT,
  source_ip          TEXT,
  content_type       TEXT,
  byte_size          INTEGER NOT NULL DEFAULT 0,
  received_at_server TEXT NOT NULL,
  -- Parsed copy for querying. NULL when the bytes were not valid JSON.
  payload            TEXT,
  -- The bytes exactly as they arrived. Never rewritten, never discarded.
  payload_text       TEXT NOT NULL,
  payload_hash       TEXT NOT NULL,
  processed          INTEGER NOT NULL DEFAULT 0,
  processing_status  TEXT NOT NULL DEFAULT 'PENDING',
  processing_error   TEXT,
  processed_at       TEXT,
  adapter            TEXT,
  profile_id         TEXT,
  sample_count       INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS raw_messages_received_idx ON raw_iot_messages(received_at_server DESC);
CREATE INDEX IF NOT EXISTS raw_messages_gateway_idx ON raw_iot_messages(gateway_uid, received_at_server DESC);
CREATE INDEX IF NOT EXISTS raw_messages_status_idx ON raw_iot_messages(processing_status, received_at_server DESC);
CREATE INDEX IF NOT EXISTS raw_messages_pending_idx ON raw_iot_messages(processed, received_at_server);
CREATE INDEX IF NOT EXISTS raw_messages_hash_idx ON raw_iot_messages(payload_hash);

/* -------------------------------------------------------------- telemetry -- */

CREATE TABLE IF NOT EXISTS telemetry (
  -- Authoritative measurement time: the gateway's own timestamp when it sent
  -- one, otherwise server receipt. Charts and rollups key off this column, so
  -- buffered readings land at the minute they were measured (spec section 9).
  time               TEXT NOT NULL,
  meter_id           TEXT NOT NULL,
  metric             TEXT NOT NULL,
  value              REAL NOT NULL,
  gateway_id         TEXT,
  site_id            TEXT,
  unit               TEXT,
  quality            TEXT NOT NULL DEFAULT 'GOOD',
  source_timestamp   TEXT,
  server_received_at TEXT NOT NULL,
  is_buffered        INTEGER NOT NULL DEFAULT 0,
  raw_message_id     TEXT,
  fingerprint        TEXT,
  PRIMARY KEY (meter_id, metric, time)
);

CREATE INDEX IF NOT EXISTS telemetry_meter_time_idx ON telemetry(meter_id, time DESC);
CREATE INDEX IF NOT EXISTS telemetry_site_time_idx ON telemetry(site_id, time DESC);
CREATE INDEX IF NOT EXISTS telemetry_gateway_time_idx ON telemetry(gateway_id, time DESC);
CREATE INDEX IF NOT EXISTS telemetry_time_idx ON telemetry(time DESC);

-- Packet-level idempotency: the same buffered packet replayed after a cellular
-- outage collapses onto the row that already exists.
CREATE TABLE IF NOT EXISTS telemetry_fingerprints (
  fingerprint    TEXT PRIMARY KEY,
  gateway_uid    TEXT NOT NULL,
  meter_id       TEXT,
  slave_id       INTEGER,
  source_time    TEXT,
  first_seen_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  seen_count     INTEGER NOT NULL DEFAULT 1,
  raw_message_id TEXT
);

CREATE INDEX IF NOT EXISTS telemetry_fingerprints_seen_idx ON telemetry_fingerprints(first_seen_at DESC);

/* ------------------------------------------------------------- rollups -- */

CREATE TABLE IF NOT EXISTS telemetry_rollups (
  bucket       TEXT NOT NULL,
  meter_id     TEXT NOT NULL,
  metric       TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  bucket_end   TEXT NOT NULL,
  site_id      TEXT,
  gateway_id   TEXT,
  sample_count INTEGER NOT NULL DEFAULT 0,
  sum_value    REAL,
  avg_value    REAL,
  min_value    REAL,
  max_value    REAL,
  first_value  REAL,
  last_value   REAL,
  first_time   TEXT,
  last_time    TEXT,
  -- For cumulative counters: last - first across the bucket, i.e. consumption.
  delta_value  REAL,
  unit         TEXT,
  quality      TEXT NOT NULL DEFAULT 'GOOD',
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (bucket, meter_id, metric, bucket_start)
);

CREATE INDEX IF NOT EXISTS rollups_lookup_idx ON telemetry_rollups(meter_id, bucket, bucket_start DESC);
CREATE INDEX IF NOT EXISTS rollups_site_idx ON telemetry_rollups(site_id, bucket, bucket_start DESC);

-- Buckets touched by newly arrived data. Late/buffered readings mark old
-- buckets dirty, which is what keeps history correct after a replay.
CREATE TABLE IF NOT EXISTS rollup_dirty (
  bucket       TEXT NOT NULL,
  meter_id     TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  marked_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (bucket, meter_id, bucket_start)
);

CREATE INDEX IF NOT EXISTS rollup_dirty_marked_idx ON rollup_dirty(marked_at);

/* ------------------------------------------------------ energy counters -- */

CREATE TABLE IF NOT EXISTS energy_counter_state (
  meter_id       TEXT NOT NULL,
  metric         TEXT NOT NULL,
  last_value     REAL,
  last_time      TEXT,
  accumulated    REAL NOT NULL DEFAULT 0,
  reset_count    INTEGER NOT NULL DEFAULT 0,
  rollover_count INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (meter_id, metric)
);

CREATE TABLE IF NOT EXISTS energy_counter_events (
  id             TEXT PRIMARY KEY,
  meter_id       TEXT NOT NULL,
  metric         TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  previous_value REAL,
  new_value      REAL,
  delta_applied  REAL,
  source_time    TEXT,
  detected_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note           TEXT
);

CREATE INDEX IF NOT EXISTS counter_events_meter_idx ON energy_counter_events(meter_id, detected_at DESC);

/* ---------------------------------------------------------------- alerts -- */

CREATE TABLE IF NOT EXISTS alert_rules (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  scope            TEXT NOT NULL DEFAULT 'meter',
  site_id          TEXT,
  gateway_id       TEXT,
  meter_id         TEXT,
  metric           TEXT,
  condition        TEXT NOT NULL,
  threshold        REAL,
  threshold_high   REAL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  severity         TEXT NOT NULL DEFAULT 'warning',
  enabled          INTEGER NOT NULL DEFAULT 1,
  cooldown_seconds INTEGER NOT NULL DEFAULT 300,
  notify           TEXT NOT NULL DEFAULT '{}',
  message_template TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS alert_rules_metric_idx ON alert_rules(metric, enabled);

CREATE TABLE IF NOT EXISTS alert_events (
  id               TEXT PRIMARY KEY,
  rule_id          TEXT REFERENCES alert_rules(id) ON DELETE SET NULL,
  site_id          TEXT,
  gateway_id       TEXT,
  meter_id         TEXT,
  metric           TEXT,
  severity         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  message          TEXT NOT NULL,
  value            REAL,
  threshold        REAL,
  unit             TEXT,
  opened_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at     TEXT,
  acknowledged_at  TEXT,
  acknowledged_by  TEXT,
  resolved_at      TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS alert_events_status_idx ON alert_events(status, opened_at DESC);
CREATE INDEX IF NOT EXISTS alert_events_meter_idx ON alert_events(meter_id, opened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS alert_events_open_unique
  ON alert_events(rule_id, meter_id, metric) WHERE status = 'active';

/* -------------------------------------------------------------- commands -- */

-- The exact remote-configuration syntax is not published by the manufacturer.
-- Commands are therefore built from templates loaded as data; with no verified
-- template the command service refuses to transmit rather than inventing one.
CREATE TABLE IF NOT EXISTS command_templates (
  id               TEXT PRIMARY KEY,
  hardware_model   TEXT NOT NULL,
  command_type     TEXT NOT NULL,
  description      TEXT,
  topic_template   TEXT,
  payload_template TEXT NOT NULL DEFAULT '{}',
  ack_match        TEXT NOT NULL DEFAULT '{}',
  enabled          INTEGER NOT NULL DEFAULT 0,
  verified         INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (hardware_model, command_type)
);

CREATE TABLE IF NOT EXISTS device_commands (
  id              TEXT PRIMARY KEY,
  gateway_id      TEXT NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
  command_type    TEXT NOT NULL,
  template_id     TEXT,
  topic           TEXT,
  payload         TEXT NOT NULL DEFAULT '{}',
  correlation_id  TEXT,
  requested_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at         TEXT,
  acknowledged_at TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  response        TEXT,
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  requested_by    TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS device_commands_gateway_idx ON device_commands(gateway_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS device_commands_status_idx ON device_commands(status);

/* ---------------------------------------------------------------- health -- */

CREATE TABLE IF NOT EXISTS gateway_health (
  gateway_id             TEXT PRIMARY KEY REFERENCES gateways(id) ON DELETE CASCADE,
  packets_total          INTEGER NOT NULL DEFAULT 0,
  packets_ok             INTEGER NOT NULL DEFAULT 0,
  packets_malformed      INTEGER NOT NULL DEFAULT 0,
  packets_duplicate      INTEGER NOT NULL DEFAULT 0,
  packets_unknown_schema INTEGER NOT NULL DEFAULT 0,
  processing_failures    INTEGER NOT NULL DEFAULT 0,
  buffered_packets       INTEGER NOT NULL DEFAULT 0,
  last_packet_at         TEXT,
  last_data_at           TEXT,
  last_lag_seconds       REAL,
  max_lag_seconds        REAL,
  avg_lag_seconds        REAL,
  last_error             TEXT,
  last_error_at          TEXT,
  updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

/* ----------------------------------------------------------------- users -- */

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  phone          TEXT,
  role           TEXT NOT NULL DEFAULT 'Viewer',
  password_hash  TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  assigned_sites TEXT NOT NULL DEFAULT '[]',
  last_login_at  TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor       TEXT,
  actor_type  TEXT NOT NULL DEFAULT 'user',
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  detail      TEXT NOT NULL DEFAULT '{}',
  ip          TEXT
);

CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log(at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
