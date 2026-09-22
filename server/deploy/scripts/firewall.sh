#!/bin/sh
# Host firewall (spec section 16).
#
# Publishes only what has to be public:
#
#     443  HTTPS  dashboard and API
#    8883  MQTTS  gateways
#      22  SSH    restricted to SSH_ALLOW_CIDR
#    1883  MQTT   ONLY while a commissioning window is open
#
# Everything else - PostgreSQL, Prometheus, Grafana, the broker's internals, the
# broker webhooks - stays on loopback or the compose network.
#
#   sudo ./deploy/scripts/firewall.sh                 # steady state
#   sudo COMMISSIONING=1 ./deploy/scripts/firewall.sh # temporarily open 1883

set -eu

SSH_ALLOW_CIDR="${SSH_ALLOW_CIDR:-0.0.0.0/0}"
COMMISSIONING="${COMMISSIONING:-0}"

command -v ufw >/dev/null 2>&1 || { echo "ufw not installed" >&2; exit 1; }

ufw --force reset
ufw default deny incoming
ufw default allow outgoing

ufw allow from "$SSH_ALLOW_CIDR" to any port 22 proto tcp comment 'ssh'
ufw allow 80/tcp   comment 'http - ACME challenge and redirect to https'
ufw allow 443/tcp  comment 'https - dashboard and API'
ufw allow 8883/tcp comment 'mqtts - gateway telemetry'

if [ "$COMMISSIONING" = "1" ]; then
  echo "WARNING: opening plaintext MQTT on 1883 for commissioning."
  echo "Credentials cross the network unencrypted. Close it when finished:"
  echo "  sudo ./deploy/scripts/firewall.sh"
  ufw allow 1883/tcp comment 'mqtt plaintext - COMMISSIONING ONLY'
fi

# Never exposed: the database, the queues, the broker dashboard, the monitoring
# stack. Listed explicitly so the intent survives someone editing this file.
for port in 5432 6379 9090 3000 18083 4000; do
  ufw deny "$port"/tcp comment 'internal only'
done

ufw --force enable
ufw status verbose
