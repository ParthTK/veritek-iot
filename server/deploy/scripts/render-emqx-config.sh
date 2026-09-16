#!/bin/sh
# Render emqx.conf from emqx.conf.template, substituting deployment secrets.
#
# Run before `docker compose up`. sed on explicit __TOKENS__ rather than
# envsubst, because EMQX's own ${username} / ${topic} placeholders must survive
# rendering untouched.
#
#   ./deploy/scripts/render-emqx-config.sh deploy/env/production.env

set -eu

ENV_FILE="${1:-deploy/env/production.env}"
TEMPLATE="$(dirname "$0")/../emqx/etc/emqx.conf.template"
OUTPUT="$(dirname "$0")/../emqx/etc/emqx.conf"

[ -f "$ENV_FILE" ] || { echo "env file not found: $ENV_FILE" >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "template not found: $TEMPLATE" >&2; exit 1; }

# shellcheck disable=SC1090
. "$ENV_FILE"

: "${BROKER_WEBHOOK_SECRET:?BROKER_WEBHOOK_SECRET must be set in $ENV_FILE}"
: "${MQTT_PUBLIC_HOST:?MQTT_PUBLIC_HOST must be set in $ENV_FILE}"
BACKEND_INTERNAL_URL="${BACKEND_INTERNAL_URL:-http://backend:4000}"

sed \
  -e "s|__BROKER_WEBHOOK_SECRET__|${BROKER_WEBHOOK_SECRET}|g" \
  -e "s|__BACKEND_INTERNAL_URL__|${BACKEND_INTERNAL_URL}|g" \
  -e "s|__MQTT_PUBLIC_HOST__|${MQTT_PUBLIC_HOST}|g" \
  "$TEMPLATE" > "$OUTPUT"

chmod 600 "$OUTPUT"
echo "rendered $OUTPUT"
echo "reminder: emqx.conf contains the webhook secret and is gitignored."
