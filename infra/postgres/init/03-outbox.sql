-- Durable, per-entity outboxes. Business writes only append raw events; publishers
-- allocate ordered event sequences after commit and deliver them to Redis.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_publisher') THEN
    CREATE ROLE atlas_publisher WITH LOGIN PASSWORD 'atlas_publisher';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS synchronized_entity_types (
  entity_type           text PRIMARY KEY,
  source_table          regclass NOT NULL UNIQUE,
  outbox_table          regclass NOT NULL UNIQUE,
  last_sequence         bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  publisher_owner       text,
  publisher_lease_until timestamptz
);

-- Publishers access entity-specific outboxes only through SECURITY DEFINER
-- functions, so they cannot mutate application tables or arbitrary events.
CREATE OR REPLACE FUNCTION claim_sync_events(
  p_entity_type text,
  p_publisher_owner text,
  p_batch_size integer,
  p_lease_seconds integer DEFAULT 30
)
RETURNS TABLE (
  event_id bigint,
  aggregate_id text,
  payload jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  outbox_table regclass;
  current_sequence bigint;
  current_owner text;
  lease_until timestamptz;
  assigned_count bigint;
BEGIN
  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'Batch size must be between 1 and 10000';
  END IF;
  IF p_lease_seconds < 1 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'Lease duration must be between 1 and 300 seconds';
  END IF;
  IF NULLIF(btrim(p_publisher_owner), '') IS NULL THEN
    RAISE EXCEPTION 'Publisher owner must not be empty';
  END IF;

  SELECT
    registry.outbox_table,
    registry.last_sequence,
    registry.publisher_owner,
    registry.publisher_lease_until
  INTO outbox_table, current_sequence, current_owner, lease_until
  FROM synchronized_entity_types AS registry
  WHERE registry.entity_type = p_entity_type
  FOR UPDATE;

  IF outbox_table IS NULL THEN
    RAISE EXCEPTION 'Unknown synchronized entity type: %', p_entity_type;
  END IF;
  IF current_owner IS DISTINCT FROM p_publisher_owner AND lease_until > clock_timestamp() THEN
    RETURN;
  END IF;

  UPDATE synchronized_entity_types
  SET publisher_owner = p_publisher_owner,
      publisher_lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds)
  WHERE entity_type = p_entity_type;

  EXECUTE format(
    'WITH selected AS MATERIALIZED (
       SELECT pending.event_id, pending.event_sequence
       FROM %s AS pending
       WHERE pending.published_at IS NULL
       ORDER BY pending.event_sequence NULLS LAST, pending.event_id
       LIMIT $1
       FOR UPDATE
     ), numbered AS (
       SELECT selected.event_id,
              row_number() OVER (ORDER BY selected.event_id) AS offset
       FROM selected
       WHERE selected.event_sequence IS NULL
     ), assigned AS (
       UPDATE %s AS pending
       SET event_sequence = $2 + numbered.offset
       FROM numbered
       WHERE pending.event_id = numbered.event_id
       RETURNING pending.event_id
     )
     SELECT count(*) FROM assigned',
    outbox_table,
    outbox_table
  )
  INTO assigned_count
  USING p_batch_size, current_sequence;

  UPDATE synchronized_entity_types
  SET last_sequence = current_sequence + assigned_count
  WHERE entity_type = p_entity_type;

  RETURN QUERY EXECUTE format(
    'SELECT pending.event_id,
            pending.aggregate_id,
            pending.payload || jsonb_build_object(''typeSeq'', pending.event_sequence)
     FROM %s AS pending
     WHERE pending.published_at IS NULL
     ORDER BY pending.event_sequence
     LIMIT $1',
    outbox_table
  ) USING p_batch_size;
END;
$$;

CREATE OR REPLACE FUNCTION mark_sync_events_published(
  p_entity_type text,
  p_publisher_owner text,
  p_event_ids bigint[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  outbox_table regclass;
  active_owner text;
  updated_count integer;
BEGIN
  SELECT registry.outbox_table, registry.publisher_owner
  INTO outbox_table, active_owner
  FROM synchronized_entity_types AS registry
  WHERE registry.entity_type = p_entity_type
  FOR UPDATE;

  IF outbox_table IS NULL THEN
    RAISE EXCEPTION 'Unknown synchronized entity type: %', p_entity_type;
  END IF;
  IF active_owner IS DISTINCT FROM p_publisher_owner THEN
    RAISE EXCEPTION 'Publisher % does not own entity type %', p_publisher_owner, p_entity_type;
  END IF;

  EXECUTE format(
    'DELETE FROM %s
     WHERE event_id = ANY($1)
       AND published_at IS NULL',
    outbox_table
  ) USING p_event_ids;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

GRANT SELECT ON synchronized_entity_types TO atlas_reader;
GRANT SELECT ON synchronized_entity_types TO atlas_publisher;
REVOKE ALL ON FUNCTION claim_sync_events(text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_sync_events_published(text, text, bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_sync_events(text, text, integer, integer) TO atlas_publisher;
GRANT EXECUTE ON FUNCTION mark_sync_events_published(text, text, bigint[]) TO atlas_publisher;
