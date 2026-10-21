\set ON_ERROR_STOP on

CREATE TEMP TABLE captured_events (
  capture_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payload jsonb NOT NULL
);

CREATE FUNCTION pg_temp.capture_outbox_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO captured_events (payload) VALUES (OLD.payload);
  RETURN OLD;
END;
$$;

CREATE TRIGGER capture_outbox_event
BEFORE DELETE ON outbox
FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_outbox_event();

INSERT INTO items (id, price, type)
VALUES ('00000000-0000-0000-0000-000000000101', 10.00, 'book');

UPDATE items
SET price = 20.00
WHERE id = '00000000-0000-0000-0000-000000000101';

UPDATE items
SET price = 20.00
WHERE id = '00000000-0000-0000-0000-000000000101';

DELETE FROM items
WHERE id = '00000000-0000-0000-0000-000000000101';

CREATE TABLE test_entities (
  id uuid PRIMARY KEY,
  label text NOT NULL,
  enabled boolean NOT NULL
);
SELECT register_synced_table('public.test_entities');

INSERT INTO test_entities (id, label, enabled)
VALUES ('00000000-0000-0000-0000-000000000102', 'first', true);

UPDATE test_entities
SET label = 'second'
WHERE id = '00000000-0000-0000-0000-000000000102';

DO $$
DECLARE
  insert_event jsonb;
  update_event jsonb;
  no_op_event jsonb;
  delete_event jsonb;
  registered_insert_event jsonb;
BEGIN
  SELECT payload INTO insert_event FROM captured_events WHERE capture_id = 1;
  SELECT payload INTO update_event FROM captured_events WHERE capture_id = 2;
  SELECT payload INTO no_op_event FROM captured_events WHERE capture_id = 3;
  SELECT payload INTO delete_event FROM captured_events WHERE capture_id = 4;
  SELECT payload INTO registered_insert_event FROM captured_events WHERE capture_id = 5;

  ASSERT (SELECT count(*) FROM captured_events) = 6,
    'expected six captured events';
  ASSERT insert_event ->> 'schema' = '2',
    'insert must use event schema 2';
  ASSERT insert_event -> 'changes' -> 'old' = '{}'::jsonb,
    'insert old values must be empty';
  ASSERT insert_event -> 'changes' -> 'new' = '{"price": 10.00, "type": "book"}'::jsonb,
    'insert must contain every business field';
  ASSERT update_event -> 'changes' -> 'old' = '{"price": 10.00}'::jsonb,
    'update must contain only the old changed value';
  ASSERT update_event -> 'changes' -> 'new' = '{"price": 20.00}'::jsonb,
    'update must contain only the new changed value';
  ASSERT no_op_event -> 'changes' = '{"old": {}, "new": {}}'::jsonb,
    'no-op update must still emit an empty diff';
  ASSERT no_op_event ->> 'version' = '3',
    'no-op update must increment the version';
  ASSERT delete_event ->> 'op' = 'delete',
    'delete operation missing';
  ASSERT NOT delete_event ? 'changes',
    'delete must not contain changes';
  ASSERT registered_insert_event ->> 'type' = 'test_entities',
    'registered table must use its table name as the entity type';
  ASSERT registered_insert_event -> 'changes' -> 'new' =
    '{"label": "first", "enabled": true}'::jsonb,
    'registered table insert must contain its business fields';
  ASSERT (SELECT version FROM test_entities) = 2,
    'registered table update must increment version';
  ASSERT (SELECT seq FROM entity_type_sequence WHERE entity_type = 'items') = 4,
    'items sequence must count every event';
  ASSERT (SELECT seq FROM entity_type_sequence WHERE entity_type = 'test_entities') = 2,
    'registered table sequence must count every event';
END;
$$;
