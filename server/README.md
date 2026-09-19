# VERITEK IoT backend

Ingestion, normalisation, storage and APIs for energy meters behind an IoT
gateway. First target is the Veritek RS485/Modbus-RTU cellular gateway, but
nothing vendor-specific is compiled in.

**Status: runs today, with no hardware and no infrastructure.** `npm install`
then `npm run dev` brings up an MQTT broker, a database, the ingest pipeline,
the APIs and a commissioning screen. `npm run verify:e2e` drives the whole path
and prints a pass/fail report.

---

## The one thing to understand

The manufacturer confirms JSON over MQTT/HTTP, Modbus RTU polling of several
RS485 slaves, an RTC, offline buffering, and remote configuration by MQTT. It
does **not** publish the production JSON schema, the topic format or the command
syntax. Nor do we have the energy meter's Modbus register table yet.

So none of those live in the source. They live in database rows:

| Unknown | Where it goes | Until then |
|---|---|---|
| the vendor's JSON schema | `payload_profiles` row | tolerant discovery parser, flagged `UNKNOWN_SCHEMA` |
| MQTT topic | `MQTT_SUBSCRIBE_TOPICS` | subscribed to `veritek/#` |
| Meter register table | `modbus_register_maps` rows | empty map; pre-decoded values still flow |
| Slave id / baud / parity / stop bits | `meters` row | left null, not guessed |
| Command syntax | `command_templates` row | commands recorded as `BLOCKED`, never transmitted |
| MQTT auth / TLS support | `MQTT_*` env | plain MQTT with per-gateway credentials |

Filling any of them in is data entry plus a replay of stored packets. No code
change, no redeploy.

---

## Quick start

```bash
cd server
npm install
cp .env.example .env      # works unedited
npm run dev
```

That gives you, on one process:

- an MQTT broker on `:1883` (embedded; authenticated, ACL-enforced)
- a database (embedded SQLite; set `DATABASE_URL` for Postgres/TimescaleDB)
- the MQTT consumer, subscribed to `veritek/#`
- HTTP ingest at `POST /api/iot/veritek/ingest`
- the dashboard APIs on `:4000`
- the commissioning screen at <http://localhost:4000/commissioning>

Sign in with `admin@veritek.com` / `Pass@123` (from `SEED_ADMIN_*`).

Then, in a second shell, publish synthetic meter data:

```bash
npm run simulator
```

### Prove the whole path

```bash
npm run verify:e2e
```

Runs 38 checks end to end — MQTT and HTTP ingestion, raw storage, normalisation,
buffered replay, duplicate rejection, energy arithmetic, rollups, every API, the
live stream, and that remote configuration stays disarmed. It uses its own
database file and ports, so it is safe to run alongside a dev server.

```bash
npm test          # unit tests: Modbus decoding, energy maths, time, adapter
npm run typecheck
```

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | The backend, with reload |
| `npm start` | Production (after `npm run build`) |
| `npm run migrate` | Apply migrations only |
| `npm run seed` | Baseline data (idempotent; `-- --with-token` also issues a device token) |
| `npm run simulator` | Publish synthetic meter data |
| `npm run simulator -- --buffer-test --outage 60` | Simulate a cellular outage and a buffer flush |
| `npm run simulator -- --replay 10 --duplicate` | Back-fill 10 minutes of history, sent twice |
| `npm run simulator -- --transport http` | Same data through the HTTP endpoint |
| `npm run sniffer` | **Raw MQTT logger — run this first tomorrow** |
| `npm run broker` | The embedded broker alone, so restarts do not drop devices |
| `npm run verify:e2e` | Full end-to-end verification |

---

## Tomorrow: bringing up the real gateway

### Step 0 — capture, do not configure

Before touching the dashboard:

```bash
npm run sniffer
```

It prints, per packet: topic, exact bytes, receive time, QoS/retain, and the
interval since the last message on that topic. The backend stores the same
packets in `raw_iot_messages` regardless, so nothing is lost either way.

What you need from this: **the topic**, **one complete raw payload**, and the
**gateway/client id**. With those plus the meter's register table, the mapping
is mechanical.

### Step 1 — point the gateway at the broker

Gateway side: broker host/IP, port, client id, username/password, publish topic.
Backend side: `.env` — `MQTT_HOST`, `MQTT_PORT`, credentials.

Issue a per-gateway credential rather than sharing one:

```bash
curl -X POST http://localhost:4000/api/admin/gateways/<gatewayId>/token \
  -H "Authorization: Bearer $TOKEN"
```

The token is shown once; only its scrypt hash is stored. Use it as the MQTT
password (username = gateway uid) or the HTTP ingest bearer token.

### Step 2 — watch it arrive

Open <http://localhost:4000/commissioning>. The moment the gateway publishes:

- **Observed MQTT topics** shows the real topic
- **Latest raw packets** shows the payload byte-for-byte
- the gateway auto-registers (`AUTO_PROVISION_GATEWAYS=true`)
- **Payload fields not mapped to a metric** lists every JSON key the device
  actually sends, with its type, a sample value, and a suggested metric where
  the name is recognisable

The packet will be flagged `UNKNOWN_SCHEMA`. That is correct — it means no
verified mapping exists yet, not that anything is broken.

### Step 3 — map the payload

Get a draft built from what the device has actually sent:

```
GET /api/commissioning/suggest-profile?gatewayUid=<uid>
```

Check it against a real packet without storing anything:

```
POST /api/commissioning/test-parse
{ "payload": { ...the captured packet... }, "topic": "..." }
```

Iterate until the packets it returns have the right gateway id, slave id,
timestamp and measurements. Then save it:

```
POST /api/admin/payload-profiles
{ "name": "veritek_schema_v1", "vendor": "veritek", "enabled": true,
  "verified": true, "matchRules": {...}, "spec": {...} }
```

Replay the packets you already captured:

```
POST /api/commissioning/raw/<rawMessageId>/replay
```

They should now come back `OK`.

### Step 4 — the meter register table

From the meter's manual, create the model and its registers:

```
POST /api/admin/meter-models
POST /api/admin/registers/bulk      # see docs/register-map.template.json
```

Then assign the model and the real serial settings to each meter
(`POST /api/admin/meters`: `slaveId`, `baudRate`, `parity`, `stopBits`).

Register-map fields that matter:

- `datatype` — `FLOAT32`, `UINT32`, `INT16`, …
- `byteOrder` / `wordOrder` — the four layouts are `big/big` (ABCD, the default),
  `big/little` (CDAB, word-swapped, very common on energy meters), `little/big`
  (BADC), `little/little` (DCBA). **If decoded values are the right order of
  magnitude but wrong, flip `wordOrder` first.**
- `scale` / `valueOffset` — `value = raw * scale + offset`. Watts to kW is
  `scale: 0.001`.
- `sourceKey` — the vendor's JSON key, for when the *gateway* decodes the
  register and sends it by name rather than sending raw words.

### Step 5 — lock it down

```
MQTT_SUBSCRIBE_TOPICS=veritek/<the real topic>
AUTO_PROVISION_GATEWAYS=false
AUTO_PROVISION_METERS=false
INGEST_REQUIRE_AUTH=true
MQTT_TLS=true                      # once the unit's TLS support is confirmed
EMBEDDED_BROKER_ENABLED=false      # use Mosquitto/EMQX
```

Disable the `simulator_v1` profile and the `TEST-GW-001` gateway.

---

## Architecture

```
MQTT broker ─┐
             ├─► ingestion ─► raw_iot_messages ─► adapter ─► normalisation ─┐
HTTP ingest ─┘   (stores           (verbatim,     (profile    (meter, time,  │
                  first,            never          driven)     registers,    │
                  parses later)     discarded)                 quality)      │
                                                                             ▼
                                                                        telemetry
                                                                             │
                                 ┌──────────────┬──────────────┬─────────────┤
                                 ▼              ▼              ▼             ▼
                            energy         rollups         alerts       event bus
                            counters      (1m…1mo)                          │
                                                                    ┌───────┴───────┐
                                                                    ▼               ▼
                                                                REST API      SSE / WebSocket
```

```
src/
  config/      env (every knob), metric catalogue
  core/        logger + event codes, time/timezone, hashing, errors, event bus
  db/          driver abstraction (postgres | sqlite), migrations, repositories
  iot/
    mqtt/      client, consumer, publisher, embedded broker
    http/      ingest endpoint
    adapters/  registry, JSON path helpers, profile engine
      veritek/  parser, mapper, discovery fallback
    modbus/    decoder (datatype/endian/scale), register-map application
    telemetry/ ingestion queue, processor, normalisation, aggregation,
               energy maths, quality, query models
    devices/   gateway and meter resolution
    commands/  remote configuration (disarmed)
    alerts/    rule engine
    health/    liveness and retention
    simulator/ synthetic meter and gateway
  api/         express app, middleware, routes
  realtime/    SSE + WebSocket hub
```

Vendor-specific parsing is confined to `iot/adapters/veritek/`. Everything
below that boundary speaks our schema only.

---

## APIs

### Ingestion

```
POST /api/iot/veritek/ingest     -> 202 {"status":"accepted","id":"raw_..."}
POST /api/iot/:vendor/ingest         (same handler, vendor-neutral)
```

Raw bytes are stored before parsing; transformation happens after the response,
so a gateway on a slow cellular link is never held open.

### Dashboard

```
GET  /api/sites
GET  /api/sites/:siteId/energy/live
GET  /api/sites/:siteId/energy/history?from=-24h&to=now&interval=15m
GET  /api/meters
GET  /api/meters/:meterId/live
GET  /api/meters/:meterId/history?from=&to=&interval=1m|5m|15m|1h|1d|1mo|raw
GET  /api/meters/:meterId/consumption?metric=energy_import_kwh&from=&to=
GET  /api/meters/:meterId/register-map
GET  /api/meters/:meterId/counter-events
GET  /api/meters/compare/history?meterIds=a,b,c
GET  /api/gateways
GET  /api/gateways/:gatewayId/status
GET  /api/gateways/:gatewayId/raw
GET  /api/alerts            POST /api/alerts/:id/acknowledge | /resolve
GET  /api/alerts/rules      POST /api/alerts/rules
GET  /api/health            GET  /api/health/detail
GET  /api/stream?meterId=   (SSE)        ws://host/ws?meterId=   (WebSocket)
```

`from` / `to` accept ISO-8601, epoch, `now`, or relative shorthands (`-24h`,
`-7d`). Times are stored in UTC and each response also carries the site-local
rendering (`tLocal`) and the site timezone.

### Configuration

```
POST   /api/admin/sites | gateways | meters | meter-models | registers | users
POST   /api/admin/registers/bulk
POST   /api/admin/gateways/:id/token
GET/POST /api/admin/payload-profiles
GET/POST /api/admin/metrics
GET/POST /api/admin/command-templates
POST   /api/admin/commands
GET    /api/admin/audit-log
```

### Commissioning

```
GET  /api/commissioning/overview
GET  /api/commissioning/topics
GET  /api/commissioning/raw          GET /api/commissioning/raw/:id
POST /api/commissioning/raw/:id/replay
POST /api/commissioning/test-parse
GET  /api/commissioning/suggest-profile?gatewayUid=
```

---

## Behaviours worth knowing

### Arrival time is not measurement time

The gateway buffers readings through a cellular outage and uploads them on
reconnect. Three readings measured at 12:01, 12:02 and 12:03 can all arrive at
12:10 — and history must show 12:01/12:02/12:03.

Every telemetry row therefore carries:

- `time` — the authoritative measurement time (source time where credible)
- `source_timestamp` — exactly what the device claimed
- `server_received_at` — when we saw it
- `is_buffered` — true when the lag exceeded `BUFFERED_THRESHOLD_SECONDS`

A device timestamp outside `MAX_PAST_SKEW_SECONDS` / `MAX_FUTURE_SKEW_SECONDS`
falls back to server time, but the device's claim is still recorded and a
`CLOCK_SKEW_DETECTED` line is logged — a broken RTC is visible rather than
silently scattering readings across history.

### Replays cannot double-count

Each sample carries a fingerprint over
`gateway + slave + source timestamp + values`, and `telemetry` is keyed on
`(meter_id, metric, time)`. A replayed packet collapses onto the row that
already exists; the raw packet is still stored and counted as `DUPLICATE`.

### Cumulative registers are differenced, never summed

`consumption = end - start`, walked reading by reading so that:

- a register **rollover** is credited (`(ceiling - previous) + current`)
- a meter **reset** credits nothing and is flagged `SUSPECT`
- an implausible **spike** is flagged but still stored

Every anomaly lands in `energy_counter_events`. Readings are never rewritten —
only their `quality` changes (`GOOD` / `ESTIMATED` / `SUSPECT` / `BAD` / `STALE`).

### Rollups are rebuilt, not accumulated

Late data marks its *measurement-time* bucket dirty and the bucket is recomputed
from raw. That is what makes yesterday's chart correct after today's replay.
Buckets: 1m, 5m, 15m, 1h, 1d, 1mo — daily and monthly on the **site's** calendar,
so "yesterday's kWh" means local midnight to local midnight.

### An unknown payload cannot take the consumer down

Stored raw → logged with its topic and time → marked `UNKNOWN_SCHEMA` → the
subscription keeps running. Every field it contained is recorded in
`payload_field_observations` so the commissioning screen can show you the real
schema.

### Remote configuration is deliberately inert

A command is only built from a `command_templates` row that a human has filled
in from vendor documentation and marked `verified`, and only when
`COMMANDS_ENABLED=true`. Otherwise the request is recorded as `BLOCKED`, audited,
and the API answers `501 NOT_CONFIGURED`. Guessing a control message aimed at an
energy meter is not worth the risk.

---

## Logging

Structured, with stable event codes — grep one token to follow a packet:

```
MQTT_CONNECTED  MQTT_DISCONNECTED  MQTT_RECONNECTED  BROKER_STARTED
GATEWAY_MESSAGE_RECEIVED  RAW_MESSAGE_STORED  MESSAGE_PARSED
METER_IDENTIFIED  TELEMETRY_SAVED
UNKNOWN_GATEWAY  UNKNOWN_SLAVE  UNKNOWN_REGISTER  UNKNOWN_SCHEMA
INVALID_PAYLOAD  DUPLICATE_PACKET  PROCESSING_FAILED
DEVICE_STALE  DEVICE_OFFLINE  DEVICE_RECOVERED
BUFFERED_DATA_RECEIVED  CLOCK_SKEW_DETECTED
COUNTER_RESET_DETECTED  COUNTER_ROLLOVER_DETECTED  VALUE_SPIKE_DETECTED
ALERT_OPENED  ALERT_CLOSED
COMMAND_QUEUED  COMMAND_SENT  COMMAND_ACKNOWLEDGED  COMMAND_BLOCKED
```

Any field whose key looks like a credential is replaced with `[redacted]` at
every depth, and connection strings are stripped of passwords before logging.
`LOG_PRETTY=false` emits JSON lines for a log collector.

---

## Security

Implemented:

- per-gateway credentials, stored as scrypt hashes, shown once at issue
- no anonymous MQTT: the embedded broker refuses unauthenticated clients by
  default and confines each gateway to its own topic namespace
- Mosquitto equivalents in `deploy/mosquitto/` (password file + ACL + TLS listener)
- bearer-token auth on the HTTP ingest endpoint (`INGEST_REQUIRE_AUTH`)
- JWT + role-based access on the dashboard APIs
- token-bucket rate limiting on ingest, login and dashboard routes
- payload size limits, strict schema validation *after* raw capture
- every configuration command and admin change written to `audit_log`
- credentials only from environment, never in frontend code

Before production, `GET /api/health/detail` lists `configWarnings` for anything
still on a development default, and the process logs them at boot.

---

## Production

```bash
docker compose -f deploy/docker-compose.yml up -d     # TimescaleDB + Mosquitto
```

```
DATABASE_URL=postgres://veritek:...@host:5432/veritek_iot
EMBEDDED_BROKER_ENABLED=false
MQTT_HOST=<broker>  MQTT_PORT=8883  MQTT_TLS=true
JWT_SECRET=<random>  TOKEN_PEPPER=<random>
NODE_ENV=production  LOG_PRETTY=false
```

With TimescaleDB present, `telemetry` and `raw_iot_messages` become hypertables
and a compression policy is applied to chunks older than 30 days. Without it,
plain PostgreSQL works — the tables stay ordinary and indexed.

See `deploy/mosquitto/README.md` for broker credentials and ACLs.

---

## Still needed from the hardware

1. **The energy meter's Modbus register table** — addresses, datatypes,
   byte/word order, scaling, and the value the kWh counter rolls over at.
2. **One real JSON packet from the gateway** — `npm run sniffer` captures it.
3. **The production MQTT topic and the remote-command syntax.**
4. **The unit's MQTT authentication and TLS capabilities.**

Each has a defined home in configuration, and `GET /api/commissioning/overview`
lists them under `openQuestions` so nobody has to remember which are still open.
