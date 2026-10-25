-- In-transaction sequence allocation and transient outbox used by Debezium.

CREATE OR REPLACE FUNCTION benchmark_debezium.build_entity_changes(
  p_old_row jsonb,
  p_new_row jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  WITH rows AS (
    SELECT
      COALESCE(p_old_row, '{}'::jsonb) - ARRAY['id', 'sequence', 'updated_at'] AS old_row,
      COALESCE(p_new_row, '{}'::jsonb) - ARRAY['id', 'sequence', 'updated_at'] AS new_row
  ), changed_keys AS (
    SELECT key
    FROM rows,
         LATERAL jsonb_object_keys(old_row || new_row) AS all_keys(key)
    WHERE old_row -> key IS DISTINCT FROM new_row -> key
  )
  SELECT jsonb_build_object(
    'old', COALESCE(
      jsonb_object_agg(key, old_row -> key) FILTER (WHERE old_row ? key),
      '{}'::jsonb
    ),
    'new', COALESCE(
      jsonb_object_agg(key, new_row -> key) FILTER (WHERE new_row ? key),
      '{}'::jsonb
    )
  )
  FROM rows
  LEFT JOIN changed_keys ON true;
$$;

CREATE TABLE IF NOT EXISTS benchmark_debezium.entity_type_sequence (
  entity_type text PRIMARY KEY,
  seq bigint NOT NULL DEFAULT 0 CHECK (seq >= 0)
);

DELETE FROM benchmark_debezium.entity_type_sequence
WHERE entity_type IN ('customers', 'items', 'delivery_companies', 'distributors');

INSERT INTO benchmark_debezium.entity_type_sequence (entity_type)
VALUES
  ('w_campaigns'), ('w_missions'), ('w_plans'),
  ('a_plans'), ('a_missions'), ('a_objectives'), ('orders')
ON CONFLICT (entity_type) DO NOTHING;

CREATE OR REPLACE FUNCTION benchmark_debezium.validate_entity_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.sequence IS NULL OR NEW.sequence < 1 THEN
    RAISE EXCEPTION 'A synchronized entity requires a positive source sequence';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Changing the id of a synchronized entity is not supported';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.sequence <= OLD.sequence THEN
    RAISE EXCEPTION 'Source sequence must increase: old %, new %', OLD.sequence, NEW.sequence;
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
  entity_sequence bigint;
  event_sequence bigint;
  event_id uuid := gen_random_uuid();
BEGIN
  entity_id := COALESCE(new_row ->> 'id', old_row ->> 'id')::uuid;
  entity_sequence := CASE
    WHEN TG_OP = 'DELETE' THEN NULL
    ELSE (new_row ->> 'sequence')::bigint
  END;

  UPDATE benchmark_debezium.entity_type_sequence AS sequence
  SET seq = sequence.seq + 1
  WHERE sequence.entity_type = resolved_entity_type
  RETURNING seq INTO event_sequence;

  IF event_sequence IS NULL THEN
    RAISE EXCEPTION 'Missing entity_type_sequence row for %', resolved_entity_type;
  END IF;

  EXECUTE format(
    'INSERT INTO %s (id, aggregatetype, aggregateid, payload)
     VALUES ($1, $2, $3, $4)',
    outbox_table
  ) USING
    event_id,
    resolved_entity_type,
    entity_id::text,
    jsonb_build_object(
      'schema', 3,
      'type', resolved_entity_type,
      'id', entity_id,
      'op', CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END,
      'typeSeq', event_sequence,
      'committedAt', clock_timestamp()
    ) || CASE
      WHEN TG_OP = 'DELETE' THEN '{}'::jsonb
      ELSE jsonb_build_object(
        'sequence', entity_sequence,
        'changes', benchmark_debezium.build_entity_changes(old_row, new_row)
      )
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
  FOREACH entity_type IN ARRAY ARRAY[
    'w_campaigns',
    'w_missions',
    'w_plans',
    'a_plans',
    'a_missions',
    'a_objectives',
    'orders'
  ] LOOP
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
      'DROP TRIGGER IF EXISTS atlas_manage_version ON benchmark_debezium.%I',
      entity_type
    );
    EXECUTE format(
      'DROP TRIGGER IF EXISTS atlas_validate_sequence ON benchmark_debezium.%I',
      entity_type
    );
    EXECUTE format(
      'DROP TRIGGER IF EXISTS atlas_sync_change ON benchmark_debezium.%I',
      entity_type
    );
    EXECUTE format(
      'CREATE TRIGGER atlas_validate_sequence
       BEFORE INSERT OR UPDATE ON benchmark_debezium.%I
       FOR EACH ROW EXECUTE FUNCTION benchmark_debezium.validate_entity_sequence()',
      entity_type
    );
    EXECUTE format(
      'CREATE TRIGGER atlas_sync_change
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

-- All synchronization behavior is now schema-local. These legacy shared
-- functions are removed only after both pipelines have replaced their triggers.
DROP FUNCTION IF EXISTS public.register_synced_table(regclass, text);
DROP FUNCTION IF EXISTS public.sync_entity_change();
DROP FUNCTION IF EXISTS public.validate_entity_sequence();
DROP FUNCTION IF EXISTS public.build_entity_changes(jsonb, jsonb);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'benchmark_debezium_outbox'
  ) THEN
    CREATE PUBLICATION benchmark_debezium_outbox FOR TABLE
      benchmark_debezium.w_campaigns_outbox,
      benchmark_debezium.w_missions_outbox,
      benchmark_debezium.w_plans_outbox,
      benchmark_debezium.a_plans_outbox,
      benchmark_debezium.a_missions_outbox,
      benchmark_debezium.a_objectives_outbox,
      benchmark_debezium.orders_outbox;
  ELSE
    ALTER PUBLICATION benchmark_debezium_outbox SET TABLE
      benchmark_debezium.w_campaigns_outbox,
      benchmark_debezium.w_missions_outbox,
      benchmark_debezium.w_plans_outbox,
      benchmark_debezium.a_plans_outbox,
      benchmark_debezium.a_missions_outbox,
      benchmark_debezium.a_objectives_outbox,
      benchmark_debezium.orders_outbox;
  END IF;
END;
$$;
