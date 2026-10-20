# 08 · Write path and replicator (`apps/replicator-sim`, NestJS)

In production the replicator polls third-party sources and is the **only** writer to Postgres. For the POC, `replicator-sim` plays that role: it generates realistic data and changes, and writes them exactly as the real replicator must, so the real replicator can later adopt the same write module.

Plan section: "Write path: replicator to Redis Stream". Contract: [contracts.md](../contracts.md) §1.

---

## W-01 · Final schema, roles and write function

- **Depends on:** I-01, P-02
- **Size:** M
- **Files:** `infra/postgres/init/*.sql`, later migrations in `apps/replicator-sim/migrations/`

**Goal.** A schema where every committed change produces exactly one correct outbox event, and nothing else can write.

**Deliverables**

1. **Review and finalize** the starter schema:
   - countries, connections + connection_countries, airports (nested `details` JSONB), airplanes (nested JSONB), airplane_crew child table;
   - indexes for every registry field from E-01, including expression indexes for JSONB `->>` and the `jsonb_array_length` filters, and trigram for `callsign`.
2. **Migration tooling:** node-pg-migrate or plain numbered SQL run at startup. Pick one and document it. The compose init scripts then only create the database and roles.
3. **Roles and grants:**
   - only `atlas_writer` can write entity tables, `outbox` and `entity_type_sequence`;
   - `atlas_reader` is read-only;
   - `debezium` can read the outbox and has replication rights.
4. **The write contract,** documented in `apps/replicator-sim/README.md` and implemented in W-02. In one transaction:
   1. write the entity and any child rows;
   2. `UPDATE <root> SET version = version + 1`, once per root per transaction;
   3. `UPDATE entity_type_sequence SET seq = seq + 1 WHERE entity_type = $type RETURNING seq` (the row lock makes the sequence gapless and commit-ordered);
   4. `INSERT INTO outbox ... RETURNING id`;
   5. `DELETE FROM outbox WHERE id = $id`.
5. **Decide and document** what happens when one transaction changes several roots. Recommended: one outbox event per changed root, each with its own `typeSeq`.

**Acceptance criteria**

- [ ] `atlas_reader` gets "permission denied" writing any table.
- [ ] Concurrent writers (10 parallel transactions) produce a gapless `typeSeq` per type in commit order. Verify in the Redis stream after I-03.

---

## W-02 · Replicator write path (NestJS)

- **Depends on:** W-01
- **Size:** M
- **Folder:** `apps/replicator-sim/src/write/`

**Goal.** A reusable write module that implements the write contract and builds correct outbox events, including routing values and affected roots.

**Deliverables**

1. **`EntityWriter` service** with `upsertAirplane`, `updateAirplanePosition`, `setCrew`, `upsertAirport`, `moveAirport` (change country), `upsertCountry`, `upsertConnection` (with countries and criteria), and `delete*`. Each runs one transaction per the W-01 contract.
2. **Event payloads** built with `buildOutboxEvent` (P-02):
   - `map` fields for airplanes and airports;
   - `routing.old` and `routing.new`, read with `SELECT ... FOR UPDATE` before the change;
   - `affectedRoots` for related changes. Example: an airport change lists the airplane ids with `airport_id` = that airport, old and new, so views linked through the airport re-check them.
3. **Batching:** `updatePositions(batch)` writes up to 500 airplanes per transaction. Each airplane still gets its own version bump, sequence number and outbox event, all within the one transaction.
4. **Postgres pool** using `atlas_writer`, with retries on serialization and connection errors.
5. **Debug HTTP:** `POST /dev/write/...` to trigger single changes by hand (used by the tests).

**Acceptance criteria**

- [ ] Integration test against Postgres: after each method, the outbox insert (seen through a test logical replication slot, or Redis after I-03) has the right `version`, `typeSeq`, `routing` and `affectedRoots`.
- [ ] 6,000 position updates per second sustained on a laptop. Record the number.

---

## W-03 · Data simulator and load profiles

- **Depends on:** W-02
- **Size:** M
- **Folder:** `apps/replicator-sim/src/sim/`

**Goal.** Realistic, repeatable data and change load for development, end-to-end checks and the load test.

**Deliverables**

1. **Seeder:**
   - ~250 countries in regions, ~4,000 airports with runways, ~30,000 airplanes with crew, ~200 connections listing countries plus criteria;
   - deterministic from a seed.
2. **Change loop:**
   - airplanes move every 5–10 s (position, altitude, heading, speed);
   - occasional airline or kind changes;
   - crew changes;
   - airports change slowly (runways, sometimes country);
   - connections are edited every few minutes;
   - occasional deletes and creations.
3. **Profiles via `SIM_PROFILE`:**
   - `dev`: 3,000 airplanes;
   - `base`: 30,000 airplanes, about 4,000 events/s;
   - `peak`: 2× rates;
   - `burst`: 10 s spikes.
4. **Dev endpoints** used by the client login stub (A-01) and tests:
   - `GET /dev/scopes`: lists countries and connections;
   - `POST /dev/token`: issues a dev JWT signed with the shared dev key, holding `allowedCountries` and `allowedConnections`;
   - `POST /dev/access/revoke`: writes to `<svc>:access`.
5. **Metrics:** events written per second by type.

**Acceptance criteria**

- [ ] `SIM_PROFILE=base` runs for 1 hour with a steady event rate. Record CPU and Postgres load.
- [ ] Re-seeding with the same seed produces identical data.
