# @atlas/replicator-sim

Plays the role of the production replicator, the only writer to Postgres. It writes each entity change and its outbox event in one transaction, and simulates realistic data and change load.

- Tasks: [docs/tasks/snir/08-replicator.md](../../docs/tasks/snir/08-replicator.md) (W-01 – W-03)
- Design: [docs/architecture-plan.md](../../docs/architecture-plan.md), section "Write path: replicator to Redis Stream"
- Event contract: [docs/contracts.md](../../docs/contracts.md) §1

Current state: the generated NestJS 12 starter. W-02 adds the write module and W-03 the simulator.
