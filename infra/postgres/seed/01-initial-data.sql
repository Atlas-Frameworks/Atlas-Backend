-- Small deterministic W/A dataset. Both benchmark schemas receive identical rows.

DO $$
DECLARE schema_name text;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['benchmark_publisher', 'benchmark_debezium'] LOOP
    EXECUTE format($sql$
      INSERT INTO %1$I.w_campaigns (id, name, number, status, country, sequence) VALUES
        ('10000000-0000-4000-8000-000000000001', 'W Campaign Alpha', 1001, 'ACTIVE', 'IL', nextval('%1$I.replicator_sequence'))
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO %1$I.w_missions (id, name, number, status, country, campaign_id, o_plan_ids, sequence) VALUES
        ('11000000-0000-4000-8000-000000000001', 'W Mission North', 1101, 'ACTIVE', 'IL', '10000000-0000-4000-8000-000000000001',
          ARRAY['13000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000002'], nextval('%1$I.replicator_sequence')),
        ('11000000-0000-4000-8000-000000000002', 'W Mission South', 1102, 'PLANNED', 'US', '10000000-0000-4000-8000-000000000001',
          ARRAY['13000000-0000-4000-8000-000000000002'], nextval('%1$I.replicator_sequence'))
      ON CONFLICT (id) DO UPDATE SET o_plan_ids = EXCLUDED.o_plan_ids, sequence = EXCLUDED.sequence
        WHERE w_missions.o_plan_ids IS DISTINCT FROM EXCLUDED.o_plan_ids;
      -- Missions 3-60 each belong to O plan n (see the o_plans insert below).
      INSERT INTO %1$I.w_missions (id, name, number, status, country, campaign_id, o_plan_ids, sequence)
      SELECT ('11000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'W Mission ' || n, 1100 + n,
        (ARRAY['ACTIVE','PLANNED','PAUSED'])[1 + (n %% 3)], (ARRAY['IL','US','DE'])[1 + (n %% 3)],
        '10000000-0000-4000-8000-000000000001',
        ARRAY['13000000-0000-4000-8000-' || lpad(n::text, 12, '0')], nextval('%1$I.replicator_sequence')
      FROM generate_series(3, 60) AS generated(n)
      ON CONFLICT (id) DO UPDATE SET o_plan_ids = EXCLUDED.o_plan_ids, sequence = EXCLUDED.sequence
        WHERE w_missions.o_plan_ids IS DISTINCT FROM EXCLUDED.o_plan_ids;
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
      INSERT INTO %1$I.w_mission_plans (mission_id, plan_id)
      SELECT ('11000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
        (ARRAY['12000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000003']::uuid[])[1 + (n %% 3)]
      FROM generate_series(3, 60) AS generated(n) ON CONFLICT DO NOTHING;

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
      FROM generate_series(1, 70) AS generated(n) ON CONFLICT (id) DO NOTHING;
      INSERT INTO %1$I.orders (id, source, name, number, status, country, priority, amount, category, w_plan_id, a_objective_id, sequence)
      SELECT md5('A-order-' || n)::uuid, 'A', 'A Order ' || n, 4000 + n,
        (ARRAY['NEW','PROCESSING','DONE'])[1 + (n %% 3)], (ARRAY['IL','US','DE'])[1 + (n %% 3)],
        1 + (n %% 5), (30 + n * 8.25)::numeric(12,2), (ARRAY['STANDARD','EXPRESS'])[1 + (n %% 2)],
        NULL, (ARRAY['22000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000002']::uuid[])[1 + (n %% 2)],
        nextval('%1$I.replicator_sequence')
      FROM generate_series(1, 70) AS generated(n) ON CONFLICT (id) DO NOTHING;

      INSERT INTO %1$I.o_plans (id, name, order_ids, w_mission_ids) VALUES
        ('13000000-0000-4000-8000-000000000001', 'O Plan North',
          ARRAY(SELECT md5('W-order-' || n)::uuid::varchar FROM generate_series(1, 4) AS generated(n)),
          ARRAY['11000000-0000-4000-8000-000000000001']),
        ('13000000-0000-4000-8000-000000000002', 'O Plan Shared',
          ARRAY(SELECT md5(source || '-order-' || n)::uuid::varchar FROM unnest(ARRAY['W', 'A']) AS sources(source), generate_series(5, 8) AS generated(n)),
          ARRAY['11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002'])
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO %1$I.o_plans (id, name, order_ids, w_mission_ids)
      SELECT ('13000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'O Plan ' || n,
        ARRAY[md5('W-order-' || (n + 10))::uuid::varchar, md5('A-order-' || (n + 10))::uuid::varchar],
        ARRAY['11000000-0000-4000-8000-' || lpad(n::text, 12, '0')]
      FROM generate_series(3, 60) AS generated(n) ON CONFLICT (id) DO NOTHING;
    $sql$, schema_name);
  END LOOP;
END;
$$;
