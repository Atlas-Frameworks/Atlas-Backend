# 04 · View engine (`packages/view-engine`)

Pure TypeScript: no network, no database, no timers except ones passed in as functions. Everything here is unit-tested in isolation, and the view-service (05) wires it to the real world. Public API: [contracts.md](../../contracts.md) §6. Plan sections: "View worker internals", "Pagination and live updates", "The hashing rule".

Use the POC domain from `infra/postgres/init/02-schema.sql` (countries, connections, airports, airplanes) for registry definitions and tests.

---

## E-01 · Field registry and filter validation

- **Depends on:** nothing
- **Size:** M
- **Folder:** `src/registry/`

**Goal.** One declarative definition per entity type describes every filterable, groupable and sortable field, its SQL, its joins and its login-scope rule. The SQL compiler (E-02) and the dependency index (E-03) are both generated from it, so they can never disagree.

**Deliverables**

1. Types `EntityTypeDef`, `FieldDef`, `JoinDef`, `ScopeDef`, `Registry` per contracts §6.
   - `JoinDef` declares its link to the related type (`relatedType`, local column, related column), which E-03 uses for invalidation.
   - `ScopeDef` describes how `countries[]` and `connectionId` restrict the type. For airplanes: `a.country_id = ANY($countries)` or `a.country_id IN (SELECT country_id FROM connection_countries WHERE connection_id = $conn)`, plus the connection's `criteria` mapped to registry fields.
2. `defineRegistry(types)`, which checks the registry itself at startup:
   - unique names;
   - each join's related type exists;
   - every field used by a scope, filter or relationship exists;
   - group and sort fields are flagged.
3. `validateFilter(registry, type, tree)`:
   - enforces contracts §5: known fields, allowed operators per field, value types, the limits (depth 4, 20 conditions, `in` ≤ 200, `contains` ≥ 3 characters);
   - returns typed errors with a path into the tree, e.g. `and[1].field`.
4. `normalizeFilter(tree)`:
   - flattens nested `and`/`or` of the same kind;
   - sorts children deterministically;
   - sorts and dedupes `in` arrays;
   - normalizes numbers and strings.
5. `viewKey(type, scope, tree)`: a stable hash (SHA-256, base64url, first 22 characters) of the normalized query. Identical queries written differently must give the same key.
6. `registry/poc.ts`: the POC registry for the 4 entity types, including:
   - `airplanes.airline`, `aircraftKind`, `callsign` (contains), `altitude`, `speed`;
   - `airport.runwayCount` via join;
   - `airport.country.region` (two hops, to prove multi-hop links);
   - `crew.count` (child table).

**Acceptance criteria**

- [ ] Unit tests cover every operator, every limit and every error path.
- [ ] Property test: random reorderings of the same filter tree give the same `viewKey`; semantically different trees give different keys.
- [ ] No SQL strings are built here; that's E-02.

---

## E-02 · Filter-to-SQL compiler

- **Depends on:** E-01
- **Size:** L
- **Folder:** `src/compiler/`

**Goal.** Turn validated views into safe, parameterized SQL for the four query kinds the workers run.

**Deliverables**

1. `compileFullQuery(reg, view, {layout})`:
   - `SELECT id, sequence, <group fields>, <sort field> FROM ... JOIN ... WHERE <scope> AND <filter>`;
   - used for view builds, full runs after a connection change, reconciliation and the sampler.
2. `compileRecheckBatch(reg, type, views[])`:
   - one statement for a set of candidate views of the same type: `SELECT a.id, a.sequence, (<filter1>) AS m0, (<filter2>) AS m1, ..., <group/sort fields of each layout> FROM ... WHERE a.id = ANY($1::uuid[])`;
   - joins included once even if several views need them;
   - views sharing the same filter template differ only in parameters.
3. `compileRowFetch(reg, type, 'page'|'detail')`: full display rows by `id = ANY($1)`, with nested child data aggregated as JSON (e.g. `jsonb_agg` of crew).
4. **Safety:**
   - only parameters, never string-concatenated values;
   - identifiers come only from the registry;
   - every expression must not throw. Guard casts on JSONB values, e.g. `CASE WHEN jsonb_typeof(x)='number' THEN (x)::numeric END`, because one error fails the whole batch.
5. **Output type** `SqlStatement { text: string; values: unknown[]; columns: ColumnMap }`, so the caller knows which result column belongs to which view.

**Acceptance criteria**

- [ ] Snapshot tests of the generated SQL for the POC registry.
- [ ] Integration test (Testcontainers Postgres with `02-schema.sql` and seed data) runs every generated query, and results match a hand-written reference query for at least 30 filter cases, including a two-hop join, a child-table count, both login-scope modes and `contains`.
- [ ] A filter with a bad JSONB value type in some rows returns `false` for those rows instead of erroring.
- [ ] `EXPLAIN` of a re-check batch of 50 views over 500 IDs uses the primary key and finishes in under 20 ms on the seed data. Record the number.

---

## E-03 · Change-to-view dependency index

- **Depends on:** E-01
- **Size:** M
- **Folder:** `src/dependencies/`

**Goal.** Given one change event, return exactly the views that may be affected, without scanning every view. Missing a view here causes silent staleness, so correctness beats cleverness.

**Deliverables**

1. `DependencyIndex.add(view)` / `remove(viewKey)`. It records the fields each
   view depends on for its scope, filter, layout and related joins.
2. `candidates(evt)`:
   - **For an event of the view's own type:** inspect the field names in
     `changes.old` and `changes.new`. Re-check views that depend on a changed
     field and update any view that already holds the entity ID. An insert has
     every business field in `changes.new`; a delete removes the ID directly.
   - **For an event of a related type** (airport, country, connection): return
     the affected views plus a registry-derived link query description
     (`airplanes WHERE airport_id = ANY($changedAirportIds)`) for the worker;
     - for a connection change, the views using that connection, marked `fullRun: true`.
3. All of this is derived from the registry; no per-type special cases in code.

**Acceptance criteria**

- [ ] Unit tests for: entity moving between countries; airport attribute change; airport reassigned to another country (two hops); connection gains or loses countries; delete events.
- [ ] Property test with E-07: for random events, every view whose full-query result changes is in `candidates` (no false negatives). False positives are allowed but counted.

---

## E-04 · Typed-array view store, sorted pages, group counts

- **Depends on:** nothing (uses its own `RecheckRow` type from contracts §6)
- **Size:** L
- **Folder:** `src/store/`

**Goal.** Hold one view's membership with minimal memory and garbage-collection pressure, and answer "page N of group G" fast.

**Deliverables**

1. **Slot allocator:** entity UUID ↔ dense integer slot (`Map<string, number>` plus a free list). Columns in typed arrays:
   - source `sequence` as `Float64Array` (safe up to 2^53);
   - sort value as `Float64Array`, with strings mapped to rank order through a dictionary;
   - group value ids as `Uint32Array` per grouping level, with dictionary-encoded strings.
2. **`applyFull(rows)`** builds from scratch. **`applyRecheck(rows, checkedIds)`** returns `Diff { added: id[], removed: id[], updated: id[], moved: id[] }`; `moved` means its group or sort position changed. IDs in `checkedIds` but missing from `rows` were deleted.
3. **Per group, a sorted array** of slots ordered by `(sortValue, id)`. Insert and remove by binary search; only changed entries are repositioned.
4. **Group tree** with counts at every level.
5. **`window(groupPath, page, size)`** returns `{ orderedIds, total, pageCount }`.
6. **`entitiesHeld()` and `approxBytes()`** for memory caps.

**Acceptance criteria**

- [ ] Correctness: randomized test (10,000 operations) against a naive reference implementation built with plain arrays and sort.
- [ ] Performance, recorded in the PR:
  - 30,000 entities, 2 grouping levels: `applyFull` under 50 ms;
  - `applyRecheck` of 500 changed IDs under 5 ms;
  - `window` under 1 ms;
  - memory under 3 MB per 30,000 entities, excluding the UUID map.
- [ ] Ties in sort value keep a stable order by ID across ticks.

---

## E-05 · Tick batcher, sequence tracker, dirty IDs

- **Depends on:** E-03
- **Size:** M
- **Folder:** `src/tick/`

**Goal.** The per-tick bookkeeping that makes the system detect loss instead of drifting silently.

**Deliverables**

1. **`SequenceTracker.observe(type, typeSeq)`:**
   - returns `ok`, `duplicate` (≤ last seen) or `gap` (> last + 1);
   - `reset(type)` after a reload;
   - initial state "unknown" accepts the first value seen.
2. **`TickBatcher`:**
   - collects events between ticks;
   - keeps only the highest source `sequence` per (type, id), while deletes remain ordered by `typeSeq`;
   - separates deletes;
   - asks `DependencyIndex` for candidates;
   - groups re-check work by type: `{ type, ids[], viewKeys[], linkQueries[], fullRunViewKeys[] }`.
3. **Dirty IDs:** `markInFlight(viewKey, ids)` before a query starts and `complete(viewKey)` after. Any event for an in-flight (view, id) arriving meanwhile is kept and re-checked next tick; it is never dropped. The same applies to full runs.
4. **Version guard:** `isStale(rowVersion, eventVersion)` → retry next tick.

**Acceptance criteria**

- [ ] Unit tests: gap, duplicate, reset; 1,000 events for 10 IDs collapse to 10; an event during in-flight shows up in the next drain.
- [ ] No timers inside; the caller drives ticks.

---

## E-06 · Rendezvous hashing and membership model

- **Depends on:** nothing
- **Size:** S
- **Folder:** `src/cluster/`

**Goal.** Every worker computes the same owner for a view from the same worker list, and the list is stable under brief blips.

**Deliverables**

1. `ownerOf(viewKey, workers)`: rendezvous hashing, score = 64-bit hash (xxhash64 or the first 8 bytes of SHA-1) of `viewKey + '\0' + workerName`, highest wins, ties broken by name.
2. `ranked(viewKey, workers)`: the full ordering, for later bounded-load use.
3. **`Membership` model,** fed by S-06:
   - `update(entries, epoch, now)` → `eligibleWorkers`;
   - flap damping: a worker becomes eligible only after it has been continuously present for `minPresenceMs` (default 10 000);
   - `epoch` exposed so S-07 can tag messages.

**Acceptance criteria**

- [ ] Distribution test: 1,000 keys over 3 workers stay within ±10% of even; adding a 4th worker moves about 25% of keys, and only to the new worker.
- [ ] Removing a worker moves only that worker's keys.
- [ ] Flap test: a worker missing for 2 s and back doesn't become eligible again until 10 s after its return.

---

## E-07 · Incremental-vs-full property test harness

- **Depends on:** E-02, E-04 (and E-03, E-05 when available)
- **Size:** M
- **Folder:** `test/property/` in view-engine; runs in CI against Testcontainers Postgres

**Goal.** Prove, on every PR, that applying changes incrementally always ends in the same state as running each view's full query from scratch. This is the main guard against missed cross-entity links.

**Deliverables**

1. **Generator** for random but valid sequences of operations on the POC schema:
   - entity updates (including relationship-field changes);
   - child-row changes;
   - airport moves;
   - country region changes;
   - connection edits;
   - deletes.

   Each operation runs through a tiny write helper that bumps versions and produces the matching `OutboxEvent`.
2. **Random views:** generated from the registry; 50 per run.
3. **Each step:**
   1. apply the operation to Postgres;
   2. feed the event through `TickBatcher` → `DependencyIndex` → re-check SQL → `ViewStore`;
   3. then compare every view with a fresh `compileFullQuery` result.
4. **On mismatch,** print a minimal reproduction: operations, view filter and differing IDs. Use a seeded random generator, with the seed in the output.

**Acceptance criteria**

- [ ] 200 operations × 50 views run in CI in under 2 minutes with zero mismatches.
- [ ] Deliberately breaking a join link in the registry makes the test fail, showing it catches missed invalidations.
