# Production IoT infrastructure — handover

Prepared for whoever operates this platform and whoever connects the first
Technode gateway.

**No passwords, keys or secrets appear in this document.** Where a value is
deployment-specific it is marked `<fill in at deployment>`.

---

## 0. The live deployment

Deployed and verified on Google Cloud. No secret appears below.

| | |
|---|---|
| GCP project | `veritek` |
| Region / zone | `asia-south1` (Mumbai) / `asia-south1-a` - the sites are in India |
| VM | `veritek-iot-01`, e2-medium (2 vCPU / 4 GB), Debian 12, 30 GB |
| Static IP | `8.231.120.125` (reserved) |
| **MQTT endpoint** | **`mqtts://mqtt.8-231-120-125.sslip.io:8883`** |
| **API + dashboard** | **`https://api.8-231-120-125.sslip.io`** |
| Commissioning screen | `https://api.8-231-120-125.sslip.io/commissioning` |
| Admin sign-in | `admin@veritek.local` - password in Secret Manager, see below |
| Backups | `gs://veritek-iot-backups`, nightly, 30-day lifecycle |
| Environment | staging (plaintext 1883 open for commissioning) |

### Getting a secret

Every deployment secret lives in Secret Manager, never in git and never in a
file that leaves the host:

```bash
gcloud secrets versions access latest --secret=veritek-seed-admin-password --project=veritek
gcloud secrets list --project=veritek
```

### About the hostname

`sslip.io` resolves any name containing the dashed IP, which gave us real DNS
names and a publicly trusted Let's Encrypt certificate without owning a domain.
It is a stand-in, not a compromise on the principle: devices are still
configured against a **name**, so moving to `mqtt.energy.<domain>` later is a
DNS record plus `BASE_DOMAIN` in the bootstrap - no gateway is reconfigured.

Do that before the estate grows: the current name is tied to this IP, so
replacing the VM would mean re-pointing every device.

### Redeploying

```bash
gcloud compute ssh veritek-iot-01 --project=veritek --zone=asia-south1-a
cd /opt/veritek/repo && sudo git fetch origin && sudo git reset --hard origin/main
sudo bash server/deploy/scripts/gcp-bootstrap.sh
```

Idempotent: it re-reads secrets, re-renders the broker config, skips the
certificate while it is still valid, rebuilds the dashboard and restarts only
what changed.

---
## 1. Status

| | |
|---|---|
| **Live on Google Cloud** | Broker with TLS and per-device auth/ACL, database, backend, dashboard, monitoring, backups, certificate renewal - all deployed and verified from outside the network |
| **Verified against the deployment** | Cloud acceptance 14/14, live security 11/11, backup restored to Cloud Storage |
| **Waiting on a domain** | A real hostname to replace the sslip.io stand-in. One DNS record and one variable |
| **Waiting on the hardware** | Four questions in section 10 |

The only thing between this and production traffic is the physical gateway and
a domain name. Nothing in the first two rows is a plan; it is running.

---

## 2. Cloud

| Item | Value |
|---|---|
| Provider | Google Cloud, project `veritek` |
| Region | `asia-south1` (Mumbai) - close to the sites; every reading crosses this link |
| Compute | `veritek-iot-01`, e2-medium, Debian 12, running the Docker Compose stack |
| Static IP | `8.231.120.125`, reserved |
| Service account | `veritek-iot-vm`: read its own secrets, write backups, write logs and metrics. Nothing else |
| Orchestration | Docker Compose, `restart: unless-stopped` on every service |
| Deployment | `deploy/docker-compose.prod.yml` + `deploy/scripts/gcp-bootstrap.sh` |

**Sizing:** a 2 vCPU / 4 GB host comfortably carries the 100-gateway load test
(measured below). Revisit past ~500 gateways, or when raw-packet retention grows
the database beyond the disk.

Services: `emqx`, `timescaledb`, `backend`, `nginx`, `prometheus`, `grafana`,
`node-exporter`. Certificate renewal and backups run as host systemd timers
rather than containers - both must reload other containers or write to Cloud
Storage, and giving a container the Docker socket to do that hands it root.

---

## 3. MQTT

| Item | Value |
|---|---|
| Broker | EMQX 5.8 (chosen over Mosquitto for HTTP auth/ACL, per-connection observability and headroom for more devices) |
| Hostname | `mqtt.8-231-120-125.sslip.io` today; `mqtt.energy.<domain>` once a domain exists — **devices are configured against the name, never an IP** |
| Staging hostname | `mqtt-staging.energy.<domain>` |
| TLS port | **8883 — the production endpoint** |
| Plaintext port | 1883 — currently OPEN on staging for commissioning. Close it once the unit is confirmed on 8883 |
| MQTT version | 3.1.1 and 5.0 both accepted; the unit's support is unconfirmed |
| QoS | 1 (at-least-once). Duplicates are expected and are deduplicated in the application |
| Retain | telemetry `false`; status retained; **commands never retained** |
| Keepalive | 60 s, with a 1.5x grace multiplier for cellular links |
| Max packet | 1 MB |

### Topic structure

```
energy/v1/gateways/{gatewayId}/telemetry     device -> cloud
energy/v1/gateways/{gatewayId}/status        device -> cloud (retained, LWT)
energy/v1/gateways/{gatewayId}/command       cloud  -> device
energy/v1/gateways/{gatewayId}/response      device -> cloud
```

The consumer also subscribes to anything in `MQTT_VENDOR_TOPICS`, so a gateway
that cannot be pointed at these topics is a configuration entry, not a code
change.

### Why commands are never retained

A retained command would be redelivered every time a gateway reconnects. A
stale "set polling interval" replayed weeks later is merely wrong; a stale
control message aimed at an energy meter is worse.

---

## 4. Security

| Control | Implementation |
|---|---|
| Anonymous access | Refused twice: EMQX `allow_anonymous false`, and the auth webhook refuses empty credentials |
| Authentication | HTTP webhook to the backend on every CONNECT; the credential table is the single source of truth |
| Credential storage | scrypt hashes. Plaintext is shown once at issue and never again, never to the frontend |
| Per-device credentials | One row per gateway. A leak is revoked for that device alone |
| Authorization | Per-credential ACL. `no_match = deny`, `deny_action = disconnect` |
| Device scope | Publish own telemetry/status/response, subscribe own command. Nothing else |
| Backend account | `energy-backend-ingestion`, separate from every device, still ACL-bound (not a broker superuser) |
| TLS | Let's Encrypt on 8883 and 443. Renewal automated, and alerted if it fails |
| Database | Never published. Devices cannot reach it, and never hold database credentials |
| Admin UIs | Grafana, Prometheus and the EMQX dashboard on loopback; reach them over SSH/VPN |
| Rate limiting | Broker connection/message/byte rates per listener; token buckets on ingest, login and API |
| Audit | Every connection and denial in `mqtt_auth_events`; every config change in `audit_log` |
| Secrets | Environment only. `deploy/env/*.env` and the rendered `emqx.conf` are gitignored |

### Credential provisioning

```bash
npm run provision -- create --uid GW-MUM-001 --site site-onida --meters 1,2
```

Creates the gateway, its meters, its credential and its ACL, and prints the
installer's settings sheet. Also available at `POST /api/provisioning/gateways`.

Lifecycle: `provisioned → active → suspended ⇄ active → revoked | decommissioned`.
Suspension, revocation and decommissioning flip the credential in the same
operation, so access is lost at the next connection attempt. Telemetry history
is never deleted.

---

## 5. Deployment

Full runbook: [`deploy/README.md`](../deploy/README.md).

| Procedure | Command |
|---|---|
| First deploy | firewall → certificate → `render-emqx-config.sh` → `docker compose up -d` |
| Update | `git pull && docker compose ... up -d --build backend` |
| Restart | `docker compose ... restart backend` (no gateway disconnects) |
| Roll back | check out the previous tag and rebuild; migrations are additive |
| Open 1883 | `sudo COMMISSIONING=1 ./deploy/scripts/firewall.sh` — **close it afterwards** |

Everything is in the repository: compose files, EMQX config template, ACL,
Prometheus rules, Grafana dashboards, nginx config, firewall, backup and
restore scripts, and environment templates for both environments. The
environment can be rebuilt on another host from a clone plus the secrets.

---

## 6. Monitoring

| | |
|---|---|
| Metrics | Prometheus scrapes the backend `/metrics` and EMQX |
| Dashboard | Grafana, "VERITEK IoT — Connectivity and Ingestion" (provisioned automatically) |
| Logs | JSON to stdout, captured by Docker with rotation. Stable event codes — grep `TELEMETRY_SAVED`, `DUPLICATE_PACKET`, `BROKER_ACL_DENIED` |
| Alert rules | `deploy/prometheus/alerts.yml` |
| Access | Loopback only: `ssh -L 3000:localhost:3000 -L 9090:localhost:9090 user@host` |

Visible: broker up/down, active connections, connected gateways, messages/sec in
and out, authentication failures, ACL denials, malformed payloads, duplicates,
disconnects and reconnects, processing latency percentiles, ingest queue depth,
measurement-to-arrival lag, and time since each gateway last reported.

Alerts: broker down, backend consumer disconnected, database unavailable,
ingest error-rate spike, malformed-payload spike, queue backlog, latency,
authentication-failure spike, ACL-denial spike, gateway stopped reporting, whole
estate offline, disk filling, memory high, certificate expiring (21 days warning,
7 days critical).

**Alertmanager routing is not configured** — the rules are written, but nothing
sends them anywhere yet. Point it at email/Slack/PagerDuty at deployment.

---

## 7. Backups

| | |
|---|---|
| Schedule | Nightly `pg_dump`, gzip |
| Retention | 30 days local, configurable |
| Off-instance | `BACKUP_S3_TARGET` — **set it. A backup on the same disk survives nothing** |
| Restore | `deploy/scripts/restore-test.sh <archive>` — restores into a throwaway database, verifies row counts, drops it |
| Broker config | Reproducible from the repository; no separate backup needed |

A backup that has never been restored is an assumption. Run `restore-test.sh`
against staging on a schedule.

---

## 8. Test results

All run on 2026-09-16. Raw output in [`docs/test-results/`](test-results/).

| Suite | Result | Notes |
|---|---|---|
| Unit tests | **55/55** | Modbus decoding, energy maths, time/timezone, adapter, ACL |
| End-to-end pipeline | **38/38** | MQTT + HTTP → raw → normalise → telemetry → rollups → API → SSE |
| Security (decision logic) | **20/20** | Every allow and deny in section 4 |
| Security (live broker) | **10/10** | Real MQTT connections; the broker enforced each result |
| Failure and recovery | **19/19** | All ten scenarios recovered with no intervention |
| Load — 10 gateways | HEALTHY | 10/10 connected, 4.0 msg/s, publish p95 3 ms, 0 failures |
| Load — 100 gateways | HEALTHY | 100/100 connected in 10 s, 20 msg/s sustained, publish p95 2 ms, 0 failures |
| **Cloud acceptance (public internet)** | **14/14** | DNS, TLS, auth, ACL, publish, store, API, live stream - run from a laptop outside the network |
| **Live security (cloud EMQX)** | **11/11** | Real MQTT connections against the deployed broker, credentials provisioned through the API |
| **Backup** | PASS | pg_dump uploaded to `gs://veritek-iot-backups` |

### Security results (live broker)

| Check | Expected | Actual |
|---|---|---|
| Anonymous connection | deny | deny |
| Wrong password | deny | deny |
| Correct credential | allow | allow |
| Publish own telemetry | allow | allow |
| Subscribe own command topic | allow | allow |
| Publish another gateway's telemetry | deny | deny |
| Subscribe another gateway's command | deny | deny |
| Subscribe wildcard `#` | deny | deny |
| Revoked gateway | deny | deny |

### Failure and recovery

Broker interruption (consumer reconnected unaided), backoff verified growing,
capped and jittered, invalid credentials refused without destabilising the
consumer, ACL denial survived, malformed JSON stored and flagged, duplicate
stored once, out-of-order packets ordered by measurement time, a 60-reading
buffered burst fully ingested, revocation effective immediately, and a database
outage failing readiness while liveness stayed up — then recovering with no
restart.

### Not yet run

| Test | Why |
|---|---|
| 500-gateway load | Not yet run against the cloud host. `npm run test:load -- --gateways 500 --host mqtt.8-231-120-125.sslip.io --tls` |
| Mobile-network acceptance | Needs a phone hotspot: `npm run verify:cloud -- ... --network "mobile hotspot"`. Everything else about the run is identical |
| Backup restore drill | A backup exists and uploads; restoring it into a throwaway database has not been exercised on this host |
| Dashboard UI review | The dashboard is wired to the live API and serving, but nobody has clicked through every screen in a browser |

---

## 9. Bringing up the Technode unit

Staging first. Production only after a clean staging run.

1. `npm run provision -- create --uid GW-MUM-001 --site <siteId> --meters 1`
2. Enter the printed settings into the gateway: host, port 8883, username,
   password, client id, publish and subscribe topics, QoS 1, retain off.
3. Insert the SIM; connect RS485 A+ / B−.
4. Watch it arrive:
   - `npm run sniffer` — raw packets as they land
   - `https://api.energy.<domain>/commissioning` — topics, payloads, parse state
   - `/api/provisioning/auth-events?denied=true` — if it will not connect
5. Capture the first real packet: topic, exact JSON, client id, interval.
6. Map it: `/api/commissioning/suggest-profile` → `/test-parse` → save as
   `technode_schema_v1` → replay the stored packets.
7. Enter the meter's Modbus register table (`docs/register-map.template.json`).
8. `npm run provision -- activate --uid GW-MUM-001`
9. Lock down: narrow `MQTT_VENDOR_TOPICS`, `AUTO_PROVISION_*=false`, close 1883.

If the unit cannot do TLS, open 1883 for the window only
(`sudo COMMISSIONING=1 ./deploy/scripts/firewall.sh`) and close it afterwards.
Credentials cross the network in clear text while it is open.

---

## 10. Awaiting physical verification

| # | Question | Where the answer goes | Blocks |
|---|---|---|---|
| 1 | Does the unit support MQTT over TLS, and which CA does it trust? | `MQTT_PLAINTEXT_ENABLED`, firewall | Closing 1883 permanently |
| 2 | Can its publish/subscribe topics be set freely? | `MQTT_VENDOR_TOPICS` + that gateway's ACL | Using the `energy/v1` convention everywhere |
| 3 | What is the production JSON payload? | `payload_profiles` → `technode_schema_v1` | Promoting parsing from discovery to verified |
| 4 | What is the remote-configuration command syntax? | `command_templates` | Enabling remote configuration |

Also unconfirmed, and deliberately left unset rather than guessed: MQTT protocol
version, authentication mechanisms, whether LWT is configurable, the Modbus
register table, and per-meter slave id / baud rate / parity / stop bits.

Gateway status does **not** depend on LWT. It is derived server-side from
`last_seen_at` and `last_data_at`, so a unit with no LWT support is still
detected as offline.

---

## 11. Quick reference

```bash
# Health
curl https://api.energy.<domain>/api/health/ready

# Provision, then read the installer sheet back
npm run provision -- create --uid GW-MUM-001 --site site-onida --meters 1,2
npm run provision -- profile --uid GW-MUM-001

# Lost password
npm run provision -- rotate --uid GW-MUM-001

# Lost or stolen unit
npm run provision -- revoke --uid GW-MUM-001 --reason "unit lost"

# Why will this device not connect?
curl -H "Authorization: Bearer $TOKEN" \
  'https://api.energy.<domain>/api/provisioning/auth-events?denied=true'

# What is actually arriving?
curl -H "Authorization: Bearer $TOKEN" \
  'https://api.energy.<domain>/api/commissioning/raw?limit=5'

# Prove the whole path from anywhere
npm run verify:cloud -- --host mqtt.energy.<domain> --api https://api.energy.<domain> \
  --gateway GW-TEST-001 --password '<...>' --user <admin> --pass '<...>' --network "mobile hotspot"

# Test suites
npm test && npm run verify:e2e && npm run test:security && npm run test:failure
npm run test:load -- --gateways 100 --interval 30 --duration 180
```
