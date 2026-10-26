# Dynamic Order Grouping: Work Summary

## Purpose

This document summarizes the order-grouping design and implementation work completed during the session. The goal is to let a client request a filtered hierarchy of orders, receive group counts and an initial page of orders for every deepest group, and subsequently request a different page size or offset for an individual group.

The database performs relational filtering, membership construction, distinct counting, and per-leaf pagination. NestJS converts the flat database rows into the ordered flat-node response expected by the client.

## Order origins

Orders come from one shared `orders` table, but they can be reached through either of two origin hierarchies.

### W hierarchy

```text
w_campaigns
  -> w_missions
    -> w_mission_plans
      -> w_plans
        -> orders.w_plan_id
```

### A hierarchy

```text
a_plans
  -> a_missions
    -> a_objectives
      -> orders.a_objective_id
```

The API does not require a public `source` property. NestJS determines which SQL branch is required from the supplied origin ID arrays. If A IDs are supplied, it builds the A branch; if W IDs are supplied, it builds the W branch; if both are supplied, it combines both branches.

The hierarchy joins locate the relevant orders. They do not automatically become visible folders in the returned tree.

## Filtering and grouping

Filtering and grouping are separate operations:

1. Origin IDs and optional field filters restrict the order set using joins and `WHERE` conditions.
2. The ordered `groupBy` array selects the fields that form the visible hierarchy.
3. Every selected order receives a `full_group_path` containing its grouping values in the requested order.
4. Each prefix of that path represents one folder.

For example, grouping by order status and country gives an order a path such as:

```json
["OPEN", "IL"]
```

Its folder prefixes are:

```json
["OPEN"]
["OPEN", "IL"]
```

Group identifiers are serialized JSON paths. The entire path is used as the identifier because a group name is not necessarily unique outside its parent.

## Memberships

The membership relation contains one row for each unique order-to-leaf relationship:

```text
order_id | order_name | full_group_path
```

`jsonb_build_array` constructs the path but does not remove duplicate rows. `DISTINCT` applies to the complete membership tuple:

```sql
SELECT DISTINCT
  order_id,
  order_name,
  jsonb_build_array(group_value_1, group_value_2) AS full_group_path
FROM selected_orders;
```

This removes duplicate memberships introduced by joins while preserving valid cases where one order belongs to more than one path.

## Counts

For every grouping depth, PostgreSQL expands each full path into its prefix and creates a distinct `(order_id, group_path)` membership. It then groups by that prefix and counts distinct orders.

For a two-field grouping, an order with path `["OPEN", "IL"]` contributes once to:

- `["OPEN"]`
- `["OPEN", "IL"]`

The count of a parent folder therefore includes all distinct orders beneath it, while a deepest-folder count represents all orders in that exact leaf regardless of pagination.

## Per-group pagination

Pagination applies only to orders attached to the complete leaf path. PostgreSQL assigns:

```sql
row_number() OVER (
  PARTITION BY full_group_path
  ORDER BY order_id
)
```

Each leaf uses `defaultLimit` and offset `0` unless its serialized path has an override. A request can therefore increase one opened folder from 10 to 20 orders without changing other folders.

Example override concept:

```json
{
  "[\"OPEN\", \"IL\"]": {
    "limit": 20,
    "offset": 0
  }
}
```

Keeping the limit in the request allows the client to preserve the expanded amount when the tree is recalculated after an order update.

## Response construction

PostgreSQL returns flat rows instead of constructing the final JSON tree:

- `group` rows contain `groupPath`, `parentPath`, `groupName`, and `total`.
- `order` rows contain `orderId`, `orderName`, and the complete leaf `groupPath`.

NestJS then:

1. Creates a group node for every group row.
2. Connects groups through `parentPath`.
3. Attaches each paginated order to its complete leaf path.
4. Produces the required depth-first flat order: group, its child groups, then its order nodes.

The result is a flat array of nodes connected through IDs rather than a recursively nested JSON object.

## Group-order lookup endpoint

The separate `POST /order-groups/orders` query supports retrieving complete order records using:

- Multiple included group paths.
- Explicitly included order IDs.
- Explicitly excluded order IDs.
- Excluded group paths.
- Parent or leaf group paths.

The database applies these selections directly and deduplicates orders before returning them.

## SQL demonstration

The following PostgreSQL query demonstrates the target design with two visible grouping fields: `orders.status` and `orders.country`. The A hierarchy is used only to locate orders for a selected objective.

Replace `<A_OBJECTIVE_UUID>` before running the query.

```sql
WITH params AS (
  SELECT
    '<A_OBJECTIVE_UUID>'::uuid AS objective_id,
    10::integer AS default_limit,
    '[
      {
        "path": ["OPEN", "IL"],
        "limit": 20,
        "offset": 0
      }
    ]'::jsonb AS pagination
),
selected_orders AS (
  SELECT DISTINCT
    customer_order.id AS order_id,
    customer_order.name AS order_name,
    customer_order.status AS order_status,
    customer_order.country AS order_country
  FROM benchmark_publisher.a_plans AS a_plan
  JOIN benchmark_publisher.a_missions AS a_mission
    ON a_mission.a_plan_id = a_plan.id
  JOIN benchmark_publisher.a_objectives AS a_objective
    ON a_objective.a_mission_id = a_mission.id
   AND a_objective.a_plan_id = a_plan.id
  JOIN benchmark_publisher.orders AS customer_order
    ON customer_order.a_objective_id = a_objective.id
   AND customer_order.source = 'A'
  CROSS JOIN params
  WHERE a_objective.id = params.objective_id
),
memberships AS (
  SELECT DISTINCT
    order_id,
    order_name,
    jsonb_build_array(
      order_status,
      order_country
    ) AS full_group_path
  FROM selected_orders
),
node_memberships AS (
  SELECT DISTINCT
    order_id,
    1 AS level,
    jsonb_build_array(full_group_path -> 0) AS group_path,
    full_group_path -> 0 AS group_name
  FROM memberships

  UNION ALL

  SELECT DISTINCT
    order_id,
    2 AS level,
    jsonb_build_array(
      full_group_path -> 0,
      full_group_path -> 1
    ) AS group_path,
    full_group_path -> 1 AS group_name
  FROM memberships
),
node_counts AS (
  SELECT
    level,
    group_path,
    group_name,
    count(DISTINCT order_id) AS total
  FROM node_memberships
  GROUP BY level, group_path, group_name
),
pagination_overrides AS (
  SELECT
    page.value -> 'path' AS group_path,
    (page.value ->> 'limit')::integer AS page_limit,
    (page.value ->> 'offset')::integer AS page_offset
  FROM params
  CROSS JOIN LATERAL jsonb_array_elements(params.pagination) AS page(value)
),
ranked_leaf_orders AS (
  SELECT
    membership.full_group_path AS group_path,
    membership.order_id,
    membership.order_name,
    row_number() OVER (
      PARTITION BY membership.full_group_path
      ORDER BY membership.order_id
    ) AS row_number,
    COALESCE(page.page_limit, params.default_limit) AS page_limit,
    COALESCE(page.page_offset, 0) AS page_offset
  FROM memberships AS membership
  CROSS JOIN params
  LEFT JOIN pagination_overrides AS page
    ON page.group_path = membership.full_group_path
),
paginated_leaf_orders AS (
  SELECT
    group_path,
    order_id,
    order_name
  FROM ranked_leaf_orders
  WHERE row_number > page_offset
    AND row_number <= page_offset + page_limit
)
SELECT
  'group'::text AS row_kind,
  node.level,
  node.group_path,
  CASE
    WHEN node.level = 1 THEN NULL::jsonb
    ELSE node.group_path - (node.level - 1)
  END AS parent_path,
  COALESCE(node.group_name #>> '{}', 'null') AS group_name,
  node.total,
  NULL::uuid AS order_id,
  NULL::text AS order_name
FROM node_counts AS node

UNION ALL

SELECT
  'order'::text AS row_kind,
  3 AS level,
  leaf_order.group_path,
  leaf_order.group_path AS parent_path,
  NULL::text AS group_name,
  NULL::bigint AS total,
  leaf_order.order_id,
  leaf_order.order_name
FROM paginated_leaf_orders AS leaf_order;
```

This query deliberately does not use `MATERIALIZED`; PostgreSQL may inline or otherwise optimize eligible CTEs. Ordinary CTEs do not lock the source tables beyond the normal read locks required by the statement.

## No-grouping behavior

The agreed target behavior does not return a synthetic root folder.

When `groupBy` is empty:

- `jsonb_build_array()` produces `[]` for every membership.
- No group-prefix or group-count query is needed.
- All selected orders share the `[]` pagination partition.
- The query returns only the limited order rows as top-level nodes.
- NestJS returns those order nodes with an empty `parentIds` array.

## Safety and performance decisions

- Request values are passed through Knex bindings.
- SQL identifiers come only from the grouping/filter field registry.
- Joins and filters run before path expansion.
- Memberships are deduplicated before counting and pagination.
- Only leaf memberships are ranked for order pagination.
- Counts are calculated from the complete filtered set and are unaffected by the order page size.
- PostgreSQL returns flat rows; NestJS performs the inexpensive response-shape conversion.
- Partial and composite indexes support the A and W hierarchy joins and common order filters.

## Current implementation note

The current repository implementation still prepends `root.name` to `full_group_path`. The latest agreed target is to remove that synthetic root and use only the requested `groupBy` fields, as demonstrated by the SQL above.

Completing that adjustment requires coordinated changes to:

1. Membership path construction.
2. Pagination path-depth validation.
3. The zero-grouping query branch.
4. NestJS response construction for top-level order nodes.
5. The related unit tests.
