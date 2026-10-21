-- Commerce domain used by the synchronization proof of concept.

CREATE TABLE IF NOT EXISTS customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  address    text NOT NULL,
  version    bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price      numeric(12, 2) NOT NULL CHECK (price >= 0),
  type       text NOT NULL,
  version    bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  item_id     uuid NOT NULL REFERENCES items(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  version     bigint NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_item_idx ON orders (item_id);
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (customer_id);

CREATE TABLE IF NOT EXISTS distributors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  order_ids  uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  version    bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS distributors_order_ids_idx ON distributors USING gin (order_ids);
