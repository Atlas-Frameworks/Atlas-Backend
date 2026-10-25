-- Run without an enclosing transaction so PostgreSQL can build the indexes
-- without blocking production writes.

CREATE INDEX CONCURRENTLY IF NOT EXISTS publisher_w_missions_tree_filter_idx
  ON benchmark_publisher.w_missions (campaign_id, status, country, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS publisher_w_plans_filter_idx
  ON benchmark_publisher.w_plans (status, country, category, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS publisher_a_missions_tree_filter_idx
  ON benchmark_publisher.a_missions (a_plan_id, status, country, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS publisher_a_objectives_tree_filter_idx
  ON benchmark_publisher.a_objectives
  (a_plan_id, a_mission_id, status, country, category, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS publisher_orders_w_plan_order_idx
  ON benchmark_publisher.orders (w_plan_id, id)
  WHERE source = 'W';

CREATE INDEX CONCURRENTLY IF NOT EXISTS publisher_orders_a_objective_order_idx
  ON benchmark_publisher.orders (a_objective_id, id)
  WHERE source = 'A';

CREATE INDEX CONCURRENTLY IF NOT EXISTS publisher_orders_w_tree_filter_idx
  ON benchmark_publisher.orders (w_plan_id, country, status, id)
  WHERE source = 'W';

CREATE INDEX CONCURRENTLY IF NOT EXISTS publisher_orders_a_tree_filter_idx
  ON benchmark_publisher.orders (a_objective_id, country, status, id)
  WHERE source = 'A';

CREATE INDEX CONCURRENTLY IF NOT EXISTS publisher_orders_w_country_filter_idx
  ON benchmark_publisher.orders (country, w_plan_id, status, id)
  WHERE source = 'W';

CREATE INDEX CONCURRENTLY IF NOT EXISTS publisher_orders_a_country_filter_idx
  ON benchmark_publisher.orders (country, a_objective_id, status, id)
  WHERE source = 'A';

ANALYZE benchmark_publisher.w_missions;
ANALYZE benchmark_publisher.w_plans;
ANALYZE benchmark_publisher.a_missions;
ANALYZE benchmark_publisher.a_objectives;
ANALYZE benchmark_publisher.orders;
