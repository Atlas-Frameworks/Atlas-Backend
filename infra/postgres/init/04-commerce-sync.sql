-- Generic entity synchronization. Each registered application table receives a
-- durable, entity-specific outbox. Sequence allocation happens after commit in
-- the publisher and never blocks the business transaction.

CREATE OR REPLACE FUNCTION build_entity_changes(
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

CREATE OR REPLACE FUNCTION validate_entity_sequence()
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

CREATE OR REPLACE FUNCTION sync_entity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_entity_type text := TG_ARGV[0];
  resolved_outbox_table regclass := TG_ARGV[1]::regclass;
  old_row jsonb := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  entity_id uuid;
  entity_sequence bigint;
BEGIN
  entity_id := COALESCE(new_row ->> 'id', old_row ->> 'id')::uuid;
  entity_sequence := CASE
    WHEN TG_OP = 'DELETE' THEN NULL
    ELSE (new_row ->> 'sequence')::bigint
  END;

  EXECUTE format(
    'INSERT INTO %s (aggregate_id, payload) VALUES ($1, $2)',
    resolved_outbox_table
  ) USING
    entity_id::text,
    jsonb_build_object(
      'schema', 3,
      'type', resolved_entity_type,
      'id', entity_id,
      'op', CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END,
      'committedAt', clock_timestamp()
    ) || CASE
      WHEN TG_OP = 'DELETE' THEN '{}'::jsonb
      ELSE jsonb_build_object(
        'sequence', entity_sequence,
        'changes', build_entity_changes(old_row, new_row)
      )
    END;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION register_synced_table(
  p_table regclass,
  p_entity_type text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  schema_name text;
  table_name text;
  resolved_entity_type text;
  outbox_name text;
  qualified_outbox_name text;
  outbox_table regclass;
BEGIN
  SELECT namespace.nspname, class.relname
  INTO schema_name, table_name
  FROM pg_class AS class
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  WHERE class.oid = p_table
    AND class.relkind IN ('r', 'p');

  IF table_name IS NULL THEN
    RAISE EXCEPTION '% is not a table', p_table;
  END IF;

  resolved_entity_type := COALESCE(p_entity_type, table_name);
  outbox_name := table_name || '_outbox';
  qualified_outbox_name := format('%I.%I', schema_name, outbox_name);

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = p_table
      AND attname = 'id'
      AND atttypid = 'uuid'::regtype
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Synchronized table %.% must have an id uuid column', schema_name, table_name;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = p_table
      AND attname = 'sequence'
      AND atttypid = 'bigint'::regtype
      AND attnotnull
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Synchronized table %.% must have a non-null sequence bigint column',
      schema_name, table_name;
  END IF;
  EXECUTE format(
    'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()',
    schema_name,
    table_name
  );

  EXECUTE format('GRANT SELECT ON %I.%I TO atlas_reader', schema_name, table_name);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO atlas_writer',
    schema_name,
    table_name
  );

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %s (
       event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       aggregate_id text NOT NULL,
       payload jsonb NOT NULL,
       event_sequence bigint UNIQUE,
       published_at timestamptz,
       created_at timestamptz NOT NULL DEFAULT clock_timestamp()
     )',
    qualified_outbox_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %s (event_sequence NULLS FIRST, event_id)
     WHERE published_at IS NULL',
    outbox_name || '_pending_idx',
    qualified_outbox_name
  );
  EXECUTE format('GRANT INSERT ON %s TO atlas_writer', qualified_outbox_name);
  outbox_table := qualified_outbox_name::regclass;

  INSERT INTO synchronized_entity_types (entity_type, source_table, outbox_table)
  VALUES (resolved_entity_type, p_table, outbox_table)
  ON CONFLICT (entity_type) DO UPDATE
  SET source_table = EXCLUDED.source_table,
      outbox_table = EXCLUDED.outbox_table;

  EXECUTE format('DROP TRIGGER IF EXISTS atlas_manage_version ON %I.%I', schema_name, table_name);
  EXECUTE format('DROP TRIGGER IF EXISTS atlas_validate_sequence ON %I.%I', schema_name, table_name);
  EXECUTE format('DROP TRIGGER IF EXISTS atlas_sync_change ON %I.%I', schema_name, table_name);
  EXECUTE format(
    'CREATE TRIGGER atlas_validate_sequence BEFORE INSERT OR UPDATE ON %I.%I '
    'FOR EACH ROW EXECUTE FUNCTION validate_entity_sequence()',
    schema_name,
    table_name
  );
  EXECUTE format(
    'CREATE TRIGGER atlas_sync_change AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
    'FOR EACH ROW EXECUTE FUNCTION sync_entity_change(%L, %L)',
    schema_name,
    table_name,
    resolved_entity_type,
    qualified_outbox_name
  );
END;
$$;
