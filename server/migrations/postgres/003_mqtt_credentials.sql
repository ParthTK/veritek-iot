-- Production MQTT identity: per-device credentials, ACLs and device lifecycle.
--
-- The broker (EMQX) does not hold a static password/ACL file. It calls this
-- backend over HTTP on every CONNECT and, when it needs to, on PUBLISH and
-- SUBSCRIBE. That is what makes provisioning a new site a database row instead
-- of an edit-and-reload of broker config, and what makes a revocation take
-- effect immediately across the whole estate.

/* -------------------------------------------------- device credentials -- */

CREATE TABLE IF NOT EXISTS mqtt_credentials (
  id                TEXT PRIMARY KEY,
  -- NULL for service accounts, which belong to the platform, not a device.
  gateway_id        TEXT REFERENCES gateways(id) ON DELETE CASCADE,
  gateway_uid       TEXT,
  mqtt_username     TEXT NOT NULL UNIQUE,
  -- scrypt$salt$hash. The plaintext is shown once at issue and never stored.
  password_hash     TEXT NOT NULL,
  -- 'device' = one physical gateway. 'service' = the backend's own ingestion
  -- account, which must never be a gateway's credential (spec section 9).
  kind              TEXT NOT NULL DEFAULT 'device',
  -- active | suspended | revoked. Anything but active is refused at CONNECT.
  status            TEXT NOT NULL DEFAULT 'active',
  -- Topic permissions, as {"publish": [...], "subscribe": [...]}. Templated
  -- with {gatewayId}. Stored rather than derived so an unusual gateway can be
  -- granted an exception without a code change.
  acl               JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Optional pin: the client id the device must present, so a stolen password
  -- cannot be replayed from somewhere else at the same time.
  client_id_pattern TEXT,
  last_auth_at      TIMESTAMPTZ,
  last_auth_ip      TEXT,
  auth_success_count BIGINT NOT NULL DEFAULT 0,
  auth_failure_count BIGINT NOT NULL DEFAULT 0,
  acl_denial_count   BIGINT NOT NULL DEFAULT 0,
  last_rotated_at   TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  revoked_reason    TEXT,
  created_by        TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mqtt_credentials_gateway_idx ON mqtt_credentials(gateway_id);
CREATE INDEX IF NOT EXISTS mqtt_credentials_status_idx ON mqtt_credentials(status);

/* ----------------------------------------------------- device lifecycle -- */

-- provisioned -> active -> (suspended) -> revoked | decommissioned
-- A decommissioned or revoked gateway loses broker access immediately; its
-- historical telemetry is never touched.
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'provisioned';
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS commissioned_at TIMESTAMPTZ;
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS decommissioned_at TIMESTAMPTZ;
-- Set when a failed unit is swapped: the replacement inherits the site and
-- meters, the old record and its telemetry stay for history.
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS replaced_by_gateway_id TEXT;
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'production';

CREATE INDEX IF NOT EXISTS gateways_lifecycle_idx ON gateways(lifecycle_state);

/* --------------------------------------------------- broker audit trail -- */

-- Every CONNECT and every ACL denial. This is the evidence for the security
-- tests in spec section 29, and the first place to look when a device in the
-- field cannot connect.
CREATE TABLE IF NOT EXISTS mqtt_auth_events (
  id            TEXT PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- connect | acl_publish | acl_subscribe
  event_type    TEXT NOT NULL,
  mqtt_username TEXT,
  client_id     TEXT,
  gateway_id    TEXT,
  gateway_uid   TEXT,
  topic         TEXT,
  peer_ip       TEXT,
  allowed       BOOLEAN NOT NULL,
  reason        TEXT
);

CREATE INDEX IF NOT EXISTS mqtt_auth_events_at_idx ON mqtt_auth_events(at DESC);
CREATE INDEX IF NOT EXISTS mqtt_auth_events_denied_idx ON mqtt_auth_events(allowed, at DESC);
CREATE INDEX IF NOT EXISTS mqtt_auth_events_username_idx ON mqtt_auth_events(mqtt_username, at DESC);
