-- Outbox + per-entity-type sequence (task W-01 owns and finalizes; payload contract in task P-02).

-- Debezium outbox format. The replicator INSERTs and DELETEs each row in the SAME transaction,
-- so the table stays empty; Debezium still reads the insert from the change log.
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  aggregatetype text NOT NULL,    -- entity type, e.g. 'airplanes'; routes to Redis stream changes:<type>
  aggregateid   text NOT NULL,    -- entity UUID
  payload       jsonb NOT NULL    -- see packages/protocol/schema/outbox-event.v1.json
);

-- Gapless, commit-ordered sequence number per entity type.
-- The replicator does UPDATE ... SET seq = seq + 1 ... RETURNING seq inside the entity transaction.
-- The row lock serializes writers of one type, which is what makes the sequence gapless.
CREATE TABLE entity_type_sequence (
  entity_type text PRIMARY KEY,
  seq         bigint NOT NULL DEFAULT 0
);
INSERT INTO entity_type_sequence (entity_type) VALUES
  ('countries'), ('connections'), ('airports'), ('airplanes');

-- Publication containing ONLY the outbox table (Debezium publication.autocreate.mode=disabled).
CREATE PUBLICATION atlas_outbox FOR TABLE outbox;

-- Write lockdown: only atlas_writer may change entity tables and the outbox.
GRANT USAGE ON SCHEMA public TO atlas_writer, atlas_reader, debezium;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO atlas_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO atlas_writer;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO atlas_writer;
GRANT SELECT ON outbox TO debezium;

-- Debezium stores its read position here (JDBC offset store), so it survives a total Redis loss.
CREATE TABLE debezium_offsets (
  id               text PRIMARY KEY,
  offset_key       text,
  offset_val       text,
  record_insert_ts timestamp NOT NULL,
  record_insert_seq integer NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON debezium_offsets TO debezium;
