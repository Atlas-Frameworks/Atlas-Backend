-- Isolated commerce environments used to compare the two relay pipelines.
-- Public contains shared synchronization functions only, never entity data.

CREATE SCHEMA IF NOT EXISTS benchmark_publisher;
CREATE SCHEMA IF NOT EXISTS benchmark_debezium;

CREATE SEQUENCE IF NOT EXISTS benchmark_publisher.replicator_sequence;
CREATE SEQUENCE IF NOT EXISTS benchmark_debezium.replicator_sequence;

GRANT USAGE, SELECT, UPDATE ON SEQUENCE benchmark_publisher.replicator_sequence TO atlas_writer;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE benchmark_debezium.replicator_sequence TO atlas_writer;

GRANT USAGE ON SCHEMA benchmark_publisher TO atlas_writer, atlas_reader, atlas_publisher;
GRANT USAGE ON SCHEMA benchmark_debezium TO atlas_writer, atlas_reader, debezium;

DO $$
DECLARE
  schema_name text;
  customers_table regclass;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['benchmark_publisher', 'benchmark_debezium'] LOOP
    customers_table := to_regclass(format('%I.customers', schema_name));

    IF customers_table IS NOT NULL THEN
      IF NOT EXISTS (
         SELECT 1
         FROM pg_attribute
         WHERE attrelid = customers_table
           AND attname = 'sequence'
           AND atttypid = 'bigint'::regtype
           AND NOT attisdropped
      ) THEN
        RAISE EXCEPTION
          'Schema % does not contain the source sequence contract. Recreate the benchmark database before applying this setup.',
          schema_name;
      END IF;
    END IF;
  END LOOP;
END;
$$;

CREATE TABLE IF NOT EXISTS benchmark_publisher.customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  address    text NOT NULL,
  sequence   bigint NOT NULL CHECK (sequence >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS benchmark_publisher.items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price      numeric(12, 2) NOT NULL CHECK (price >= 0),
  type       text NOT NULL,
  sequence   bigint NOT NULL CHECK (sequence >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS benchmark_publisher.orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  item_id     uuid NOT NULL REFERENCES benchmark_publisher.items(id),
  customer_id uuid NOT NULL REFERENCES benchmark_publisher.customers(id),
  sequence    bigint NOT NULL CHECK (sequence >= 1),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS publisher_orders_item_idx
  ON benchmark_publisher.orders (item_id);
CREATE INDEX IF NOT EXISTS publisher_orders_customer_idx
  ON benchmark_publisher.orders (customer_id);

CREATE TABLE IF NOT EXISTS benchmark_publisher.distributors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  order_ids  uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  sequence   bigint NOT NULL CHECK (sequence >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS publisher_distributors_order_ids_idx
  ON benchmark_publisher.distributors USING gin (order_ids);

CREATE TABLE IF NOT EXISTS benchmark_debezium.customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  address    text NOT NULL,
  sequence   bigint NOT NULL CHECK (sequence >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS benchmark_debezium.items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price      numeric(12, 2) NOT NULL CHECK (price >= 0),
  type       text NOT NULL,
  sequence   bigint NOT NULL CHECK (sequence >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS benchmark_debezium.orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  item_id     uuid NOT NULL REFERENCES benchmark_debezium.items(id),
  customer_id uuid NOT NULL REFERENCES benchmark_debezium.customers(id),
  sequence    bigint NOT NULL CHECK (sequence >= 1),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS debezium_orders_item_idx
  ON benchmark_debezium.orders (item_id);
CREATE INDEX IF NOT EXISTS debezium_orders_customer_idx
  ON benchmark_debezium.orders (customer_id);

CREATE TABLE IF NOT EXISTS benchmark_debezium.distributors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  order_ids  uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  sequence   bigint NOT NULL CHECK (sequence >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS debezium_distributors_order_ids_idx
  ON benchmark_debezium.distributors USING gin (order_ids);
