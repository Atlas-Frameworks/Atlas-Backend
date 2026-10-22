-- Attach the post-commit Publisher flow only to its isolated environment.
-- Entity names remain schema-independent because both relays share Redis keys.

SELECT benchmark_publisher.register_synced_table('benchmark_publisher.customers', 'customers');
SELECT benchmark_publisher.register_synced_table('benchmark_publisher.items', 'items');
SELECT benchmark_publisher.register_synced_table('benchmark_publisher.orders', 'orders');
SELECT benchmark_publisher.register_synced_table('benchmark_publisher.distributors', 'distributors');

-- Migrate any additional tables that were registered before state became
-- entity-local. This prevents an existing production registration from losing
-- its last_sequence when the legacy registry is removed.
DO $$
DECLARE
  legacy_entity record;
BEGIN
  IF to_regclass('public.synchronized_entity_types') IS NOT NULL THEN
    FOR legacy_entity IN
      SELECT entity_type, source_table
      FROM public.synchronized_entity_types
    LOOP
      PERFORM benchmark_publisher.register_synced_table(
        legacy_entity.source_table,
        legacy_entity.entity_type
      );
    END LOOP;

    DROP TABLE public.synchronized_entity_types;
  END IF;
END;
$$;
