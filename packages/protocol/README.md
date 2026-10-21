# @atlas/protocol

The single source of truth for every message that crosses a process boundary:

| Schema | Between | Owner task |
| --- | --- | --- |
| `proto/atlas/client/v1/*.proto` | Browser SDK ↔ view-service worker (WebSocket, binary frames) | P-01 |
| `proto/atlas/cluster/v1/*.proto` | Worker ↔ worker (gRPC) | P-01 |
| `schema/outbox-event.v2.json` | Database trigger → outbox → Debezium → Redis stream payload | P-02 |

Generated TypeScript (protobuf-es) is written to `src/gen/` and is not committed.
Run `npm run generate -w @atlas/protocol` after changing a `.proto` file.

Rules:

- Never reuse or renumber a field. Add new fields; deprecate old ones.
- Bump `PROTOCOL_VERSION` in `src/index.ts` for breaking changes. Every component accepts the current and the previous version.
- Positions on the map are packed into `bytes` fields so the client decodes them straight into typed arrays.
