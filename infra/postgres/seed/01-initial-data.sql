-- Small deterministic W/A dataset. Both benchmark schemas receive identical rows.

DO $$
DECLARE schema_name text;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['benchmark_publisher', 'benchmark_debezium'] LOOP
    EXECUTE format($sql$
      INSERT INTO %1$I.w_campaigns (id, name, number, status, country, sequence) VALUES
        ('10000000-0000-4000-8000-000000000001', 'W Campaign Alpha', 1001, 'ACTIVE', 'IL', nextval('%1$I.replicator_sequence'))
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO %1$I.w_missions (id, name, number, status, country, campaign_id, sequence) VALUES
        ('11000000-0000-4000-8000-000000000001', 'W Mission North', 1101, 'ACTIVE', 'IL', '10000000-0000-4000-8000-000000000001', nextval('%1$I.replicator_sequence')),
        ('11000000-0000-4000-8000-000000000002', 'W Mission South', 1102, 'PLANNED', 'US', '10000000-0000-4000-8000-000000000001', nextval('%1$I.replicator_sequence'))
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO %1$I.w_plans (id, name, number, status, country, category, sequence) VALUES
        ('12000000-0000-4000-8000-000000000001', 'W Plan One', 1201, 'ACTIVE', 'IL', 'GROUND', nextval('%1$I.replicator_sequence')),
        ('12000000-0000-4000-8000-000000000002', 'W Plan Two', 1202, 'PAUSED', 'US', 'AIR', nextval('%1$I.replicator_sequence')),
        ('12000000-0000-4000-8000-000000000003', 'W Shared Plan', 1203, 'ACTIVE', 'DE', 'SEA', nextval('%1$I.replicator_sequence'))
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO %1$I.w_mission_plans (mission_id, plan_id) VALUES
        ('11000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001'),
        ('11000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000003'),
        ('11000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-000000000002'),
        ('11000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-000000000003')
      ON CONFLICT DO NOTHING;

      INSERT INTO %1$I.a_plans (id, name, number, status, country, sequence) VALUES
        ('20000000-0000-4000-8000-000000000001', 'A Plan Alpha', 2001, 'ACTIVE', 'IL', nextval('%1$I.replicator_sequence'))
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO %1$I.a_missions (id, name, number, status, country, a_plan_id, sequence) VALUES
        ('21000000-0000-4000-8000-000000000001', 'A Mission East', 2101, 'ACTIVE', 'IL', '20000000-0000-4000-8000-000000000001', nextval('%1$I.replicator_sequence')),
        ('21000000-0000-4000-8000-000000000002', 'A Mission West', 2102, 'PLANNED', 'US', '20000000-0000-4000-8000-000000000001', nextval('%1$I.replicator_sequence'))
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO %1$I.a_objectives (id, name, number, status, country, category, a_mission_id, a_plan_id, sequence) VALUES
        ('22000000-0000-4000-8000-000000000001', 'A Objective One', 2201, 'ACTIVE', 'IL', 'SALES', '21000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', nextval('%1$I.replicator_sequence')),
        ('22000000-0000-4000-8000-000000000002', 'A Objective Two', 2202, 'PAUSED', 'US', 'SUPPORT', '21000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', nextval('%1$I.replicator_sequence'))
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO %1$I.orders (id, source, name, number, status, country, priority, amount, category, w_plan_id, a_objective_id, sequence)
      SELECT md5('W-order-' || n)::uuid, 'W', 'W Order ' || n, 3000 + n,
        (ARRAY['NEW','PROCESSING','DONE'])[1 + (n %% 3)], (ARRAY['IL','US','DE'])[1 + (n %% 3)],
        1 + (n %% 5), (25 + n * 7.5)::numeric(12,2), (ARRAY['STANDARD','EXPRESS'])[1 + (n %% 2)],
        (ARRAY['12000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000003']::uuid[])[1 + (n %% 3)],
        NULL, nextval('%1$I.replicator_sequence')
      FROM generate_series(1, 12) AS generated(n) ON CONFLICT (id) DO NOTHING;
      INSERT INTO %1$I.orders (id, source, name, number, status, country, priority, amount, category, w_plan_id, a_objective_id, sequence)
      SELECT md5('A-order-' || n)::uuid, 'A', 'A Order ' || n, 4000 + n,
        (ARRAY['NEW','PROCESSING','DONE'])[1 + (n %% 3)], (ARRAY['IL','US','DE'])[1 + (n %% 3)],
        1 + (n %% 5), (30 + n * 8.25)::numeric(12,2), (ARRAY['STANDARD','EXPRESS'])[1 + (n %% 2)],
        NULL, (ARRAY['22000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000002']::uuid[])[1 + (n %% 2)],
        nextval('%1$I.replicator_sequence')
      FROM generate_series(1, 12) AS generated(n) ON CONFLICT (id) DO NOTHING;
    $sql$, schema_name);
  END LOOP;
END;
$$;
