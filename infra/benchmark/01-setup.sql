-- Isolated relay benchmark. This file never changes the commerce tables.

CREATE SCHEMA IF NOT EXISTS benchmark_publisher;
CREATE SCHEMA IF NOT EXISTS benchmark_debezium;

GRANT USAGE ON SCHEMA benchmark_publisher TO atlas_writer, atlas_reader, atlas_publisher;
GRANT USAGE ON SCHEMA benchmark_debezium TO atlas_writer, atlas_reader, debezium;

DO $$
DECLARE
  entity_type text;
BEGIN
  FOREACH entity_type IN ARRAY ARRAY['customers', 'items', 'orders', 'distributors'] LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS benchmark_publisher.%I (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         data jsonb NOT NULL DEFAULT ''{}''::jsonb,
         version bigint NOT NULL DEFAULT 1,
         updated_at timestamptz NOT NULL DEFAULT now()
       )',
      entity_type
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS benchmark_debezium.%I (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         data jsonb NOT NULL DEFAULT ''{}''::jsonb,
         version bigint NOT NULL DEFAULT 1,
         updated_at timestamptz NOT NULL DEFAULT now()
       )',
      entity_type
    );

    EXECUTE format(
      'INSERT INTO benchmark_publisher.%I (data)
       SELECT jsonb_build_object(''seed'', seed_number)
       FROM generate_series(1, 1000) AS seeds(seed_number)
       WHERE NOT EXISTS (SELECT 1 FROM benchmark_publisher.%I)',
      entity_type,
      entity_type
    );
    EXECUTE format(
      'INSERT INTO benchmark_debezium.%I (data)
       SELECT jsonb_build_object(''seed'', seed_number)
       FROM generate_series(1, 1000) AS seeds(seed_number)
       WHERE NOT EXISTS (SELECT 1 FROM benchmark_debezium.%I)',
      entity_type,
      entity_type
    );

    PERFORM register_synced_table(
      format('benchmark_publisher.%I', entity_type)::regclass,
      'benchmark_publisher_' || entity_type
    );
    EXECUTE format(
      'GRANT SELECT ON benchmark_publisher.%I TO atlas_writer',
      entity_type || '_outbox'
    );
  END LOOP;
END;
$$;

CREATE TABLE IF NOT EXISTS benchmark_debezium.entity_type_sequence (
  entity_type text PRIMARY KEY,
  seq bigint NOT NULL DEFAULT 0
);

INSERT INTO benchmark_debezium.entity_type_sequence (entity_type)
VALUES ('customers'), ('items'), ('orders'), ('distributors')
ON CONFLICT (entity_type) DO NOTHING;

CREATE OR REPLACE FUNCTION benchmark_debezium.manage_entity_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
  ELSE
    NEW.version := OLD.version + 1;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION benchmark_debezium.capture_entity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_entity_type text := TG_ARGV[0];
  outbox_table regclass := TG_ARGV[1]::regclass;
  old_row jsonb := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  entity_id uuid;
  entity_version bigint;
  event_sequence bigint;
  event_id uuid := gen_random_uuid();
BEGIN
  entity_id := COALESCE(new_row ->> 'id', old_row ->> 'id')::uuid;
  entity_version := COALESCE(new_row ->> 'version', old_row ->> 'version')::bigint;

  UPDATE benchmark_debezium.entity_type_sequence AS sequence
  SET seq = sequence.seq + 1
  WHERE sequence.entity_type = resolved_entity_type
  RETURNING seq INTO event_sequence;

  EXECUTE format(
    'INSERT INTO %s (id, aggregatetype, aggregateid, payload)
     VALUES ($1, $2, $3, $4)',
    outbox_table
  ) USING
    event_id,
    resolved_entity_type,
    entity_id::text,
    jsonb_build_object(
      'schema', 2,
      'type', resolved_entity_type,
      'id', entity_id,
      'op', CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END,
      'version', entity_version,
      'typeSeq', event_sequence,
      'committedAt', clock_timestamp()
    ) || CASE
      WHEN TG_OP = 'DELETE' THEN '{}'::jsonb
      ELSE jsonb_build_object('changes', public.build_entity_changes(old_row, new_row))
    END;

  EXECUTE format('DELETE FROM %s WHERE id = $1', outbox_table) USING event_id;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DO $$
DECLARE
  entity_type text;
  outbox_name text;
BEGIN
  FOREACH entity_type IN ARRAY ARRAY['customers', 'items', 'orders', 'distributors'] LOOP
    outbox_name := entity_type || '_outbox';
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS benchmark_debezium.%I (
         id uuid PRIMARY KEY,
         aggregatetype text NOT NULL,
         aggregateid text NOT NULL,
         payload jsonb NOT NULL
       )',
      outbox_name
    );

    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON benchmark_debezium.%I TO atlas_writer',
      entity_type
    );
    EXECUTE format('GRANT SELECT ON benchmark_debezium.%I TO atlas_reader', entity_type);
    EXECUTE format(
      'GRANT SELECT, INSERT, DELETE ON benchmark_debezium.%I TO atlas_writer',
      outbox_name
    );
    EXECUTE format('GRANT SELECT ON benchmark_debezium.%I TO debezium', outbox_name);

    EXECUTE format(
      'DROP TRIGGER IF EXISTS benchmark_manage_version ON benchmark_debezium.%I',
      entity_type
    );
    EXECUTE format(
      'DROP TRIGGER IF EXISTS benchmark_capture_change ON benchmark_debezium.%I',
      entity_type
    );
    EXECUTE format(
      'CREATE TRIGGER benchmark_manage_version
       BEFORE INSERT OR UPDATE ON benchmark_debezium.%I
       FOR EACH ROW EXECUTE FUNCTION benchmark_debezium.manage_entity_version()',
      entity_type
    );
    EXECUTE format(
      'CREATE TRIGGER benchmark_capture_change
       AFTER INSERT OR UPDATE OR DELETE ON benchmark_debezium.%I
       FOR EACH ROW EXECUTE FUNCTION benchmark_debezium.capture_entity_change(%L, %L)',
      entity_type,
      entity_type,
      format('benchmark_debezium.%I', outbox_name)
    );
  END LOOP;
END;
$$;

GRANT SELECT, UPDATE ON benchmark_debezium.entity_type_sequence TO atlas_writer;

CREATE TABLE IF NOT EXISTS benchmark_debezium.debezium_offsets (
  id text PRIMARY KEY,
  offset_key text,
  offset_val text,
  record_insert_ts timestamp NOT NULL,
  record_insert_seq integer NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON benchmark_debezium.debezium_offsets TO debezium;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'benchmark_debezium_outbox'
  ) THEN
    CREATE PUBLICATION benchmark_debezium_outbox FOR TABLE
      benchmark_debezium.customers_outbox,
      benchmark_debezium.items_outbox,
      benchmark_debezium.orders_outbox,
      benchmark_debezium.distributors_outbox;
  END IF;
END;
$$;
