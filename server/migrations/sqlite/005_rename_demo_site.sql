-- SQLite dialect of migrations/postgres/005_rename_demo_site.sql.
-- Rename the demo site from the old, real-company-derived id to the
-- placeholder one ('site-onida' -> 'site-abc').
--
-- Done as copy, re-point, delete rather than an UPDATE of the primary key:
-- gateways and meters carry a foreign key to sites(id) with no ON UPDATE
-- CASCADE, so updating the key in place would be rejected.
--
-- Every statement is conditional, so this is a no-op on a database that never
-- had the old site, and safe to re-run. No telemetry is moved or deleted; only
-- the site label each row points at changes.

INSERT INTO sites (id, name, code, city, state, address, timezone, tariff_per_kwh, currency, created_at, updated_at)
SELECT 'site-abc', 'ABC Manufacturing', 'ABC', city, state,
       '1 Example Industrial Estate, Unit A, Mumbai 400001',
       timezone, tariff_per_kwh, currency, created_at, CURRENT_TIMESTAMP
  FROM sites
 WHERE id = 'site-onida'
   AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = 'site-abc');

UPDATE gateways           SET site_id = 'site-abc' WHERE site_id = 'site-onida';
UPDATE meters             SET site_id = 'site-abc' WHERE site_id = 'site-onida';
UPDATE telemetry          SET site_id = 'site-abc' WHERE site_id = 'site-onida';
UPDATE telemetry_rollups  SET site_id = 'site-abc' WHERE site_id = 'site-onida';
UPDATE alert_rules        SET site_id = 'site-abc' WHERE site_id = 'site-onida';
UPDATE alert_events       SET site_id = 'site-abc' WHERE site_id = 'site-onida';

DELETE FROM sites WHERE id = 'site-onida';
