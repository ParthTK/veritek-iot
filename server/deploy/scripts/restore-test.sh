#!/bin/sh
# Verify a backup by restoring it into a throwaway database (spec section 22).
#
#   ./deploy/scripts/restore-test.sh /backups/veritek-veritek_iot-2026....sql.gz
#
# Restores into veritek_restore_test, counts the rows that matter, then drops
# the database. Run it against staging on a schedule; an unrestored backup is
# an assumption, not a safeguard.

set -eu

ARCHIVE="${1:?usage: restore-test.sh <backup.sql.gz>}"
TEST_DB="${TEST_DB:-veritek_restore_test}"

[ -f "$ARCHIVE" ] || { echo "no such backup: $ARCHIVE" >&2; exit 1; }

echo "[restore-test] creating $TEST_DB"
dropdb --if-exists "$TEST_DB"
createdb "$TEST_DB"

echo "[restore-test] restoring $ARCHIVE"
gunzip -c "$ARCHIVE" | psql --quiet --dbname "$TEST_DB" >/dev/null

echo "[restore-test] verifying contents"
psql --dbname "$TEST_DB" --tuples-only --no-align --command "
  SELECT 'gateways=' || (SELECT COUNT(*) FROM gateways)
      || ' meters=' || (SELECT COUNT(*) FROM meters)
      || ' telemetry=' || (SELECT COUNT(*) FROM telemetry)
      || ' raw=' || (SELECT COUNT(*) FROM raw_iot_messages)
      || ' credentials=' || (SELECT COUNT(*) FROM mqtt_credentials);
"

TELEMETRY="$(psql --dbname "$TEST_DB" --tuples-only --no-align --command 'SELECT COUNT(*) FROM telemetry;')"
if [ "$TELEMETRY" -eq 0 ]; then
  echo "[restore-test] FAILED: telemetry table restored empty" >&2
  dropdb --if-exists "$TEST_DB"
  exit 1
fi

echo "[restore-test] dropping $TEST_DB"
dropdb "$TEST_DB"
echo "[restore-test] PASSED - $ARCHIVE is restorable"
