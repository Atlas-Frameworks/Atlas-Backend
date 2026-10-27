# Dynamic Order Grouping: Work Summary

## Purpose

This document summarizes the order-grouping design and implementation work completed during the session. The goal is to let a client request a filtered hierarchy of orders, receive group counts and an initial page of orders for every deepest group, and subsequently request a different page size or offset for an individual group.

The database performs relational filtering, membership construction, distinct counting, and per-leaf pagination. NestJS converts the flat database rows into the ordered flat-node response expected by the client.

## Handoff status

This document is intended to be sufficient context for continuing the work in a new Codex session.

As of October 27, 2026:

- Repository: `Atlas-Backend`.
- Branch: `codex/delivery-company`.
- Current HEAD when this document was expanded: `bce4726` (`md`).
- Main grouping endpoint: `POST /order-groups`.
- Complete-order lookup endpoint: `POST /order-groups/orders`.
- The current implementation works with a synthetic source-root folder (`root.name`).
- The latest agreed design removes that synthetic folder. This decision is documented but has not yet been implemented.
- The new Markdown file was untracked at the time of writing and still needed to be added and committed.

Do not assume that the no-root behavior described later is already present in the TypeScript implementation. The "Current behavior versus agreed target" section lists the required changes.

## Decisions made during the session

1. PostgreSQL should perform relational filtering, distinct membership construction, group counting, and per-leaf order pagination.
2. NestJS should not ask PostgreSQL to build the final response JSON. PostgreSQL returns flat rows and NestJS converts them into the client node format.
3. The origin hierarchy locates orders; it is separate from the visible `groupBy` hierarchy.
4. The request does not expose a required A/W source discriminator. The backend infers the required SQL branch from the populated origin-ID arrays.
5. The same `orders` table contains both A and W orders.
6. A request that selects both A and W origins may group or filter only by fields supported by both sources, currently the shared order fields.
7. Group IDs are complete serialized JSON paths, not standalone names.
8. Counts always describe the complete filtered group, not only the currently paginated orders.
9. Every deepest folder initially contains `defaultLimit` orders.
10. The API supports a different limit and offset for each deepest folder.
11. The chosen single-endpoint refresh model should normally use offset `0` and a growing limit (`10`, `20`, `30`, and so on) for load-more. This lets the client replace the complete response after recalculation without manually appending pages.
12. Pagination state must be retained by the client and resent after an entity update; otherwise a recalculated tree returns to `defaultLimit`.
13. The final client representation is a depth-first flat array of nodes connected through `children` and `parentIds`, not a recursively nested JSON tree.
14. The latest decision is not to return a synthetic root folder. With no grouping fields, orders should be top-level nodes.

## Repository code map

| Responsibility | File |
| --- | --- |
| Controller routes | `apps/view-service/src/order-groups/order-groups.controller.ts` |
| Service orchestration | `apps/view-service/src/order-groups/order-groups.service.ts` |
| Group-tree Knex query | `apps/view-service/src/order-groups/order-groups-query.ts` |
| Complete-order Knex query | `apps/view-service/src/order-groups/group-orders-query.ts` |
| A/W joins and shared path filtering | `apps/view-service/src/order-groups/order-group-query-support.ts` |
| Grouping-field registry | `apps/view-service/src/order-groups/order-grouping-dimension.ts` |
| Filter operators and bindings | `apps/view-service/src/order-groups/order-filter.ts` |
| Flat-row to node conversion | `apps/view-service/src/order-groups/grouping-response.ts` |
| Request DTOs | `apps/view-service/src/order-groups/dto/` |
| Response/query types | `apps/view-service/src/order-groups/order-groups.types.ts` |
| PostgreSQL schema and indexes | `infra/postgres/init/02-schema.sql` |
| Production-safe concurrent index script | `infra/postgres/migrations/01-order-tree-indexes.sql` |
| Small deterministic seed | `infra/postgres/seed/01-initial-data.sql` |
| 60,000-order load seed | `infra/postgres/seed/02-order-groups-load.sql` |
| Query and response tests | `apps/view-service/src/order-groups/*.spec.ts` |

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

## Relevant table fields

All primary and foreign keys are UUIDs.

| Entity | Important fields |
| --- | --- |
| `w_campaigns` | `id`, `name`, `number`, `status`, `country`, `updated_at` |
| `w_missions` | `id`, `name`, `number`, `status`, `country`, `campaign_id`, `updated_at` |
| `w_plans` | `id`, `name`, `number`, `status`, `country`, `category`, `updated_at` |
| `w_mission_plans` | `mission_id`, `plan_id` |
| `a_plans` | `id`, `name`, `number`, `status`, `country`, `updated_at` |
| `a_missions` | `id`, `name`, `number`, `status`, `country`, `a_plan_id`, `updated_at` |
| `a_objectives` | `id`, `name`, `number`, `status`, `country`, `category`, `a_mission_id`, `a_plan_id`, `updated_at` |
| `orders` | `id`, `source`, `name`, `number`, `status`, `country`, `priority`, `amount`, `category`, `w_plan_id`, `a_objective_id`, `updated_at` |

An order has exactly one active origin pointer:

- W order: `w_plan_id IS NOT NULL` and `a_objective_id IS NULL`.
- A order: `a_objective_id IS NOT NULL` and `w_plan_id IS NULL`.

The database currently stores `orders.source` and enforces that invariant. The public API still does not require the client to specify the source; NestJS infers the branch before executing SQL.

## Expected production scale

The following production counts were provided during the session and were not independently queried from this workspace:

| Entity | Reported count |
| --- | ---: |
| W campaigns | 25 |
| W missions | 2,100 |
| W plans | 9,100 |
| A plans | 800 |
| A missions | 4,900 |
| A objectives | 25,500 |
| Orders | 220,000 |

There are more A orders than W orders. A realistic request may use approximately six grouping/filtering fields. Six prefix levels over 220,000 memberships can create up to roughly 1.32 million intermediate node-membership rows before deduplication and aggregation, so query plans and group cardinality matter.

The local load seed adds 60,000 orders: 30,000 A orders and 30,000 W orders. The deterministic seed additionally creates a small dataset for manual checks.

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

## Supported grouping and filtering fields

Grouping and filtering use the same trusted field registry. Request values are bound as SQL values; column identifiers are never taken directly from client strings.

### W-only fields

- `W_CAMPAIGN_NAME`, `W_CAMPAIGN_NUMBER`, `W_CAMPAIGN_STATUS`, `W_CAMPAIGN_COUNTRY`
- `W_MISSION_NAME`, `W_MISSION_NUMBER`, `W_MISSION_STATUS`, `W_MISSION_COUNTRY`
- `W_PLAN_NAME`, `W_PLAN_NUMBER`, `W_PLAN_STATUS`, `W_PLAN_COUNTRY`, `W_PLAN_CATEGORY`

### A-only fields

- `A_PLAN_NAME`, `A_PLAN_NUMBER`, `A_PLAN_STATUS`, `A_PLAN_COUNTRY`
- `A_MISSION_NAME`, `A_MISSION_NUMBER`, `A_MISSION_STATUS`, `A_MISSION_COUNTRY`
- `A_OBJECTIVE_NAME`, `A_OBJECTIVE_NUMBER`, `A_OBJECTIVE_STATUS`, `A_OBJECTIVE_COUNTRY`, `A_OBJECTIVE_CATEGORY`

### Fields shared by both sources

- `ORDER_NAME`
- `ORDER_NUMBER`
- `ORDER_STATUS`
- `ORDER_COUNTRY`
- `ORDER_PRIORITY`
- `ORDER_AMOUNT`
- `ORDER_CATEGORY`

Supported filter operators are `EQ`, `NE`, `GT`, `GTE`, `LT`, `LTE`, and `IN`.

- `EQ null` becomes `IS NULL`.
- `NE` uses PostgreSQL `IS DISTINCT FROM`, which is null-safe.
- `GT`, `GTE`, `LT`, and `LTE` reject `null`.
- `IN` requires a non-empty array of scalar values.
- Scalars may be strings, numbers, booleans, or `null`.

When both A and W origins are selected, source-specific grouping or filter fields are rejected because they cannot be evaluated consistently for every selected order.

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

### Current NestJS response builder

`OrderGroupsService.findGroups()` runs the Knex query and passes its rows to `buildGroupingResponse()`:

```ts
async findGroups(request: OrderGroupsRequestDto): Promise<GroupingResponse> {
  const rows = await buildOrderGroupsQuery(this.database, request);
  return buildGroupingResponse(rows);
}
```

The response builder performs these steps:

```ts
export function buildGroupingResponse(
  rows: readonly OrderGroupQueryRow[],
): GroupingResponse {
  const groups = createGroups(rows);
  connectGroups(groups);
  const orders = createOrders(rows, groups);
  sortGroupChildren(groups);
  return { nodes: orderNodesDepthFirst(groups, orders) };
}
```

The relationship rules are:

```ts
const groupId = serializeGroupPath(groupRow.groupPath);
const parentId = serializeGroupPath(groupRow.parentPath);
groups.get(parentId)?.childIds.add(groupId);
```

For an order membership:

```ts
const leafId = serializeGroupPath(orderRow.groupPath);
groups.get(leafId)?.childIds.add(orderRow.orderId);
order.parentIds.add(leafId);
```

For example:

```text
group ["NEW"]            parentPath = null
group ["NEW", "IL"]     parentPath = ["NEW"]
order order-123           groupPath  = ["NEW", "IL"]
```

NestJS therefore attaches `["NEW", "IL"]` below `["NEW"]` and attaches `order-123` below `["NEW", "IL"]`.

### Shared-order behavior

An order can have more than one membership, especially in the W hierarchy where a plan may belong to multiple missions. The response builder:

- Keeps every relevant leaf ID in the order node's `parentIds`.
- Keeps the order ID in every relevant group's `children` list.
- Emits the actual order node only once in the flat output, under the lexicographically first display parent.

This prevents duplicate node objects while preserving all relationships. A future client must resolve node references by ID rather than assuming that every child object is repeated immediately after every parent.

### Ordering behavior

Groups and child IDs are sorted lexicographically by their serialized IDs. The final SQL does not define the client display order; `orderNodesDepthFirst()` creates the display sequence:

```text
group
  child groups, recursively
  directly displayed orders
```

If the product requires semantic ordering, numeric ordering, or a user-selected sort field, that must be added explicitly. The current behavior is stable lexical ordering.

## `POST /order-groups` API

### Current request limits

| Property | Rule |
| --- | --- |
| Origin IDs | At least one A or W origin ID across all arrays; each array allows up to 10,000 unique UUIDs |
| `groupBy` | Required array, unique values, maximum 10 |
| `filters` | Optional array, maximum 20 |
| `defaultLimit` | Integer from 1 through 1,000; default 10 |
| `pagination` | Optional object keyed by serialized complete leaf paths |
| Pagination `limit` | Integer from 1 through 1,000 |
| Pagination `offset` | Non-negative PostgreSQL integer |

Origin arrays are:

- `wCampaignIds`
- `wMissionIds`
- `wPlanIds`
- `aPlanIds`
- `aMissionIds`
- `aObjectiveIds`

### Current Postman example

```http
POST http://localhost:3000/order-groups
Content-Type: application/json
```

```json
{
  "aPlanIds": [
    "20000000-0000-4000-8000-000000000001"
  ],
  "groupBy": [
    "ORDER_STATUS",
    "ORDER_COUNTRY"
  ],
  "filters": [],
  "defaultLimit": 3,
  "pagination": {}
}
```

The deterministic seed contains the A plan above. The large seed attaches its A objectives to the same plan.

### Current load-more request

The current implementation prepends `root.name`, so the pagination key currently contains the source root:

```json
{
  "aPlanIds": [
    "20000000-0000-4000-8000-000000000001"
  ],
  "groupBy": [
    "ORDER_STATUS",
    "ORDER_COUNTRY"
  ],
  "filters": [],
  "defaultLimit": 3,
  "pagination": {
    "[\"A Plan Alpha\", \"NEW\", \"IL\"]": {
      "limit": 6,
      "offset": 0
    }
  }
}
```

After the no-root change, the same override key must become:

```json
"[\"NEW\", \"IL\"]"
```

### Representative response

```json
{
  "nodes": [
    {
      "id": "[\"A Plan Alpha\"]",
      "name": "A Plan Alpha",
      "parentIds": [],
      "total": 30012,
      "children": [
        "[\"A Plan Alpha\", \"NEW\"]"
      ]
    },
    {
      "id": "[\"A Plan Alpha\", \"NEW\"]",
      "name": "NEW",
      "parentIds": [
        "[\"A Plan Alpha\"]"
      ],
      "total": 7503,
      "children": [
        "[\"A Plan Alpha\", \"NEW\", \"IL\"]"
      ]
    },
    {
      "id": "[\"A Plan Alpha\", \"NEW\", \"IL\"]",
      "name": "IL",
      "parentIds": [
        "[\"A Plan Alpha\", \"NEW\"]"
      ],
      "total": 1500,
      "children": [
        "order-uuid-1",
        "order-uuid-2",
        "order-uuid-3"
      ]
    },
    {
      "id": "order-uuid-1",
      "name": "A Load Order 20",
      "parentIds": [
        "[\"A Plan Alpha\", \"NEW\", \"IL\"]"
      ],
      "total": 0,
      "children": []
    }
  ]
}
```

The totals above illustrate the shape and must not be treated as guaranteed values for every database state.

## Client flow with the single endpoint

### Initial request

1. The client sends origins, filters, ordered `groupBy`, `defaultLimit`, and no overrides.
2. PostgreSQL calculates every group and total.
3. PostgreSQL returns up to `defaultLimit` orders for every deepest group.
4. NestJS builds and returns the complete flat node list.
5. The client initially displays folders collapsed.

### Load more

For the agreed replacement-response model:

1. The user opens a deepest group and clicks load more.
2. The client records that group's new cumulative limit.
3. The client resends the complete request with that path override, normally `offset: 0` and `limit: previousLimit + pageSize`.
4. The backend recalculates the tree and returns the first cumulative `limit` orders for that leaf.
5. The client replaces its previous node array with the new response.

The SQL also supports fixed-size pages with increasing offsets, but that model requires client-side appending and more complicated reconciliation after updates. It was not the preferred flow at the end of the discussion.

### Entity update

1. An order or related entity changes.
2. The tree request is rerun because filters, group membership, and counts may have changed.
3. The client resends every currently expanded leaf's cumulative limit.
4. The backend returns a fresh complete node array while preserving the user's loaded amounts where those paths still exist.
5. If a path disappears or changes because a grouped value changed, the client discards obsolete pagination state for that path.

## Group-order lookup endpoint

The separate `POST /order-groups/orders` query supports retrieving complete order records using:

- Multiple included group paths.
- Explicitly included order IDs.
- Explicitly excluded order IDs.
- Excluded group paths.
- Parent or leaf group paths.

The database applies these selections directly and deduplicates orders before returning them.

### Request example

```http
POST http://localhost:3000/order-groups/orders
Content-Type: application/json
```

```json
{
  "aPlanIds": [
    "20000000-0000-4000-8000-000000000001"
  ],
  "groupBy": [
    "ORDER_STATUS",
    "ORDER_COUNTRY"
  ],
  "filters": [],
  "groupIds": [
    "[\"A Plan Alpha\", \"NEW\"]",
    "[\"A Plan Alpha\", \"DONE\", \"IL\"]"
  ],
  "findNodes": [
    "550e8400-e29b-41d4-a716-446655440000"
  ],
  "excludeNodes": [
    "550e8400-e29b-41d4-a716-446655440001"
  ],
  "excludeGroups": [
    "[\"A Plan Alpha\", \"NEW\", \"US\"]"
  ]
}
```

Current semantics are:

```text
(orders selected by groupIds OR orders selected by findNodes)
MINUS
(orders selected by excludeGroups OR orders selected by excludeNodes)
```

Important details:

- `groupIds` is currently required and must contain at least one serialized path.
- A group path may point to any hierarchy depth, not only a leaf.
- Group paths may not exceed the complete current path depth.
- No pagination, totals, grouping nodes, or JSON aggregation are used by this endpoint.
- PostgreSQL applies exclusion with an anti-join.
- Results are deduplicated in PostgreSQL.
- Current returned order fields are `id`, `name`, `number`, `status`, `country`, `priority`, `amount`, and `category`.
- The current implementation still expects `root.name` as the first path value. The no-root change must update this endpoint at the same time as the tree endpoint.

Representative response:

```json
{
  "orders": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "A Order 1",
      "number": 4001,
      "status": "PROCESSING",
      "country": "US",
      "priority": 2,
      "amount": "38.25",
      "category": "EXPRESS"
    }
  ]
}
```

## Current Knex query pipeline

`buildOrderGroupsQuery()` currently builds these CTEs:

1. `memberships`: filtered, distinct `(order_id, order_name, full_group_path)` rows from the required A/W branches.
2. `node_counts`: one query per hierarchy depth, combined with `UNION ALL`.
3. `pagination_overrides`: converts the validated request object into a PostgreSQL relation through `jsonb_array_elements`.
4. `ranked_leaf_orders`: partitions memberships by complete leaf path and assigns `row_number()`.
5. `paginated_leaf_orders`: applies the leaf's offset and limit.
6. Final `UNION ALL`: returns flat group rows and flat order-membership rows.

The current top-level structure is:

```ts
return database
  .with('memberships', buildMemberships(database, selection, dimensions))
  .with('node_counts', buildNodeCounts(database, pathLength))
  .with(
    'pagination_overrides',
    buildPaginationOverrides(database, pagination),
  )
  .with(
    'ranked_leaf_orders',
    buildRankedLeafOrders(database, request.defaultLimit),
  )
  .with('paginated_leaf_orders', buildPaginatedLeafOrders(database))
  .select('*')
  .from(resultRows.as('result_row'));
```

### Current membership builder

The repository currently includes `root.name` even when the client did not request it:

```ts
function buildMemberships(
  database: Knex,
  selection: OrderDomainSelection,
  dimensions: readonly GroupingDimensionDefinition[],
): Knex.QueryBuilder {
  const pathColumns = [
    'root.name',
    ...dimensions.map(({ column }) => column),
  ];

  const sourceQueries = buildOrderDomainQueries(database, selection).map(
    ({ query }) =>
      query
        .select({
          order_id: 'customer_order.id',
          order_name: 'customer_order.name',
        })
        .select(buildGroupPathExpression(database, pathColumns)),
  );

  const combinedMemberships = database
    .queryBuilder()
    .unionAll(sourceQueries, true);

  return database
    .from(combinedMemberships.as('origin_membership'))
    .distinct(
      'origin_membership.order_id',
      'origin_membership.order_name',
      'origin_membership.full_group_path',
    );
}
```

The target change is only to use the requested dimensions for the visible path:

```ts
const pathColumns = dimensions.map(({ column }) => column);
```

`buildGroupPathExpression()` safely produces:

```sql
jsonb_build_array(identifier_1, identifier_2, ...)
```

The identifiers come from the registry. With zero columns it produces `jsonb_build_array()`, whose PostgreSQL result is `[]`.

`DISTINCT` belongs around the complete membership row, not inside `jsonb_build_array`. The array function only constructs a value for one input row; it cannot remove duplicate input rows.

### Current prefix-count builder

For every level from `1` through the path length, Knex builds a prefix relation containing:

```text
order_id | level | group_path | group_name
```

It deduplicates those rows, groups by the node identity, and counts the order IDs. This prevents a join duplicate from increasing a folder total.

When the no-root design is implemented and `groupBy` is empty, `buildNodeCounts()` must not be called because there are no group levels to count.

### Current pagination builder

The ranking is conceptually:

```sql
row_number() OVER (
  PARTITION BY full_group_path
  ORDER BY order_id
)
```

The final page predicate is:

```sql
row_number > page_offset
AND row_number <= page_offset + page_limit
```

Only complete leaf paths may currently have pagination overrides. Parent-group pagination is rejected.

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

## Existing indexes relevant to the grouping query

The schema creates indexes for both benchmark schemas. The production-oriented migration creates the following indexes on `benchmark_publisher` with `CONCURRENTLY`:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS publisher_w_missions_tree_filter_idx
  ON benchmark_publisher.w_missions
  (campaign_id, status, country, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS publisher_w_plans_filter_idx
  ON benchmark_publisher.w_plans
  (status, country, category, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS publisher_a_missions_tree_filter_idx
  ON benchmark_publisher.a_missions
  (a_plan_id, status, country, id);

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
```

The migration finishes by analyzing the hierarchy and order tables. Run the migration outside a surrounding transaction because PostgreSQL does not allow `CREATE INDEX CONCURRENTLY` inside a transaction block.

Indexes should be selected from real production predicates and `EXPLAIN (ANALYZE, BUFFERS)` results. Adding an index for every possible grouping field would increase write cost and storage without guaranteeing a better grouping plan.

## Performance context and risks

One exploratory query during the session was reported as taking approximately 5.5 seconds. The exact `EXPLAIN ANALYZE` output was not preserved, so this number must not be treated as a reproducible benchmark. Earlier millisecond-level observations referred to small or bounded queries and are not comparable to a complete hierarchy calculation.

The expensive operations are potentially:

1. Joining and filtering the complete selected order set.
2. Removing duplicate memberships.
3. Expanding every order into one prefix membership per grouping level.
4. Grouping and counting every prefix.
5. Sorting orders inside every leaf for `row_number()`.
6. Returning the initial page for every leaf, which can still be large when leaf cardinality is high.

PostgreSQL is still the correct place for filtering, deduplication, counts, and pagination. Moving those operations into Node.js would transfer many more rows, increase application memory usage, and risk inconsistent counts. NestJS should only perform the lightweight relationship-map and depth-first flattening steps.

### Required performance investigation

For a representative slow production request:

1. Capture the exact generated SQL and bindings without logging secrets.
2. Run `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)` against a safe production-like environment.
3. Record selected order count, number of unique leaves, number of returned group rows, and number of returned order rows.
4. Look for sequential scans on highly selective origin predicates, large sort spills, repeated CTE scans, and inaccurate row estimates.
5. Confirm `ANALYZE` statistics are current.
6. Compare execution with realistic grouping depths and cardinalities, not only `LIMIT 100` on the source orders.
7. Consider `work_mem` only after confirming sort/hash spills; do not globally increase it based on one query.

### CTE and materialization decision

The current generated SQL does not use `MATERIALIZED`. This lets supported PostgreSQL versions inline eligible CTEs or choose another plan. Materialization can force an intermediate result to be written and rescanned; it should be used only when an execution plan proves it beneficial.

`MATERIALIZED` itself is not a table-locking mechanism. A normal read query still takes the ordinary read locks required for statement consistency. The reason to avoid forced materialization here is primarily planning flexibility and intermediate-result cost, not elimination of all database locks.

## Edge cases and invariants

- Empty database result returns `{ "nodes": [] }`.
- `null` is a valid grouping value. It remains JSON `null` in the group path and is displayed with name `"null"`.
- Parent counts use distinct orders and must not depend on pagination.
- A group is omitted when it has no matching orders. The current order-grouping system does not have a separate configured group-definition table from which empty groups could be generated.
- The same group name under different parents is safe because identity uses the complete path.
- The same order can belong to multiple paths. Membership identity is `(order_id, full_group_path)`.
- A final SQL `UNION ALL` may return rows in any physical order. NestJS must not depend on database row order.
- Pagination requires a deterministic order. The current tie-breaker is the UUID `order_id`.
- Offset pagination is supported but can shift if orders are inserted, removed, or regrouped between requests. The cumulative-limit/offset-zero refresh flow reduces client merge complexity but does not provide snapshot isolation across separate HTTP requests.
- A pagination override currently must identify a complete leaf path exactly.
- Both A and W may be selected together, but only shared fields may be used in `groupBy` or filters.
- `findNodes` supplements `groupIds`; it does not currently replace the requirement for at least one `groupId`.

## Local setup and useful commands

From the repository root:

```powershell
npm run build
npm test
npm run typecheck
npm run lint
```

View-service-specific commands:

```powershell
npm run start --workspace @atlas/view-service
npm test --workspace @atlas/view-service
npm run typecheck --workspace @atlas/view-service
npm run lint --workspace @atlas/view-service
```

The Knex ESM import must keep the runtime and type imports separate:

```ts
import knex from 'knex';
import type { Knex } from 'knex';
```

Using `import knex, { Knex } from 'knex'` under Node.js 24 causes the runtime error:

```text
SyntaxError: The requested module 'knex' does not provide an export named 'Knex'
```

## Verification status

The focused command attempted while expanding this handoff document was:

```powershell
npm test --workspace @atlas/view-service -- src/order-groups
```

It did not execute any tests because Vitest failed while renaming a temporary SSR cache directory under the Windows sandbox:

```text
EPERM: operation not permitted, rename ...\Temp\...\ssr\.tmp-* -> ...\ssr\*
```

This appears environmental and unrelated to the Markdown change or grouping logic. Six suites were discovered, but all reported `0 test` because module transformation did not start. No retry or test-harness modification was performed.

The existing test sources cover:

- W and A branch construction.
- Mixed A/W origins.
- Source-incompatible dimensions.
- Filters and null-safe equality.
- Flat SQL rows without PostgreSQL response JSON.
- Pagination override validation.
- Parent and leaf group order lookup.
- Explicit order inclusion/exclusion.
- Depth-first response ordering.
- Shared-order uniqueness.
- DTO validation.
- Empty results.

Before pushing functional changes, rerun the repository-required build, test, typecheck, and lint commands in a non-blocked environment.

## Current behavior versus agreed target

The current repository implementation still prepends `root.name` to `full_group_path`. The latest agreed target is to remove that synthetic root and use only the requested `groupBy` fields, as demonstrated by the SQL above.

### Current behavior

- `pathLength = dimensions.length + 1`.
- Membership path columns are `['root.name', ...groupColumns]`.
- A request with no grouping fields still returns a source-root folder.
- Pagination IDs begin with the source root name.
- `group-orders-query.ts` interprets the first group-path value as `root.name`.
- The response builder assumes every order membership has a corresponding group node.

### Target behavior

- `groupDepth = dimensions.length`.
- Membership path columns contain only requested grouping columns.
- With no grouping fields, every membership has `full_group_path = []`.
- With no grouping fields, the SQL skips group counting and returns only the paginated orders.
- Those orders become top-level response nodes with `parentIds: []`.
- Pagination key `[]` controls the ungrouped order partition.
- Group-order lookup paths contain only the requested grouping values.

### Required implementation steps

1. Membership path construction.
   - Change `['root.name', ...dimensions]` to only the dimension columns.
   - Preserve outer `DISTINCT(order_id, order_name, full_group_path)`.
2. Path depth.
   - Change the tree query's expected leaf path length from `dimensions.length + 1` to `dimensions.length`.
   - Change the complete-order query's maximum depth and column slicing to exclude `root.name`.
3. Empty grouping branch.
   - Do not call `buildNodeCounts()` when `groupDepth === 0`.
   - Keep memberships and ranking; all orders partition under `[]`.
   - Return only order rows, with a logical order level of `1`.
4. Grouped branch.
   - Build levels `1..groupDepth`.
   - Return order rows at `groupDepth + 1`.
5. Response construction.
   - Detect order rows with `groupPath.length === 0`.
   - Create them as top-level order records rather than looking up a group with ID `[]`.
   - Include top-level orders in the depth-first output even when the group map is empty.
6. Complete-order endpoint.
   - Build path filters from `dimensions.slice(0, path.length)`.
   - Allow paths from depth `1` through `dimensions.length`.
   - Decide explicitly what `POST /order-groups/orders` should do when `groupBy` is empty, because its DTO currently requires at least one `groupId`.
7. API examples and clients.
   - Remove root names from group IDs and pagination keys.
   - Treat existing root-prefixed IDs as incompatible unless a migration/compatibility layer is intentionally added.
8. Tests.
   - Update current root-prefixed expectations.
   - Add empty-`groupBy` coverage.
   - Add top-level pagination override `[]` coverage.
   - Add top-level order response coverage.
   - Recheck parent groups, leaf groups, shared orders, reversed grouping order, null groups, and empty results.

### Suggested target orchestration

```ts
const groupDepth = dimensions.length;
const orderLevel = groupDepth + 1;
const pagination = parsePaginationOverrides(
  request.pagination,
  groupDepth,
);

const query = database
  .with('memberships', buildMemberships(database, selection, dimensions))
  .with(
    'pagination_overrides',
    buildPaginationOverrides(database, pagination),
  )
  .with(
    'ranked_leaf_orders',
    buildRankedLeafOrders(database, request.defaultLimit),
  )
  .with('paginated_leaf_orders', buildPaginatedLeafOrders(database));

if (groupDepth === 0) {
  return query
    .select('*')
    .from(buildOrderMembershipRows(database, orderLevel).as('result_row'));
}

return query
  .with('node_counts', buildNodeCounts(database, groupDepth))
  .select('*')
  .from(buildGroupedResultRows(database, orderLevel).as('result_row'));
```

## New-session starting prompt

The following prompt can be used in a new session:

```text
Read docs/order-grouping-work-summary.md completely, then inspect the files listed
in its Repository code map. Continue the documented no-synthetic-root change.
Do not change the public grouping enum or introduce a second grouping system.
Keep filtering, distinct counting, and per-leaf pagination in PostgreSQL, and keep
the final flat-node construction in NestJS. Update both /order-groups and
/order-groups/orders consistently, add the listed tests, and run the smallest
targeted verification before the repository-wide commands.
```
