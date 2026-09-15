-- Applied only when the TimescaleDB extension is present (the migration runner
-- skips this file otherwise, so a plain PostgreSQL deployment still works - it
-- just keeps `telemetry` as an ordinary indexed table).

-- `telemetry` is the only hypertable here. Its primary key is
-- (meter_id, metric, time), which includes the partitioning column - Timescale
-- refuses to convert a table whose unique indexes do not.
--
-- `raw_iot_messages` is deliberately NOT converted: its primary key is `id`
-- alone, and widening that to (id, received_at_server) to satisfy Timescale
-- would stop the database enforcing that a raw packet id is unique. It is a
-- forensic log with its own retention sweep (RAW_RETENTION_DAYS), and an
-- ordinary indexed table serves that perfectly well.

SELECT create_hypertable(
  'telemetry',
  'time',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE,
  migrate_data => TRUE
);

-- Segmenting by meter+metric keeps the per-series scans the history API issues
-- cheap even once a chunk is compressed.
ALTER TABLE telemetry SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'meter_id, metric',
  timescaledb.compress_orderby = 'time DESC'
);

-- 90 days, comfortably beyond MAX_PAST_SKEW_SECONDS (30 days by default), so a
-- gateway replaying a long backlog writes into uncompressed chunks.
SELECT add_compression_policy('telemetry', INTERVAL '90 days', if_not_exists => TRUE);
