-- Attach the generic synchronization triggers to the commerce domain.
-- Run after 02-schema.sql and after 04-commerce-sync.sql.

SELECT register_synced_table('public.customers');
SELECT register_synced_table('public.items');
SELECT register_synced_table('public.orders');
SELECT register_synced_table('public.distributors');
