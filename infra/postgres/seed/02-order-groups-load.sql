-- Adds 60,000 orders (30,000 per source) to the deterministic demo roots.
-- Run after 01-initial-data.sql.

DO $$
DECLARE schema_name text;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['benchmark_publisher', 'benchmark_debezium'] LOOP
    EXECUTE format($sql$
      INSERT INTO %1$I.w_missions (id, name, number, status, country, campaign_id, sequence)
      SELECT md5('W-load-mission-' || n)::uuid, 'W Load Mission ' || n, 5000 + n,
        (ARRAY['ACTIVE','PLANNED','PAUSED'])[1 + (n %% 3)], (ARRAY['IL','US','DE','FR'])[1 + (n %% 4)],
        '10000000-0000-4000-8000-000000000001', nextval('%1$I.replicator_sequence')
      FROM generate_series(1, 60) AS generated(n) ON CONFLICT (id) DO NOTHING;
      INSERT INTO %1$I.w_plans (id, name, number, status, country, category, sequence)
      SELECT md5('W-load-plan-' || n)::uuid, 'W Load Plan ' || n, 6000 + n,
        (ARRAY['ACTIVE','PLANNED','PAUSED'])[1 + (n %% 3)], (ARRAY['IL','US','DE','FR'])[1 + (n %% 4)],
        (ARRAY['AIR','SEA','GROUND'])[1 + (n %% 3)], nextval('%1$I.replicator_sequence')
      FROM generate_series(1, 600) AS generated(n) ON CONFLICT (id) DO NOTHING;
      INSERT INTO %1$I.w_mission_plans (mission_id, plan_id)
      SELECT md5('W-load-mission-' || (1 + ((n - 1) %% 60)))::uuid, md5('W-load-plan-' || n)::uuid
      FROM generate_series(1, 600) AS generated(n) ON CONFLICT DO NOTHING;
      INSERT INTO %1$I.orders (id, source, name, number, status, country, priority, amount, category, w_plan_id, a_objective_id, sequence)
      SELECT md5('W-load-order-' || n)::uuid, 'W', 'W Load Order ' || n, 100000 + n,
        (ARRAY['NEW','PROCESSING','DONE','CANCELLED'])[1 + (n %% 4)], (ARRAY['IL','US','DE','FR','GB'])[1 + (n %% 5)],
        1 + (n %% 5), (10 + (n %% 1000) * 1.25)::numeric(12,2), (ARRAY['STANDARD','EXPRESS','BULK'])[1 + (n %% 3)],
        md5('W-load-plan-' || (1 + ((n - 1) %% 600)))::uuid, NULL, nextval('%1$I.replicator_sequence')
      FROM generate_series(1, 30000) AS generated(n) ON CONFLICT (id) DO NOTHING;

      INSERT INTO %1$I.a_missions (id, name, number, status, country, a_plan_id, sequence)
      SELECT md5('A-load-mission-' || n)::uuid, 'A Load Mission ' || n, 7000 + n,
        (ARRAY['ACTIVE','PLANNED','PAUSED'])[1 + (n %% 3)], (ARRAY['IL','US','DE','FR'])[1 + (n %% 4)],
        '20000000-0000-4000-8000-000000000001', nextval('%1$I.replicator_sequence')
      FROM generate_series(1, 60) AS generated(n) ON CONFLICT (id) DO NOTHING;
      INSERT INTO %1$I.a_objectives (id, name, number, status, country, category, a_mission_id, a_plan_id, sequence)
      SELECT md5('A-load-objective-' || n)::uuid, 'A Load Objective ' || n, 8000 + n,
        (ARRAY['ACTIVE','PLANNED','PAUSED'])[1 + (n %% 3)], (ARRAY['IL','US','DE','FR'])[1 + (n %% 4)],
        (ARRAY['SALES','SUPPORT','RESEARCH'])[1 + (n %% 3)],
        md5('A-load-mission-' || (1 + ((n - 1) %% 60)))::uuid,
        '20000000-0000-4000-8000-000000000001', nextval('%1$I.replicator_sequence')
      FROM generate_series(1, 600) AS generated(n) ON CONFLICT (id) DO NOTHING;
      INSERT INTO %1$I.orders (id, source, name, number, status, country, priority, amount, category, w_plan_id, a_objective_id, sequence)
      SELECT md5('A-load-order-' || n)::uuid, 'A', 'A Load Order ' || n, 200000 + n,
        (ARRAY['NEW','PROCESSING','DONE','CANCELLED'])[1 + (n %% 4)], (ARRAY['IL','US','DE','FR','GB'])[1 + (n %% 5)],
        1 + (n %% 5), (15 + (n %% 1000) * 1.5)::numeric(12,2), (ARRAY['STANDARD','EXPRESS','BULK'])[1 + (n %% 3)],
        NULL, md5('A-load-objective-' || (1 + ((n - 1) %% 600)))::uuid, nextval('%1$I.replicator_sequence')
      FROM generate_series(1, 30000) AS generated(n) ON CONFLICT (id) DO NOTHING;
    $sql$, schema_name);
  END LOOP;
END;
$$;
