-- Attach Publisher synchronization to the mutable W/A domain entities.

SELECT benchmark_publisher.register_synced_table('benchmark_publisher.w_campaigns', 'w_campaigns');
SELECT benchmark_publisher.register_synced_table('benchmark_publisher.w_missions', 'w_missions');
SELECT benchmark_publisher.register_synced_table('benchmark_publisher.w_plans', 'w_plans');
SELECT benchmark_publisher.register_synced_table('benchmark_publisher.a_plans', 'a_plans');
SELECT benchmark_publisher.register_synced_table('benchmark_publisher.a_missions', 'a_missions');
SELECT benchmark_publisher.register_synced_table('benchmark_publisher.a_objectives', 'a_objectives');
SELECT benchmark_publisher.register_synced_table('benchmark_publisher.orders', 'orders');

DO $$
DECLARE legacy_entity record;
BEGIN
  IF to_regclass('public.synchronized_entity_types') IS NOT NULL THEN
    FOR legacy_entity IN SELECT entity_type, source_table FROM public.synchronized_entity_types LOOP
      IF legacy_entity.source_table IS NOT NULL THEN
        PERFORM benchmark_publisher.register_synced_table(legacy_entity.source_table, legacy_entity.entity_type);
      END IF;
    END LOOP;
    DROP TABLE public.synchronized_entity_types;
  END IF;
END;
$$;
