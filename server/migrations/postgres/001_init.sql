-- Vendor-neutral IoT energy platform schema (PostgreSQL / TimescaleDB).
--
-- Nothing in here encodes a Technode-specific key, topic or register address.
-- Everything hardware-specific lives in data: payload_profiles, meter_models,
-- modbus_register_maps and command_templates.

/* ----------------------------------------------------------------- sites -- */

CREATE TABLE IF NOT EXISTS sites (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  code          TEXT,
  city          TEXT,
  state         TEXT,
  address       TEXT,
  timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  tariff_per_kwh DOUBLE PRECISION,
  currency      TEXT DEFAULT 'INR',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
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
  last_seen_at       TIMESTAMPTZ,
  last_data_at       TIMESTAMPTZ,
  status             TEXT NOT NULL DEFAULT 'UNKNOWN',
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  auth_token_hash    TEXT,
  auth_token_lookup  TEXT,
  config             JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
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
  verified                    BOOLEAN NOT NULL DEFAULT FALSE,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
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
  scale            DOUBLE PRECISION NOT NULL DEFAULT 1,
  value_offset     DOUBLE PRECISION NOT NULL DEFAULT 0,
  unit             TEXT,
  writable         BOOLEAN NOT NULL DEFAULT FALSE,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  -- Alias used when the gateway already decodes the register and sends it by
  -- name; lets one map serve both raw-register and decoded-JSON payloads.
  source_key       TEXT,
  poll_interval_seconds INTEGER,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
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
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  status         TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_data_at   TIMESTAMPTZ,
  installed_at   TIMESTAMPTZ,
  config         JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
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
  min_valid     DOUBLE PRECISION,
  max_valid     DOUBLE PRECISION,
  sort_order    INTEGER NOT NULL DEFAULT 100
);

/* ------------------------------------------------------ payload profiles -- */

CREATE TABLE IF NOT EXISTS payload_profiles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  vendor     TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  priority   INTEGER NOT NULL DEFAULT 100,
  -- Set TRUE only after being checked against a real captured packet.
  verified   BOOLEAN NOT NULL DEFAULT FALSE,
  match_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  spec       JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
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
  received_at_server TIMESTAMPTZ NOT NULL,
  -- Parsed copy for querying. NULL when the bytes were not valid JSON.
  payload            JSONB,
  -- The bytes exactly as they arrived. Never rewritten, never discarded.
  payload_text       TEXT NOT NULL,
  payload_hash       TEXT NOT NULL,
  processed          BOOLEAN NOT NULL DEFAULT FALSE,
  processing_status  TEXT NOT NULL DEFAULT 'PENDING',
  processing_error   TEXT,
  processed_at       TIMESTAMPTZ,
  adapter            TEXT,
  profile_id         TEXT,
  sample_count       INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
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
  time               TIMESTAMPTZ NOT NULL,
  meter_id           TEXT NOT NULL,
  metric             TEXT NOT NULL,
  value              DOUBLE PRECISION NOT NULL,
  gateway_id         TEXT,
  site_id            TEXT,
  unit               TEXT,
  quality            TEXT NOT NULL DEFAULT 'GOOD',
  source_timestamp   TIMESTAMPTZ,
  server_received_at TIMESTAMPTZ NOT NULL,
  is_buffered        BOOLEAN NOT NULL DEFAULT FALSE,
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
  source_time    TIMESTAMPTZ,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count     INTEGER NOT NULL DEFAULT 1,
  raw_message_id TEXT
);

CREATE INDEX IF NOT EXISTS telemetry_fingerprints_seen_idx ON telemetry_fingerprints(first_seen_at DESC);

/* ------------------------------------------------------------- rollups -- */

CREATE TABLE IF NOT EXISTS telemetry_rollups (
  bucket       TEXT NOT NULL,
  meter_id     TEXT NOT NULL,
  metric       TEXT NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,
  bucket_end   TIMESTAMPTZ NOT NULL,
  site_id      TEXT,
  gateway_id   TEXT,
  sample_count INTEGER NOT NULL DEFAULT 0,
  sum_value    DOUBLE PRECISION,
  avg_value    DOUBLE PRECISION,
  min_value    DOUBLE PRECISION,
  max_value    DOUBLE PRECISION,
  first_value  DOUBLE PRECISION,
  last_value   DOUBLE PRECISION,
  first_time   TIMESTAMPTZ,
  last_time    TIMESTAMPTZ,
  -- For cumulative counters: last - first across the bucket, i.e. consumption.
  delta_value  DOUBLE PRECISION,
  unit         TEXT,
  quality      TEXT NOT NULL DEFAULT 'GOOD',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, meter_id, metric, bucket_start)
);

CREATE INDEX IF NOT EXISTS rollups_lookup_idx ON telemetry_rollups(meter_id, bucket, bucket_start DESC);
CREATE INDEX IF NOT EXISTS rollups_site_idx ON telemetry_rollups(site_id, bucket, bucket_start DESC);

-- Buckets touched by newly arrived data. Late/buffered readings mark old
-- buckets dirty, which is what keeps history correct after a replay.
CREATE TABLE IF NOT EXISTS rollup_dirty (
  bucket       TEXT NOT NULL,
  meter_id     TEXT NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,
  marked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, meter_id, bucket_start)
);

CREATE INDEX IF NOT EXISTS rollup_dirty_marked_idx ON rollup_dirty(marked_at);

/* ------------------------------------------------------ energy counters -- */

CREATE TABLE IF NOT EXISTS energy_counter_state (
  meter_id       TEXT NOT NULL,
  metric         TEXT NOT NULL,
  last_value     DOUBLE PRECISION,
  last_time      TIMESTAMPTZ,
  accumulated    DOUBLE PRECISION NOT NULL DEFAULT 0,
  reset_count    INTEGER NOT NULL DEFAULT 0,
  rollover_count INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (meter_id, metric)
);

CREATE TABLE IF NOT EXISTS energy_counter_events (
  id             TEXT PRIMARY KEY,
  meter_id       TEXT NOT NULL,
  metric         TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  previous_value DOUBLE PRECISION,
  new_value      DOUBLE PRECISION,
  delta_applied  DOUBLE PRECISION,
  source_time    TIMESTAMPTZ,
  detected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
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
  threshold        DOUBLE PRECISION,
  threshold_high   DOUBLE PRECISION,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  severity         TEXT NOT NULL DEFAULT 'warning',
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  cooldown_seconds INTEGER NOT NULL DEFAULT 300,
  notify           JSONB NOT NULL DEFAULT '{}'::jsonb,
  message_template TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
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
  value            DOUBLE PRECISION,
  threshold        DOUBLE PRECISION,
  unit             TEXT,
  opened_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ,
  acknowledged_at  TIMESTAMPTZ,
  acknowledged_by  TEXT,
  resolved_at      TIMESTAMPTZ,
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
  payload_template JSONB NOT NULL DEFAULT '{}'::jsonb,
  ack_match        JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  verified         BOOLEAN NOT NULL DEFAULT FALSE,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hardware_model, command_type)
);

CREATE TABLE IF NOT EXISTS device_commands (
  id              TEXT PRIMARY KEY,
  gateway_id      TEXT NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
  command_type    TEXT NOT NULL,
  template_id     TEXT,
  topic           TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id  TEXT,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  response        JSONB,
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  requested_by    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_commands_gateway_idx ON device_commands(gateway_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS device_commands_status_idx ON device_commands(status);

/* ---------------------------------------------------------------- health -- */

CREATE TABLE IF NOT EXISTS gateway_health (
  gateway_id             TEXT PRIMARY KEY REFERENCES gateways(id) ON DELETE CASCADE,
  packets_total          BIGINT NOT NULL DEFAULT 0,
  packets_ok             BIGINT NOT NULL DEFAULT 0,
  packets_malformed      BIGINT NOT NULL DEFAULT 0,
  packets_duplicate      BIGINT NOT NULL DEFAULT 0,
  packets_unknown_schema BIGINT NOT NULL DEFAULT 0,
  processing_failures    BIGINT NOT NULL DEFAULT 0,
  buffered_packets       BIGINT NOT NULL DEFAULT 0,
  last_packet_at         TIMESTAMPTZ,
  last_data_at           TIMESTAMPTZ,
  last_lag_seconds       DOUBLE PRECISION,
  max_lag_seconds        DOUBLE PRECISION,
  avg_lag_seconds        DOUBLE PRECISION,
  last_error             TEXT,
  last_error_at          TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* ----------------------------------------------------------------- users -- */

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  phone          TEXT,
  role           TEXT NOT NULL DEFAULT 'Viewer',
  password_hash  TEXT NOT NULL,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_sites JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT,
  actor_type  TEXT NOT NULL DEFAULT 'user',
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          TEXT
);

CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log(at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
