-- Attach the post-commit Publisher flow only to its isolated environment.
-- Entity names remain schema-independent because both relays share Redis keys.

SELECT register_synced_table('benchmark_publisher.customers', 'customers');
SELECT register_synced_table('benchmark_publisher.items', 'items');
SELECT register_synced_table('benchmark_publisher.orders', 'orders');
SELECT register_synced_table('benchmark_publisher.distributors', 'distributors');
