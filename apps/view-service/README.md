# @atlas/view-service

NestJS view workers. Set `DATABASE_URL` to override the local `atlas_reader` connection.

```bash
npm run start:dev -w @atlas/view-service
npm test -w @atlas/view-service
```

`start:dev` runs the TypeScript sources directly with `tsx` and restarts when an
imported source file changes. It does not rebuild `dist`; run `npm run build -w
@atlas/view-service` only when compiled production output is needed.

## Dynamic W/A order tree

`POST /order-groups` infers the required W and A query branches from the
non-empty origin ID arrays, groups their orders using the requested allowlisted
fields, and returns groups plus paginated order nodes in one depth-first flat
`nodes` array.

PostgreSQL performs the joins, filtering, distinct counts, path-prefix creation,
and leaf pagination. It returns flat group and order-membership rows; NestJS
connects those rows and creates the final ordered `nodes` response.

```json
{
  "wCampaignIds": ["10000000-0000-4000-8000-000000000001"],
  "wMissionIds": [],
  "wPlanIds": [],
  "aPlanIds": [],
  "aMissionIds": [],
  "aObjectiveIds": [],
  "groupBy": ["W_MISSION_NAME", "W_PLAN_CATEGORY", "ORDER_STATUS"],
  "filters": [
    { "field": "ORDER_COUNTRY", "operator": "EQ", "value": "IL" },
    { "field": "ORDER_PRIORITY", "operator": "GTE", "value": 2 }
  ],
  "defaultLimit": 3,
  "pagination": [
    {
      "path": {
        "W_MISSION_NAME": "W Mission North",
        "W_PLAN_CATEGORY": "GROUND",
        "ORDER_STATUS": "NEW"
      },
      "limit": 20,
      "offset": 0
    }
  ]
}
```

Filter operators are `EQ`, `NE`, `GT`, `GTE`, `LT`, `LTE`, and `IN`. W-only
fields start with `W_`, A-only fields start with `A_`, and `ORDER_` fields work
for both origins. A request that selects both W and A may group and filter only
by shared `ORDER_` fields. The root groups are the selected W campaign names
and A plan names. At least one origin ID array must be non-empty.

Group paths are JSON objects keyed by their grouping dimensions, such as
`{"ORDER_STATUS":"NEW","W_MISSION_NAME":"W Mission North"}`. Pass the
leaf group's returned `path` object in a pagination entry; no serialized path key is required.
Group totals count all distinct matching orders independently of pagination.

`POST /order-groups/orders` uses the same origin IDs, grouping, and filters,
then accepts `groupIds`, `findNodes`, `excludeNodes`, and `excludeGroups`:

```json
{
  "wCampaignIds": [],
  "wMissionIds": [],
  "wPlanIds": [],
  "aPlanIds": ["20000000-0000-4000-8000-000000000001"],
  "aMissionIds": [],
  "aObjectiveIds": [],
  "groupBy": ["A_MISSION_NAME", "A_OBJECTIVE_CATEGORY"],
  "filters": [],
  "groupIds": ["{\"A_MISSION_NAME\":\"A Mission East\",\"A_PLAN_NAME\":\"A Plan Alpha\"}"],
  "findNodes": [],
  "excludeNodes": [],
  "excludeGroups": []
}
```

Each returned order includes `id`, `name`, `number`, `status`, `country`,
`priority`, `amount`, and `category`.
