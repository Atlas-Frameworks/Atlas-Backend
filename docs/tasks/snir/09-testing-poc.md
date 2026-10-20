# 09 · Testing and proving the POC

The POC's purpose is to prove or disprove the plan with numbers. These tasks produce the evidence listed in the plan's "Build plan and acceptance tests" section and in the validation report ([validation-report.md](../../validation-report.md), "What the proof of concept must prove").

---

## T-01 · Backend integration test environment

- **Depends on:** I-01, I-02, I-03
- **Size:** M
- **Location:** `packages/test-env`

**Goal.** Any backend test can start real Postgres (primary + replica), Redis (with a replica) and Debezium in seconds, and tear them down.

**Deliverables**

1. Testcontainers-based helper:
   - `startStack({replica, debezium, sentinel})` returns connection strings and handles to stop or kill each container;
   - reuses the files in `infra/`.
2. Helpers:
   - `waitForStreamEntries(type, n)`;
   - `promoteReplica()`;
   - `redisFailover()`;
   - `pauseContainer(name, ms)`.
3. CI job, separate from unit tests, that runs integration suites on PRs touching `apps/` or `packages/view-engine`.

**Acceptance criteria**

- [ ] A sample test writes through W-02 and reads the event from Redis in under 60 s total, including container start (with image caching).
