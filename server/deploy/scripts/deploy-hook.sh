#!/bin/sh
# certbot --deploy-hook: runs only when a certificate was actually renewed.
#
# Copies the new files where Mosquitto and nginx expect them, then reloads both.
# Without this the renewal succeeds and the broker keeps serving the old
# certificate until someone notices - which is how an "automated" renewal still
# ends in an outage.

set -eu

DOMAIN="${RENEWED_DOMAINS%% *}"
SRC="/etc/letsencrypt/live/$DOMAIN"
DEST="/etc/letsencrypt/live-export"

echo "[deploy-hook] certificate renewed for $DOMAIN"
cp "$SRC/fullchain.pem" "$DEST/fullchain.pem"
cp "$SRC/privkey.pem"   "$DEST/privkey.pem"
cp "$SRC/chain.pem"     "$DEST/chain.pem"
chmod 644 "$DEST/fullchain.pem" "$DEST/chain.pem"
chmod 640 "$DEST/privkey.pem"

if command -v docker >/dev/null 2>&1; then
  docker exec veritek-nginx nginx -s reload || echo "[deploy-hook] nginx reload failed" >&2
  # Devices reconnect with backoff; sessions and queued messages are saved on
  # the way down.
  docker restart veritek-mosquitto \
    || echo "[deploy-hook] Mosquitto restart failed - restart it manually" >&2
fi

echo "[deploy-hook] done"
