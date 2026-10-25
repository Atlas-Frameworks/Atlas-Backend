\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE entity_type text;
BEGIN
  FOREACH entity_type IN ARRAY ARRAY[
    'w_campaigns', 'w_missions', 'w_plans',
    'a_plans', 'a_missions', 'a_objectives', 'orders'
  ] LOOP
    ASSERT to_regclass(format('benchmark_publisher.%I', entity_type)) IS NOT NULL,
      format('publisher table %s is missing', entity_type);
    ASSERT to_regclass(format('benchmark_debezium.%I', entity_type)) IS NOT NULL,
      format('debezium table %s is missing', entity_type);
    ASSERT to_regclass(format('benchmark_publisher.%I_outbox', entity_type)) IS NOT NULL,
      format('publisher outbox %s is missing', entity_type);
    ASSERT to_regclass(format('benchmark_debezium.%I_outbox', entity_type)) IS NOT NULL,
      format('debezium outbox %s is missing', entity_type);
  END LOOP;
  ASSERT to_regclass('benchmark_publisher.customers') IS NULL, 'legacy customers table still exists';
  ASSERT to_regclass('benchmark_publisher.items') IS NULL, 'legacy items table still exists';
  ASSERT to_regclass('benchmark_publisher.distributors') IS NULL, 'legacy distributors table still exists';
END;
$$;

INSERT INTO benchmark_publisher.w_campaigns (id, name, number, status, country, sequence)
VALUES (
  '90000000-0000-4000-8000-000000000001', 'Synchronization Test', 9001,
  'ACTIVE', 'IL', nextval('benchmark_publisher.replicator_sequence')
);

DO $$
DECLARE event_payload jsonb;
BEGIN
  SELECT payload INTO event_payload
  FROM benchmark_publisher.w_campaigns_outbox
  WHERE entity_id = '90000000-0000-4000-8000-000000000001'
  ORDER BY event_id DESC LIMIT 1;
  ASSERT event_payload ->> 'type' = 'w_campaigns', 'publisher event type is incorrect';
  ASSERT event_payload ->> 'op' = 'upsert', 'publisher operation is incorrect';
END;
$$;

INSERT INTO benchmark_debezium.a_plans (id, name, number, status, country, sequence)
VALUES ('90000000-0000-4000-8000-000000000002', 'Debezium Test', 9002, 'ACTIVE', 'US', 1);

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM benchmark_debezium.entity_type_sequence
    WHERE entity_type = 'a_plans' AND seq >= 1
  ), 'Debezium type sequence was not advanced';
END;
$$;

ROLLBACK;
