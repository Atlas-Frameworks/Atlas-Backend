-- Generic entity synchronization. This file has no dependency on application
-- tables. Register each application table after creating it with
-- register_synced_table(); its changes then flow through outbox -> Debezium -> Redis.

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
      COALESCE(p_old_row, '{}'::jsonb) - ARRAY['id', 'version', 'updated_at'] AS old_row,
      COALESCE(p_new_row, '{}'::jsonb) - ARRAY['id', 'version', 'updated_at'] AS new_row
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

CREATE OR REPLACE FUNCTION manage_entity_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'Changing the id of a synchronized entity is not supported';
    END IF;
    NEW.version := OLD.version + 1;
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
  old_row jsonb := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  entity_id uuid;
  entity_version bigint;
  event_sequence bigint;
  outbox_id bigint;
BEGIN
  entity_id := COALESCE(new_row ->> 'id', old_row ->> 'id')::uuid;
  entity_version := COALESCE(new_row ->> 'version', old_row ->> 'version')::bigint;

  UPDATE entity_type_sequence AS sequence
  SET seq = sequence.seq + 1
  WHERE sequence.entity_type = resolved_entity_type
  RETURNING sequence.seq INTO event_sequence;

  IF event_sequence IS NULL THEN
    RAISE EXCEPTION 'Missing entity_type_sequence row for %', resolved_entity_type;
  END IF;

  INSERT INTO outbox (aggregatetype, aggregateid, payload)
  VALUES (
    resolved_entity_type,
    entity_id::text,
    jsonb_build_object(
      'schema', 2,
      'type', resolved_entity_type,
      'id', entity_id,
      'op', CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END,
      'version', entity_version,
      'typeSeq', event_sequence,
      'committedAt', now()
    ) || CASE
      WHEN TG_OP = 'DELETE' THEN '{}'::jsonb
      ELSE jsonb_build_object('changes', build_entity_changes(old_row, new_row))
    END
  )
  RETURNING id INTO outbox_id;

  DELETE FROM outbox WHERE id = outbox_id;
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

  EXECUTE format(
    'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1',
    schema_name,
    table_name
  );
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

  INSERT INTO entity_type_sequence (entity_type)
  VALUES (resolved_entity_type)
  ON CONFLICT (entity_type) DO NOTHING;

  EXECUTE format('DROP TRIGGER IF EXISTS atlas_manage_version ON %I.%I', schema_name, table_name);
  EXECUTE format('DROP TRIGGER IF EXISTS atlas_sync_change ON %I.%I', schema_name, table_name);
  EXECUTE format(
    'CREATE TRIGGER atlas_manage_version BEFORE INSERT OR UPDATE ON %I.%I '
    'FOR EACH ROW EXECUTE FUNCTION manage_entity_version()',
    schema_name,
    table_name
  );
  EXECUTE format(
    'CREATE TRIGGER atlas_sync_change AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
    'FOR EACH ROW EXECUTE FUNCTION sync_entity_change(%L)',
    schema_name,
    table_name,
    resolved_entity_type
  );
END;
$$;
