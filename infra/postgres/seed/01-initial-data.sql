-- Run after postgres:setup so every insert is delivered to Redis Streams.
-- The synchronization triggers created by 04-commerce-sync.sql emit the events.

DO $$
DECLARE
  batch_label text := left(gen_random_uuid()::text, 8);
  customer_ids uuid[];
  item_ids uuid[];
  order_ids uuid[];
  selected_order_ids uuid[];
  distributor_number integer;
  selected_order_count integer;
BEGIN
  WITH inserted_customers AS (
    INSERT INTO customers (id, name, address, version)
    SELECT
      gen_random_uuid(),
      format('Customer %s-%s', batch_label, customer_number),
      format('%s Commerce Street', customer_number),
      1
    FROM generate_series(1, 30) AS generated_customers(customer_number)
    RETURNING id
  )
  SELECT array_agg(id) INTO customer_ids FROM inserted_customers;

  WITH inserted_items AS (
    INSERT INTO items (id, price, type, version)
    SELECT
      gen_random_uuid(),
      round((5 + random() * 495)::numeric, 2),
      (ARRAY['book', 'electronics', 'food', 'furniture', 'clothing'])[1 + floor(random() * 5)::integer],
      1
    FROM generate_series(1, 100)
    RETURNING id
  )
  SELECT array_agg(id) INTO item_ids FROM inserted_items;

  WITH inserted_orders AS (
    INSERT INTO orders (id, name, item_id, customer_id, version)
    SELECT
      gen_random_uuid(),
      format('Order %s-%s', batch_label, order_number),
      item_ids[1 + floor(random() * array_length(item_ids, 1))::integer],
      customer_ids[1 + floor(random() * array_length(customer_ids, 1))::integer],
      1
    FROM generate_series(1, 40) AS generated_orders(order_number)
    RETURNING id
  )
  SELECT array_agg(id) INTO order_ids FROM inserted_orders;

  FOR distributor_number IN 1..5 LOOP
    selected_order_count := 1 + floor(random() * 20)::integer;

    SELECT array_agg(id)
    INTO selected_order_ids
    FROM (
      SELECT id
      FROM unnest(order_ids) AS available_orders(id)
      ORDER BY random()
      LIMIT selected_order_count
    ) AS selected_orders;

    INSERT INTO distributors (id, name, order_ids, version)
    VALUES (
      gen_random_uuid(),
      format('Distributor %s-%s', batch_label, distributor_number),
      selected_order_ids,
      1
    );
  END LOOP;

  RAISE NOTICE 'Inserted 30 customers, 100 items, 40 orders, and 5 distributors (batch %)', batch_label;
END;
$$;
