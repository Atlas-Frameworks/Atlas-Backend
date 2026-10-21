# @atlas/view-service

NestJS workers. Every pod serves the WebSocket clients connected to it and owns a share of the views, chosen by rendezvous hashing over the worker list in Redis.

- Tasks: [docs/tasks/dvir/05-view-service.md](../../docs/tasks/dvir/05-view-service.md) (S-01 – S-10)
- Design: [docs/architecture-plan.md](../../docs/architecture-plan.md), sections "View worker internals" and "Multi-pod deployment without sticky sessions"
- Contracts: [docs/contracts.md](../../docs/contracts.md) §2, §3, §4, §6, §8

Current state: the generated NestJS 12 starter (ESM, Vitest, oxlint). S-01 turns it into the worker skeleton.

```bash
npm run start:dev -w @atlas/view-service
npm test -w @atlas/view-service
```
