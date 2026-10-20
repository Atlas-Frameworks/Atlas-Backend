# 09 · Testing and proving the POC

The POC's purpose is to prove or disprove the plan with numbers. These tasks produce the evidence listed in the plan's "Build plan and acceptance tests" section and in the validation report ([validation-report.md](../../validation-report.md), "What the proof of concept must prove").

---

## T-02 · End-to-end correctness checks

- **Depends on:** T-01, S-04
- **Size:** M

**Goal.** Prove that what clients see always converges to what Postgres says.

**Deliverables**

1. **Headless checker client** using `@atlas/client-sdk` in Node:
   - opens N random views (map + first page);
   - at random moments, compares its state with a direct full query on the primary;
   - allows lag up to 3 s and reports mismatches with details.
2. **Scenarios:**
   - simulator `base` for 30 minutes;
   - child-row changes only;
   - airports moving countries (multi-hop);
   - connection edits while users are logged in on them;
   - access revocation.
3. **Report:** mismatches, convergence time p50 and p99.

**Acceptance criteria**

- [ ] 0 unconverged mismatches across all scenarios. Any mismatch is filed as a bug with reproduction steps.

---

## T-03 · Failover drills

- **Depends on:** T-01, S-07
- **Size:** M

**Goal.** Prove that no failure loses data silently. Duplicates and reloads are acceptable; silent drift is not.

**Deliverables**

1. Scripted drills, each run under the `base` load with T-02's checker running:
   1. **Postgres:**
      - promote the replica while writes continue;
      - verify Debezium's failover slot survived (`synced`);
      - verify no outbox event is missing: every `typeSeq` is present, or a gap was detected and reloaded.
   2. **Redis Sentinel failover:**
      - Debezium continues through the proxy;
      - workers detect any gap and reload;
      - the worker list re-converges.
   3. **Debezium killed** for 30 s, then 10 minutes (longer than stream retention), then restarted.
   4. **Replica lag:** throttle replica replay or inject a delay; ticks wait or use the primary; no stale view.
   5. **Replication slot invalidation:** lower `max_slot_wal_keep_size` and stop Debezium until the slot is invalidated; confirm alerting and that the documented full-reload recovery works.
2. For each drill: steps, expected result, observed result, time to recover, and data checks.

**Acceptance criteria**

- [ ] Every drill ends with T-02's checker at 0 mismatches after recovery, and every loss was detected automatically (gap metric or reload logged).

---

## T-04 · Load test: 5,000 clients, 1,000 views

- **Depends on:** S-07, W-03
- **Size:** L
- **Location:** `tools/load-test`

**Goal.** Measure whether 3–5 workers per service meet the latency target at production-like load, and find the first bottleneck.

**Deliverables**

1. Load generator (Node, many WebSocket clients per process using the SDK core on the main thread, or a lean protocol client):
   - 5,000 clients over 1,000 distinct views (Zipf-distributed popularity);
   - each with a map subscription and a page;
   - random filter changes and page flips.
2. Run with simulator `base` and `peak`, 3 workers then 5 workers per service.
3. Collect:
   - commit-to-send p50/p99;
   - tick duration;
   - event-loop delay;
   - CPU and memory per worker;
   - Postgres replica CPU and queries per second;
   - Redis CPU, memory and outbound bandwidth;
   - bytes per client per second.
4. Compare batched multi-view re-checks against one query per view (feature flag in S-04).

**Acceptance criteria**

- [ ] Results table in `docs/poc-results.md` (T-06), with the commit-to-send p99 target of 3 s marked pass or fail.
- [ ] The first bottleneck is identified, with evidence.

---

## T-05 · Chaos and rolling-deploy tests

- **Depends on:** S-07, I-04 (or docker-compose equivalents)
- **Size:** M

**Goal.** Prove the multi-pod behaviour: ownership, handover and deploys.

**Deliverables**

1. Scenarios under load, each with T-02 checking:
   - kill a worker;
   - `SIGSTOP` a worker for 15 s;
   - scale 3 → 5 → 3;
   - rolling restart of all workers;
   - a reconnect storm (drop all client connections at once);
   - clients reconnecting to random workers continuously.
2. Measure:
   - client-visible stale time per scenario;
   - database load spikes;
   - duplicate-ownership duration (from `/debug/views`).

**Acceptance criteria**

- [ ] No mismatches after recovery.
- [ ] Each view has exactly one owner in steady state.
- [ ] A rolling deploy causes no errors beyond planned reconnects.

---

## T-06 · POC results report

- **Depends on:** T-02, T-03, T-04, T-05
- **Size:** S

**Goal.** One document that tells the team whether to go ahead with the plan, and what to change.

**Deliverables**

`docs/poc-results.md`:

1. Every acceptance test from the plan, marked pass or fail, with evidence links.
2. Measured numbers next to the plan's estimates (memory, queries per second, bandwidth, Redis memory).
3. The Node-vs-Java decision input: tick CPU per core.
4. A list of plan changes the POC requires.

**Acceptance criteria**

- [ ] Reviewed by the team; open issues created for every required change.
