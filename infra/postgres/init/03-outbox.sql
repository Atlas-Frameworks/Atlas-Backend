-- Durable, per-entity outboxes. Business writes only append raw events; publishers
-- allocate ordered event sequences after commit and deliver them to Redis.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_publisher') THEN
    CREATE ROLE atlas_publisher WITH LOGIN PASSWORD 'atlas_publisher';
  END IF;
END;
$$;

-- Remove the old signatures before creating the schema-aware functions. Leaving
-- them installed would keep the legacy public registry callable by mistake.
DROP FUNCTION IF EXISTS public.claim_sync_events(text, text, integer, integer);
DROP FUNCTION IF EXISTS public.mark_sync_events_published(text, text, bigint[]);
DROP FUNCTION IF EXISTS public.claim_sync_events(text, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.mark_sync_events_published(text, text, text, bigint[]);

-- Every entity owns a <entity_type>_sync_state table in its source schema.
-- Publishers access state and outboxes only through SECURITY DEFINER functions,
-- so they cannot mutate application tables or arbitrary events.
CREATE OR REPLACE FUNCTION benchmark_publisher.claim_sync_events(
  p_entity_type text,
  p_publisher_owner text,
  p_batch_size integer,
  p_lease_seconds integer DEFAULT 30
)
RETURNS TABLE (
  event_id bigint,
  entity_id text,
  payload jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, benchmark_publisher
AS $$
DECLARE
  state_table regclass;
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

  state_table := to_regclass(format('%I.%I', 'benchmark_publisher', p_entity_type || '_sync_state'));
  IF state_table IS NULL THEN
    RAISE EXCEPTION 'Unknown synchronized entity type benchmark_publisher.%', p_entity_type;
  END IF;

  EXECUTE format(
    'SELECT state.outbox_table,
            state.last_sequence,
            state.publisher_owner,
            state.publisher_lease_until
     FROM %s AS state
     WHERE state.singleton
     FOR UPDATE',
    state_table
  )
  INTO outbox_table, current_sequence, current_owner, lease_until;

  IF outbox_table IS NULL THEN
    RAISE EXCEPTION 'Synchronization state is missing for benchmark_publisher.%', p_entity_type;
  END IF;
  IF current_owner IS DISTINCT FROM p_publisher_owner AND lease_until > clock_timestamp() THEN
    RETURN;
  END IF;

  EXECUTE format(
    'UPDATE %s
     SET publisher_owner = $1,
         publisher_lease_until = clock_timestamp() + make_interval(secs => $2)
     WHERE singleton',
    state_table
  ) USING p_publisher_owner, p_lease_seconds;

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

  EXECUTE format(
    'UPDATE %s
     SET last_sequence = $1
     WHERE singleton',
    state_table
  ) USING current_sequence + assigned_count;

  RETURN QUERY EXECUTE format(
    'SELECT pending.event_id,
            pending.entity_id,
            pending.payload || jsonb_build_object(''typeSeq'', pending.event_sequence)
     FROM %s AS pending
     WHERE pending.published_at IS NULL
     ORDER BY pending.event_sequence
     LIMIT $1',
    outbox_table
  ) USING p_batch_size;
END;
$$;

CREATE OR REPLACE FUNCTION benchmark_publisher.mark_sync_events_published(
  p_entity_type text,
  p_publisher_owner text,
  p_event_ids bigint[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, benchmark_publisher
AS $$
DECLARE
  state_table regclass;
  outbox_table regclass;
  active_owner text;
  updated_count integer;
BEGIN
  state_table := to_regclass(format('%I.%I', 'benchmark_publisher', p_entity_type || '_sync_state'));
  IF state_table IS NULL THEN
    RAISE EXCEPTION 'Unknown synchronized entity type benchmark_publisher.%', p_entity_type;
  END IF;

  EXECUTE format(
    'SELECT state.outbox_table, state.publisher_owner
     FROM %s AS state
     WHERE state.singleton
     FOR UPDATE',
    state_table
  )
  INTO outbox_table, active_owner;

  IF outbox_table IS NULL THEN
    RAISE EXCEPTION 'Synchronization state is missing for benchmark_publisher.%', p_entity_type;
  END IF;
  IF active_owner IS DISTINCT FROM p_publisher_owner THEN
    RAISE EXCEPTION 'Publisher % does not own entity type benchmark_publisher.%',
      p_publisher_owner,
      p_entity_type;
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

REVOKE ALL ON FUNCTION benchmark_publisher.claim_sync_events(text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION benchmark_publisher.mark_sync_events_published(text, text, bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION benchmark_publisher.claim_sync_events(text, text, integer, integer) TO atlas_publisher;
GRANT EXECUTE ON FUNCTION benchmark_publisher.mark_sync_events_published(text, text, bigint[]) TO atlas_publisher;
