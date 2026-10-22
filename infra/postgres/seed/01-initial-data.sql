-- Insert one identical data batch into both isolated benchmark environments.

DO $$
DECLARE
  batch_label text := left(gen_random_uuid()::text, 8);
  customer_ids uuid[];
  item_ids uuid[];
  order_ids uuid[];
  delivery_company_ids uuid[];
  distributor_ids uuid[];
  starting_sequence bigint;
BEGIN
  SELECT greatest(
    (SELECT last_value FROM benchmark_publisher.replicator_sequence),
    (SELECT last_value FROM benchmark_debezium.replicator_sequence),
    COALESCE((
      SELECT max(entity.sequence)
      FROM (
        SELECT sequence FROM benchmark_publisher.customers
        UNION ALL SELECT sequence FROM benchmark_publisher.items
        UNION ALL SELECT sequence FROM benchmark_publisher.orders
        UNION ALL SELECT sequence FROM benchmark_publisher.delivery_companies
        UNION ALL SELECT sequence FROM benchmark_publisher.distributors
        UNION ALL SELECT sequence FROM benchmark_debezium.customers
        UNION ALL SELECT sequence FROM benchmark_debezium.items
        UNION ALL SELECT sequence FROM benchmark_debezium.orders
        UNION ALL SELECT sequence FROM benchmark_debezium.delivery_companies
        UNION ALL SELECT sequence FROM benchmark_debezium.distributors
      ) AS entity
    ), 0)
  ) INTO starting_sequence;

  PERFORM setval(
    'benchmark_publisher.replicator_sequence',
    starting_sequence,
    true
  );

  SELECT array_agg(gen_random_uuid()) INTO customer_ids FROM generate_series(1, 30);
  SELECT array_agg(gen_random_uuid()) INTO item_ids FROM generate_series(1, 100);
  SELECT array_agg(gen_random_uuid()) INTO order_ids FROM generate_series(1, 40);
  SELECT array_agg(gen_random_uuid()) INTO delivery_company_ids FROM generate_series(1, 4);
  SELECT array_agg(gen_random_uuid()) INTO distributor_ids FROM generate_series(1, 5);

  INSERT INTO benchmark_publisher.customers (id, name, address, sequence)
  SELECT
    customer_ids[customer_number],
    format('Customer %s-%s', batch_label, customer_number),
    format('%s Commerce Street', customer_number),
    nextval('benchmark_publisher.replicator_sequence')
  FROM generate_series(1, 30) AS customers(customer_number);

  INSERT INTO benchmark_debezium.customers (id, name, address, sequence)
  SELECT id, name, address, sequence
  FROM benchmark_publisher.customers
  WHERE id = ANY(customer_ids);

  INSERT INTO benchmark_publisher.items (id, price, type, sequence)
  SELECT
    item_ids[item_number],
    round((5 + item_number * 4.91)::numeric, 2),
    (ARRAY['book', 'electronics', 'food', 'furniture', 'clothing'])[
      1 + ((item_number - 1) % 5)
    ],
    nextval('benchmark_publisher.replicator_sequence')
  FROM generate_series(1, 100) AS items(item_number);

  INSERT INTO benchmark_debezium.items (id, price, type, sequence)
  SELECT id, price, type, sequence
  FROM benchmark_publisher.items
  WHERE id = ANY(item_ids);

  INSERT INTO benchmark_publisher.orders (id, name, item_id, customer_id, sequence)
  SELECT
    order_ids[order_number],
    format('Order %s-%s', batch_label, order_number),
    item_ids[1 + ((order_number - 1) % array_length(item_ids, 1))],
    customer_ids[1 + ((order_number - 1) % array_length(customer_ids, 1))],
    nextval('benchmark_publisher.replicator_sequence')
  FROM generate_series(1, 40) AS orders(order_number);

  INSERT INTO benchmark_debezium.orders (id, name, item_id, customer_id, sequence)
  SELECT id, name, item_id, customer_id, sequence
  FROM benchmark_publisher.orders
  WHERE id = ANY(order_ids);

  INSERT INTO benchmark_publisher.delivery_companies (id, name, sequence)
  SELECT
    delivery_company_ids[company_number],
    format('Delivery Company %s-%s', batch_label, company_number),
    nextval('benchmark_publisher.replicator_sequence')
  FROM generate_series(1, 4) AS companies(company_number);

  INSERT INTO benchmark_debezium.delivery_companies (id, name, sequence)
  SELECT id, name, sequence
  FROM benchmark_publisher.delivery_companies
  WHERE id = ANY(delivery_company_ids);

  INSERT INTO benchmark_publisher.distributors (
    id,
    name,
    order_ids,
    delivery_company_id,
    sequence
  )
  SELECT
    distributor_ids[distributor_number],
    format('Distributor %s-%s', batch_label, distributor_number),
    order_ids[
      (1 + ((distributor_number - 1) * 8)):
      least(distributor_number * 8, array_length(order_ids, 1))
    ],
    delivery_company_ids[
      1 + ((distributor_number - 1) % array_length(delivery_company_ids, 1))
    ],
    nextval('benchmark_publisher.replicator_sequence')
  FROM generate_series(1, 5) AS distributors(distributor_number);

  INSERT INTO benchmark_debezium.distributors (
    id,
    name,
    order_ids,
    delivery_company_id,
    sequence
  )
  SELECT
    distributor.id,
    distributor.name,
    distributor.order_ids,
    distributor.delivery_company_id,
    distributor.sequence
  FROM benchmark_publisher.distributors AS distributor
  WHERE distributor.id = ANY(distributor_ids);

  PERFORM setval(
    'benchmark_debezium.replicator_sequence',
    (
      SELECT max(entity.sequence)
      FROM (
        SELECT sequence FROM benchmark_debezium.customers
        UNION ALL SELECT sequence FROM benchmark_debezium.items
        UNION ALL SELECT sequence FROM benchmark_debezium.orders
        UNION ALL SELECT sequence FROM benchmark_debezium.delivery_companies
        UNION ALL SELECT sequence FROM benchmark_debezium.distributors
      ) AS entity
    ),
    true
  );

  RAISE NOTICE 'Inserted identical seed batch % into both benchmark schemas', batch_label;
END;
$$;
