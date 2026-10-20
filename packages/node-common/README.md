# @atlas/node-common

Config, logging and error types shared by every Node app (task F-03). Not for browser code.

```ts
import { commonEnv, port, loadConfigOrExit, createLogger, NestPinoLogger, z } from '@atlas/node-common';

const config = loadConfigOrExit(
  z.object({ ...commonEnv, WORKER_NAME: z.string().min(1), PORT: port.default(3000) }),
);
const logger = createLogger('view-service', { worker: config.WORKER_NAME, level: config.LOG_LEVEL });
const app = await NestFactory.create(AppModule, { logger: new NestPinoLogger(logger) });
```

| Export | What it does |
| --- | --- |
| `loadConfig(schema, env?)` | Validates env vars with a zod object schema. Throws `ConfigError` listing **every** missing or invalid variable (never their values). Empty strings count as unset. |
| `loadConfigOrExit(schema, env?)` | Same, but prints the problems and exits with status 1. Use it in `main.ts`. |
| `commonEnv`, `port` | `NODE_ENV` (default `production`), `LOG_LEVEL` (default `info`) and a port validator. |
| `createLogger(service, opts?)` | pino logger: one JSON object per line with `level`, `time`, `service`, `worker`, `msg`; pretty single-line output when `NODE_ENV=development`. |
| `withTraceId(id, fn)` | Adds `traceId` to every log line written inside `fn`, across `await`s (AsyncLocalStorage). |
| `NestPinoLogger` | Nest `LoggerService` adapter; Nest's context becomes the `context` field. |
| `RetryableError`, `FatalError`, `InvalidInputError` | Errors with a stable `code`, optional `details` and `cause`. `isRetryable(err)` is true only for `RetryableError`. |
