-- Isolated W/A order environments used to compare the two relay pipelines.
-- Existing commerce POC tables are removed once when upgrading this workspace.

CREATE SCHEMA IF NOT EXISTS benchmark_publisher;
CREATE SCHEMA IF NOT EXISTS benchmark_debezium;
CREATE SEQUENCE IF NOT EXISTS benchmark_publisher.replicator_sequence;
CREATE SEQUENCE IF NOT EXISTS benchmark_debezium.replicator_sequence;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE benchmark_publisher.replicator_sequence TO atlas_writer;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE benchmark_debezium.replicator_sequence TO atlas_writer;
GRANT USAGE ON SCHEMA benchmark_publisher TO atlas_writer, atlas_reader, atlas_publisher;
GRANT USAGE ON SCHEMA benchmark_debezium TO atlas_writer, atlas_reader, debezium;

DO $$
DECLARE schema_name text; legacy_table text;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['benchmark_publisher', 'benchmark_debezium'] LOOP
    IF to_regclass(format('%I.orders', schema_name)) IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM pg_attribute
         WHERE attrelid = to_regclass(format('%I.orders', schema_name))
           AND attname = 'source' AND NOT attisdropped
       ) THEN
      FOREACH legacy_table IN ARRAY ARRAY['distributors', 'delivery_companies', 'orders', 'items', 'customers'] LOOP
        EXECUTE format('DROP TABLE IF EXISTS %I.%I CASCADE', schema_name, legacy_table);
        EXECUTE format('DROP TABLE IF EXISTS %I.%I CASCADE', schema_name, legacy_table || '_outbox');
        EXECUTE format('DROP TABLE IF EXISTS %I.%I CASCADE', schema_name, legacy_table || '_sync_state');
      END LOOP;
    END IF;
  END LOOP;
END;
$$;

DO $$
DECLARE schema_name text; index_prefix text;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['benchmark_publisher', 'benchmark_debezium'] LOOP
    index_prefix := CASE WHEN schema_name = 'benchmark_publisher' THEN 'publisher' ELSE 'debezium' END;
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.w_campaigns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
      number integer NOT NULL, status text NOT NULL, country text NOT NULL,
      sequence bigint NOT NULL CHECK (sequence >= 1), updated_at timestamptz NOT NULL DEFAULT now()
    )', schema_name);
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.w_missions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
      number integer NOT NULL, status text NOT NULL, country text NOT NULL,
      campaign_id uuid NOT NULL REFERENCES %I.w_campaigns(id),
      sequence bigint NOT NULL CHECK (sequence >= 1), updated_at timestamptz NOT NULL DEFAULT now()
    )', schema_name, schema_name);
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.w_plans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
      number integer NOT NULL, status text NOT NULL, country text NOT NULL, category text NOT NULL,
      sequence bigint NOT NULL CHECK (sequence >= 1), updated_at timestamptz NOT NULL DEFAULT now()
    )', schema_name);
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.w_mission_plans (
      mission_id uuid NOT NULL REFERENCES %I.w_missions(id) ON DELETE CASCADE,
      plan_id uuid NOT NULL REFERENCES %I.w_plans(id) ON DELETE CASCADE,
      PRIMARY KEY (mission_id, plan_id)
    )', schema_name, schema_name, schema_name);
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.a_plans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
      number integer NOT NULL, status text NOT NULL, country text NOT NULL,
      sequence bigint NOT NULL CHECK (sequence >= 1), updated_at timestamptz NOT NULL DEFAULT now()
    )', schema_name);
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.a_missions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
      number integer NOT NULL, status text NOT NULL, country text NOT NULL,
      a_plan_id uuid NOT NULL REFERENCES %I.a_plans(id),
      sequence bigint NOT NULL CHECK (sequence >= 1), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, a_plan_id)
    )', schema_name, schema_name);
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.a_objectives (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
      number integer NOT NULL, status text NOT NULL, country text NOT NULL, category text NOT NULL,
      a_mission_id uuid NOT NULL, a_plan_id uuid NOT NULL,
      sequence bigint NOT NULL CHECK (sequence >= 1), updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (a_mission_id, a_plan_id) REFERENCES %I.a_missions(id, a_plan_id)
    )', schema_name, schema_name);
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I.orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL CHECK (source IN (''W'', ''A'')),
      name text NOT NULL, number integer NOT NULL, status text NOT NULL, country text NOT NULL,
      priority integer NOT NULL CHECK (priority BETWEEN 1 AND 5),
      amount numeric(12, 2) NOT NULL CHECK (amount >= 0), category text NOT NULL,
      w_plan_id uuid REFERENCES %I.w_plans(id), a_objective_id uuid REFERENCES %I.a_objectives(id),
      sequence bigint NOT NULL CHECK (sequence >= 1), updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((source = ''W'' AND w_plan_id IS NOT NULL AND a_objective_id IS NULL)
          OR (source = ''A'' AND a_objective_id IS NOT NULL AND w_plan_id IS NULL))
    )', schema_name, schema_name, schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.w_missions (campaign_id)', index_prefix || '_w_missions_campaign_idx', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.w_missions (campaign_id, status, country, id)', index_prefix || '_w_missions_tree_filter_idx', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.w_mission_plans (plan_id)', index_prefix || '_w_mission_plans_plan_idx', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.w_plans (status, country, category, id)', index_prefix || '_w_plans_filter_idx', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.a_missions (a_plan_id)', index_prefix || '_a_missions_plan_idx', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.a_missions (a_plan_id, status, country, id)', index_prefix || '_a_missions_tree_filter_idx', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.a_objectives (a_plan_id, a_mission_id)', index_prefix || '_a_objectives_hierarchy_idx', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.a_objectives (a_plan_id, a_mission_id, status, country, category, id)', index_prefix || '_a_objectives_tree_filter_idx', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.orders (w_plan_id, id) WHERE source = ''W''', index_prefix || '_orders_w_plan_order_idx', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.orders (a_objective_id, id) WHERE source = ''A''', index_prefix || '_orders_a_objective_order_idx', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.orders (w_plan_id, country, status, id) WHERE source = ''W''', index_prefix || '_orders_w_tree_filter_idx', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.orders (a_objective_id, country, status, id) WHERE source = ''A''', index_prefix || '_orders_a_tree_filter_idx', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.orders (country, w_plan_id, status, id) WHERE source = ''W''', index_prefix || '_orders_w_country_filter_idx', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.orders (country, a_objective_id, status, id) WHERE source = ''A''', index_prefix || '_orders_a_country_filter_idx', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.orders (source, status, country)', index_prefix || '_orders_filter_idx', schema_name);
    EXECUTE format('GRANT SELECT ON %I.w_mission_plans TO atlas_reader', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.w_mission_plans TO atlas_writer', schema_name);
  END LOOP;
END;
$$;
