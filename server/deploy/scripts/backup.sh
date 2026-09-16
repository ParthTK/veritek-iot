#!/bin/sh
# Automated database backup (spec section 22).
#
# Nightly pg_dump, compressed, with retention, optionally copied off the
# instance. A backup that has never been restored is not a backup - use
# restore-test.sh to prove it.

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/veritek-${PGDATABASE:-veritek_iot}-${STAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "[backup] dumping ${PGDATABASE:-veritek_iot} to $FILE"
pg_dump --no-owner --no-privileges --format=plain | gzip -9 > "$FILE"

SIZE="$(wc -c < "$FILE")"
if [ "$SIZE" -lt 1024 ]; then
  echo "[backup] FAILED: dump is only ${SIZE} bytes" >&2
  rm -f "$FILE"
  exit 1
fi
echo "[backup] wrote $SIZE bytes"

# Off-instance copy. A backup on the same disk as the database survives neither
# a disk failure nor a deleted VM.
if [ -n "${BACKUP_S3_TARGET:-}" ]; then
  if command -v aws >/dev/null 2>&1; then
    echo "[backup] uploading to $BACKUP_S3_TARGET"
    aws s3 cp "$FILE" "$BACKUP_S3_TARGET/" --only-show-errors
  else
    echo "[backup] WARNING: BACKUP_S3_TARGET set but the aws CLI is missing; backup is local only" >&2
  fi
else
  echo "[backup] WARNING: BACKUP_S3_TARGET is unset - this backup exists only on this instance" >&2
fi

echo "[backup] pruning local backups older than $RETENTION_DAYS days"
find "$BACKUP_DIR" -name 'veritek-*.sql.gz' -mtime "+$RETENTION_DAYS" -print -delete

echo "[backup] done"
