#!/bin/sh
# Obtain and install the TLS certificate for the MQTT and API hostnames
# (spec section 4).
#
#   sudo ./deploy/scripts/issue-certificate.sh deploy/env/production.env
#
# Uses the ACME http-01 challenge on port 80, so DNS must already resolve to
# this host and 80 must be reachable. Renewal afterwards is automatic: the
# certbot container renews twice a day and runs the deploy hook, which copies
# the new files and reloads both nginx and Mosquitto.
#
# Self-signed certificates are not used here. A gateway that has to be told to
# skip verification cannot tell a real broker from an impostor.

set -eu

ENV_FILE="${1:-deploy/env/production.env}"
[ -f "$ENV_FILE" ] || { echo "env file not found: $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"

: "${MQTT_PUBLIC_HOST:?set MQTT_PUBLIC_HOST}"
: "${ACME_EMAIL:?set ACME_EMAIL}"
API_HOST="${API_PUBLIC_HOST:-$MQTT_PUBLIC_HOST}"
CERT_DIR="$(dirname "$0")/../certs"

mkdir -p "$CERT_DIR"

echo "[certs] requesting a certificate for $MQTT_PUBLIC_HOST and $API_HOST"
docker run --rm \
  -p 80:80 \
  -v veritek-iot_certbot-etc:/etc/letsencrypt \
  -v veritek-iot_certbot-webroot:/var/www/certbot \
  certbot/certbot certonly \
    --standalone \
    --non-interactive --agree-tos \
    --email "$ACME_EMAIL" \
    -d "$MQTT_PUBLIC_HOST" \
    -d "$API_HOST"

echo "[certs] exporting to $CERT_DIR"
docker run --rm \
  -v veritek-iot_certbot-etc:/etc/letsencrypt \
  -v "$(cd "$CERT_DIR" && pwd)":/export \
  alpine sh -c "
    cp /etc/letsencrypt/live/$MQTT_PUBLIC_HOST/fullchain.pem /export/fullchain.pem &&
    cp /etc/letsencrypt/live/$MQTT_PUBLIC_HOST/privkey.pem  /export/privkey.pem &&
    cp /etc/letsencrypt/live/$MQTT_PUBLIC_HOST/chain.pem    /export/chain.pem &&
    chmod 644 /export/fullchain.pem /export/chain.pem &&
    chmod 640 /export/privkey.pem
  "

echo "[certs] restarting the services that hold the certificate"
docker compose -f "$(dirname "$0")/../docker-compose.prod.yml" --env-file "$ENV_FILE" restart mosquitto nginx

echo "[certs] verifying the live TLS listener"
if command -v openssl >/dev/null 2>&1; then
  echo | openssl s_client -connect "$MQTT_PUBLIC_HOST:8883" -servername "$MQTT_PUBLIC_HOST" 2>/dev/null \
    | openssl x509 -noout -subject -issuer -dates
else
  echo "[certs] openssl not available; check manually:"
  echo "  openssl s_client -connect $MQTT_PUBLIC_HOST:8883 | openssl x509 -noout -dates"
fi

echo "[certs] done. Renewal is automatic; Prometheus alerts if it ever is not."
