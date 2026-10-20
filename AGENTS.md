# Guide for coding agents and contributors

Read this file fully before changing anything.

## What you are building

A proof of concept for the design in `docs/architecture-plan.md`. The interfaces between components are fixed in `docs/contracts.md`. Work is split into independent tasks in `docs/tasks/`, each with deliverables and acceptance criteria.

## Working on a task

1. You will be given a task ID, such as `E-04`. Find it in `docs/tasks/<category>.md` and read the whole section.
2. Read the plan sections the task lists, and every contract section it mentions.
3. Check its **Depends on** list. If a dependency isn't done, build against the contract with a stub or mock and say so in the PR. Don't implement another task's scope.
4. Branch: `task/<ID>-<short-name>`. PR title: `<ID>: <title>`. In the PR, list each acceptance criterion and how you verified it, with numbers for performance criteria.
5. Update the board row in `docs/tasks/README.md` (owner, status) in the same PR.

## Rules

- **Contracts are shared.** If a contract in `docs/contracts.md` must change, stop. Propose it in a separate PR labelled `contract-change`, and update every task that references it.
- **Package boundaries:**
  - `packages/view-engine` has no I/O: no `pg`, no Redis, no sockets, no timers.
  - `packages/client-sdk` must not import Angular, React, Cesium, deck.gl or MapLibre.
  - Apps depend on packages, never the other way round.
- **Hot paths** (tick loop, fan-out, SDK frame handling): no per-entity object allocation, use typed arrays, and don't block the event loop for more than a few ms (yield with `setImmediate`).
- **Safety:** never build SQL by string-concatenating values; identifiers come only from the field registry.
- **Tests are part of the task.** Unit tests next to code (`*.spec.ts`, Vitest). Integration tests use Testcontainers (T-01) and live under `test/integration/`.
- **Commands from the repo root:** `npm run build`, `npm test`, `npm run typecheck`, `npm run lint`. All must pass before a PR.
- **Toolchain:** Node 24 and npm 11. npm 11 blocks dependency install scripts unless they are listed under `allowScripts` in the root `package.json`. If a new dependency needs one, approve it with `npm install-scripts approve <pkg>` and commit the change.
- **Domain for tests and examples:** countries, connections, airports, airplanes, airplane_crew (see `infra/postgres/init/02-schema.sql`).

## Where things are

| Need | Look in |
| --- | --- |
| Why a design choice was made | `docs/architecture-plan.md` (Caveats table) and `docs/validation-report.md` |
| Message and event shapes | `docs/contracts.md`, `packages/protocol` |
| Local infrastructure | `infra/README.md` |
