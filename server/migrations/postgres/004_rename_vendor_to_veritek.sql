-- Rename the platform's own vendor identifier from the old name to 'veritek'.
--
-- The adapter, its payload profiles and the recorded adapter name on stored
-- packets all used the previous branding. Without this, a database created
-- before the rename keeps profile rows whose `vendor` matches no registered
-- adapter, and the seed would add a second, near-identical profile beside the
-- old one rather than updating it.
--
-- Historical telemetry is untouched: only the labels change.

UPDATE payload_profiles
   SET vendor = 'veritek'
 WHERE vendor = 'technode';

UPDATE payload_profiles
   SET name = 'veritek_schema_v1'
 WHERE name = 'technode_schema_v1'
   -- Only if the new name is not already taken, so re-running after a seed
   -- that already created it cannot violate the unique index on name.
   AND NOT EXISTS (SELECT 1 FROM payload_profiles p WHERE p.name = 'veritek_schema_v1');

-- Records which adapter parsed each stored packet; purely descriptive.
UPDATE raw_iot_messages
   SET adapter = 'veritek'
 WHERE adapter = 'technode';

-- Topic namespaces recorded against a gateway at auto-provisioning time.
UPDATE gateways
   SET topic_namespace = replace(topic_namespace, 'technode/', 'veritek/')
 WHERE topic_namespace LIKE 'technode/%';

UPDATE gateways
   SET observed_topic = replace(observed_topic, 'technode/', 'veritek/')
 WHERE observed_topic LIKE 'technode/%';
