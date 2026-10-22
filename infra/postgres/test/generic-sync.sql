\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  ASSERT to_regprocedure('public.build_entity_changes(jsonb,jsonb)') IS NULL,
    'public must not contain synchronization diff functions';
  ASSERT to_regprocedure('public.register_synced_table(regclass,text)') IS NULL,
    'public must not contain Publisher registration functions';
  ASSERT has_function_privilege(
    'atlas_publisher',
    'benchmark_publisher.claim_sync_events(text,text,integer,integer)',
    'EXECUTE'
  ), 'publisher role must be allowed to claim events';
  ASSERT NOT has_function_privilege(
    'atlas_writer',
    'benchmark_publisher.claim_sync_events(text,text,integer,integer)',
    'EXECUTE'
  ), 'writer role must not be allowed to claim events';
END;
$$;

CREATE TABLE benchmark_publisher.publisher_test_entities (
  id uuid PRIMARY KEY,
  label text NOT NULL,
  enabled boolean NOT NULL,
  sequence bigint NOT NULL
);
SELECT benchmark_publisher.register_synced_table(
  'benchmark_publisher.publisher_test_entities'
);

INSERT INTO benchmark_publisher.publisher_test_entities (id, label, enabled, sequence)
VALUES ('00000000-0000-0000-0000-000000000102', 'first', true, 1);

UPDATE benchmark_publisher.publisher_test_entities
SET label = 'second', sequence = 10
WHERE id = '00000000-0000-0000-0000-000000000102';

UPDATE benchmark_publisher.publisher_test_entities
SET label = 'second', sequence = 11
WHERE id = '00000000-0000-0000-0000-000000000102';

DELETE FROM benchmark_publisher.publisher_test_entities
WHERE id = '00000000-0000-0000-0000-000000000102';

DO $$
DECLARE
  insert_event jsonb;
  update_event jsonb;
  no_op_event jsonb;
  delete_event jsonb;
BEGIN
  SELECT payload INTO insert_event FROM benchmark_publisher.publisher_test_entities_outbox WHERE event_id = 1;
  SELECT payload INTO update_event FROM benchmark_publisher.publisher_test_entities_outbox WHERE event_id = 2;
  SELECT payload INTO no_op_event FROM benchmark_publisher.publisher_test_entities_outbox WHERE event_id = 3;
  SELECT payload INTO delete_event FROM benchmark_publisher.publisher_test_entities_outbox WHERE event_id = 4;

  ASSERT (SELECT count(*) FROM benchmark_publisher.publisher_test_entities_outbox) = 4,
    'expected four durable events';
  ASSERT NOT insert_event ? 'typeSeq',
    'business writes must not allocate typeSeq';
  ASSERT insert_event ->> 'schema' = '3',
    'insert must use event schema 3';
  ASSERT insert_event ->> 'sequence' = '1',
    'insert must contain the source sequence';
  ASSERT insert_event -> 'changes' -> 'old' = '{}'::jsonb,
    'insert old values must be empty';
  ASSERT insert_event -> 'changes' -> 'new' =
    '{"label": "first", "enabled": true}'::jsonb,
    'insert must contain every business field';
  ASSERT update_event -> 'changes' -> 'old' = '{"label": "first"}'::jsonb,
    'update must contain only the old changed value';
  ASSERT update_event -> 'changes' -> 'new' = '{"label": "second"}'::jsonb,
    'update must contain only the new changed value';
  ASSERT no_op_event -> 'changes' = '{"old": {}, "new": {}}'::jsonb,
    'no-op update must still emit an empty diff';
  ASSERT no_op_event ->> 'sequence' = '11',
    'no-op update must contain the injected source sequence';
  ASSERT delete_event ->> 'op' = 'delete',
    'delete operation missing';
  ASSERT NOT delete_event ? 'changes',
    'delete must not contain changes';
  ASSERT NOT delete_event ? 'sequence',
    'delete must not contain a source sequence';
END;
$$;

CREATE TEMP TABLE claimed_test_events AS
SELECT * FROM benchmark_publisher.claim_sync_events(
  'publisher_test_entities',
  'publisher-a',
  100,
  30
);

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM claimed_test_events) = 4,
    'publisher must claim all events';
  ASSERT (SELECT array_agg((payload ->> 'typeSeq')::bigint ORDER BY event_id)
          FROM claimed_test_events) = ARRAY[1, 2, 3, 4]::bigint[],
    'publisher must allocate a gapless batch sequence';
  ASSERT (SELECT last_sequence
          FROM benchmark_publisher.publisher_test_entities_sync_state
          WHERE singleton) = 4,
    'entity state table must persist the allocated sequence';
  ASSERT NOT EXISTS (
    SELECT 1 FROM benchmark_publisher.claim_sync_events(
      'publisher_test_entities',
      'publisher-b',
      100,
      30
    )
  ), 'another publisher must not take over an active lease';
  ASSERT benchmark_publisher.mark_sync_events_published(
    'publisher_test_entities',
    'publisher-a',
    ARRAY(SELECT event_id FROM claimed_test_events)
  ) = 4, 'publisher must delete its published events';
  ASSERT NOT EXISTS (
    SELECT 1 FROM benchmark_publisher.claim_sync_events(
      'publisher_test_entities',
      'publisher-a',
      100,
      30
    )
  ), 'published events must not be claimed again';
  ASSERT NOT EXISTS (
    SELECT 1 FROM benchmark_publisher.publisher_test_entities_outbox
  ), 'published events must not remain in the outbox';
END;
$$;

ROLLBACK;
