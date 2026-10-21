-- Insert one identical data batch into both isolated benchmark environments.

DO $$
DECLARE
  batch_label text := left(gen_random_uuid()::text, 8);
  customer_ids uuid[];
  item_ids uuid[];
  order_ids uuid[];
  distributor_ids uuid[];
BEGIN
  SELECT array_agg(gen_random_uuid()) INTO customer_ids FROM generate_series(1, 30);
  SELECT array_agg(gen_random_uuid()) INTO item_ids FROM generate_series(1, 100);
  SELECT array_agg(gen_random_uuid()) INTO order_ids FROM generate_series(1, 40);
  SELECT array_agg(gen_random_uuid()) INTO distributor_ids FROM generate_series(1, 5);

  INSERT INTO benchmark_publisher.customers (id, name, address)
  SELECT
    customer_ids[customer_number],
    format('Customer %s-%s', batch_label, customer_number),
    format('%s Commerce Street', customer_number)
  FROM generate_series(1, 30) AS customers(customer_number);

  INSERT INTO benchmark_debezium.customers (id, name, address)
  SELECT id, name, address
  FROM benchmark_publisher.customers
  WHERE id = ANY(customer_ids);

  INSERT INTO benchmark_publisher.items (id, price, type)
  SELECT
    item_ids[item_number],
    round((5 + item_number * 4.91)::numeric, 2),
    (ARRAY['book', 'electronics', 'food', 'furniture', 'clothing'])[
      1 + ((item_number - 1) % 5)
    ]
  FROM generate_series(1, 100) AS items(item_number);

  INSERT INTO benchmark_debezium.items (id, price, type)
  SELECT id, price, type
  FROM benchmark_publisher.items
  WHERE id = ANY(item_ids);

  INSERT INTO benchmark_publisher.orders (id, name, item_id, customer_id)
  SELECT
    order_ids[order_number],
    format('Order %s-%s', batch_label, order_number),
    item_ids[1 + ((order_number - 1) % array_length(item_ids, 1))],
    customer_ids[1 + ((order_number - 1) % array_length(customer_ids, 1))]
  FROM generate_series(1, 40) AS orders(order_number);

  INSERT INTO benchmark_debezium.orders (id, name, item_id, customer_id)
  SELECT id, name, item_id, customer_id
  FROM benchmark_publisher.orders
  WHERE id = ANY(order_ids);

  INSERT INTO benchmark_publisher.distributors (id, name, order_ids)
  SELECT
    distributor_ids[distributor_number],
    format('Distributor %s-%s', batch_label, distributor_number),
    order_ids[
      (1 + ((distributor_number - 1) * 8)):
      least(distributor_number * 8, array_length(order_ids, 1))
    ]
  FROM generate_series(1, 5) AS distributors(distributor_number);

  INSERT INTO benchmark_debezium.distributors (id, name, order_ids)
  SELECT distributor.id, distributor.name, distributor.order_ids
  FROM benchmark_publisher.distributors AS distributor
  WHERE distributor.id = ANY(distributor_ids);

  RAISE NOTICE 'Inserted identical seed batch % into both benchmark schemas', batch_label;
END;
$$;
