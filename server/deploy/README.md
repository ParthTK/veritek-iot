# Deployment runbook

Production IoT infrastructure for the energy platform: Mosquitto, TimescaleDB, the
backend, TLS, monitoring and backups. Everything is in this directory — no step
of the deployment is a command someone once ran on a VM and did not write down.

Written for whoever is standing up or operating the cloud environment.

---

## What gets deployed

```
                   internet
                      │
        ┌─────────────┼──────────────┐
        │ 443/tcp     │ 8883/tcp     │ (1883 only during commissioning)
        ▼             ▼              ▼
     nginx        Mosquitto ◄─── devices over 4G
        │             │
        │      credentials managed
        │      over $CONTROL
        │             ▼
        └────────► backend ──────► TimescaleDB   (never published)
                      │
                      ├──────────► Prometheus ──► Grafana  (loopback only)
                      └──────────► backups ─────► off-instance storage
```

Each device has its own login and may use only its own topics. Those live in
Mosquitto's Dynamic Security store, and the backend manages them: provisioning a
site is an API call, and suspending or revoking one reaches the broker in the
same request and drops the session it has open.

The broker decides on its own, so devices keep connecting and publishing while
the backend is being redeployed — their QoS 1 messages queue for it and arrive
when it comes back. The other side of that bargain is that the broker holds its
own copy of each credential, so it is reconciled against the database on every
startup, on every reconnect and every five minutes. `/api/health/detail` reports
the last reconciliation.

---

## Prerequisites

- A Linux host with Docker and the compose plugin.
- **A static/reserved public IP.** Devices are configured against DNS, but the
  DNS has to point somewhere that does not move.
- **DNS A records**, created before requesting certificates:

  | Name | Points to | Used by |
  |---|---|---|
  | `mqtt.energy.<domain>` | the static IP | gateways (MQTT/TLS) |
  | `api.energy.<domain>` | the static IP | dashboard and API |
  | `mqtt-staging.energy.<domain>` | staging IP | hardware testing |
  | `api-staging.energy.<domain>` | staging IP | staging API |

  Devices are configured against the **name**, never the address, so the
  infrastructure can move without touching deployed hardware.

---

## First deployment

### 1. Configuration

```bash
git clone <repo> && cd <repo>/server
cp deploy/env/production.env.example deploy/env/production.env
```

Fill in every value marked REQUIRED. Generate each secret separately:

```bash
openssl rand -base64 32
```

`deploy/env/*.env` is gitignored. In a managed environment, inject these from
the secret manager rather than a file on disk.

### 2. Firewall — before anything is listening

```bash
sudo SSH_ALLOW_CIDR=203.0.113.0/24 ./deploy/scripts/firewall.sh
```

Opens 22 (restricted), 80, 443 and 8883. Everything else — PostgreSQL,
Prometheus, Grafana and the database — is denied and
bound to loopback or the compose network.

### 3. TLS certificate

```bash
sudo ./deploy/scripts/issue-certificate.sh deploy/env/production.env
```

Requires DNS already resolving and port 80 reachable. Renewal afterwards is
automatic; the certbot container renews twice a day and the deploy hook reloads
nginx and restarts Mosquitto. Prometheus alerts if the certificate ever gets
within 21 days of expiry, which is what catches a renewal that has silently
stopped working.

### 4. Start the stack

`gcp-bootstrap.sh` does this, including initialising the broker's credential
store on first run. By hand:

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/env/production.env up -d
docker compose -f deploy/docker-compose.prod.yml ps
```

`restart: unless-stopped` on every service means the stack survives SSH logout,
a crash, and a host reboot.

### 5. Verify

```bash
curl -s https://api.energy.<domain>/api/health/ready | jq
echo | openssl s_client -connect mqtt.energy.<domain>:8883 | openssl x509 -noout -dates
docker compose -f deploy/docker-compose.prod.yml logs -f backend mosquitto
```

### 6. Prove it end to end from outside

```bash
npm run provision -- create --uid GW-TEST-001 --site <siteId> --meters 1

npm run verify:cloud -- \
  --host mqtt.energy.<domain> --api https://api.energy.<domain> \
  --gateway GW-TEST-001 --password '<printed above>' \
  --user <admin email> --pass '<admin password>' \
  --network "office wifi"
```

Then run it again tethered to a phone, with `--network "mobile hotspot"`. That
second run is the one that proves nothing depends on the office network.

---

## Provisioning a gateway

```bash
npm run provision -- create --uid GW-MUM-001 --site site-abc --meters 1,2
```

Prints the complete settings sheet for the installer. The MQTT password appears
once and is stored only as a scrypt hash.

| Command | Effect |
|---|---|
| `provision -- list` | the estate, with lifecycle and credential state |
| `provision -- profile --uid X` | settings sheet again (no password) |
| `provision -- rotate --uid X` | new password, same identity and history |
| `provision -- suspend --uid X --reason "..."` | blocked, reversible |
| `provision -- revoke --uid X --reason "..."` | blocked permanently |
| `provision -- decommission --uid X` | retired; telemetry kept |

The same operations are available under `/api/provisioning/*`.

---

## Routine operations

### Deploy a new version

```bash
git pull
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/env/production.env up -d --build backend
docker compose -f deploy/docker-compose.prod.yml logs -f backend
```

Migrations run at boot and are idempotent. The healthcheck uses
`/api/health/ready`, so a container that cannot reach the database is reported
unhealthy rather than quietly serving errors.

### Roll back

```bash
git checkout <previous tag>
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/env/production.env up -d --build backend
```

Migrations are additive — new columns with defaults, new tables — so the
previous image runs against the newer schema. Restore from backup only if a
migration has to be undone.

### Restart a component

```bash
docker compose -f deploy/docker-compose.prod.yml restart backend   # no gateway disconnects
docker compose -f deploy/docker-compose.prod.yml restart mosquitto # devices reconnect on their own
```

Both are safe. The backend reconnects with exponential backoff and jitter, and
gateways buffer through a broker restart and replay on reconnect — which the
failure tests exercise.

### Backups

Nightly `pg_dump`, compressed, with retention, copied off-instance when
`BACKUP_S3_TARGET` is set.

```bash
docker compose -f deploy/docker-compose.prod.yml exec backup /usr/local/bin/backup.sh
docker compose -f deploy/docker-compose.prod.yml exec timescaledb \
  /usr/local/bin/restore-test.sh /backups/veritek-veritek_iot-<stamp>.sql.gz
```

Run the restore test on a schedule. An unrestored backup is an assumption.

---

## Monitoring

Both UIs are bound to loopback. Reach them over an SSH tunnel:

```bash
ssh -L 3000:localhost:3000 -L 9090:localhost:9090 user@host
```

- Grafana <http://localhost:3000> — "VERITEK IoT — Connectivity and Ingestion"
- Prometheus <http://localhost:9090> — alert rule state
Mosquitto has no admin UI. Its statistics are on the Grafana dashboard
(`veritek_broker_stat`, re-exported by the backend from the broker's `$SYS`
topics), and every connection, refusal and credential change is in its log:

```bash
docker logs veritek-mosquitto | grep -i "not authori"   # refused logins
docker logs veritek-mosquitto | grep dynsec             # credential changes
```

Alert rules are in `prometheus/alerts.yml`. Point Alertmanager at email, Slack
or PagerDuty; the rules and thresholds are already written.

**Retune `GatewayStoppedReporting` once the real gateway poll interval is
known.** It currently fires after 15 minutes of silence, which is a guess.

---

## Troubleshooting

### A gateway will not connect

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  'https://api.energy.<domain>/api/provisioning/auth-events?denied=true' | jq
```

Every refusal is recorded with the username, client id, source IP and reason.
The usual causes: credential rotated but not updated on the device; the gateway
is suspended or revoked; the client id does not match a pinned pattern.

### A gateway connects but no data appears

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  'https://api.energy.<domain>/api/commissioning/raw?limit=5' | jq
```

If raw packets are arriving but flagged `UNKNOWN_SCHEMA`, the payload profile
does not match yet — see the commissioning workflow in the main README. If
nothing is arriving, check the ACL denials above: a gateway publishing to a
topic outside its namespace is refused.

### Certificate problems

```bash
docker compose -f deploy/docker-compose.prod.yml logs certbot
echo | openssl s_client -connect mqtt.energy.<domain>:8883 | openssl x509 -noout -dates
```

---

## Security posture

| Control | Implementation |
|---|---|
| No anonymous MQTT | Mosquitto `allow_anonymous false`; the container's healthcheck fails if an anonymous CONNECT is ever accepted |
| Per-device credentials | one `mqtt_credentials` row per device, scrypt-hashed, mirrored to the broker's own store |
| Topic isolation | one broker role per credential; subscriptions granted as literals, so a device cannot widen its own topic to a wildcard |
| Backend account separate | `energy-backend-ingestion`, never a gateway credential, still ACL-bound |
| TLS | Let's Encrypt on 8883 and 443, renewal automated and alerted |
| Database private | `expose` only; never published, never reachable by a device |
| Admin UIs private | Grafana and Prometheus on loopback; the broker has no admin UI to expose |
| Rate and size limits | broker connection/message/byte rates, 1 MB packets, API token buckets |
| Audit | connections and refusals in the broker log; provisioning, suspension and revocation in `audit_log` |
| Secrets | environment only, from Secret Manager; `deploy/env/*.env` is gitignored |
| Credential store backed up | nightly with the database — losing it locks every device out |

Verify with:

```bash
npm run test:security -- --live    # against staging
```

---

## Still unverified against the physical unit

These are hardware questions, not deployment ones. Each has a configuration
home already:

1. **TLS support.** If the gateway cannot do TLS, 1883 must be opened for a
   controlled window (`MQTT_PLAINTEXT_ENABLED=true`, `MQTT_PLAIN_BIND=0.0.0.0`,
   `sudo COMMISSIONING=1 ./deploy/scripts/firewall.sh`) and closed afterwards.
2. **Configurable topics.** If the unit insists on its own topic, add it to
   `MQTT_VENDOR_TOPICS` and widen that gateway's ACL.
3. **MQTT version and authentication.** Username/password over TLS is assumed.
   Client-certificate auth would mean switching `verify` to `verify_peer`.
4. **Remote-command syntax.** Commands stay disarmed until a verified template
   exists.
