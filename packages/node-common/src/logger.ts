import { AsyncLocalStorage } from 'node:async_hooks';
import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

export interface CreateLoggerOptions {
  /** Worker name for the `worker` field. Defaults to the WORKER_NAME environment variable. */
  worker?: string;
  /** Defaults to LOG_LEVEL, then "info". */
  level?: string;
  /** Pretty, human-readable output. Defaults to NODE_ENV === "development". */
  pretty?: boolean;
  /** Write here instead of stdout (tests). Ignored when `pretty` is on. */
  destination?: DestinationStream;
}

const traceStore = new AsyncLocalStorage<string>();

/** Runs `fn` with `traceId` attached to every log line written inside it, across awaits. */
export function withTraceId<T>(traceId: string, fn: () => T): T {
  return traceStore.run(traceId, fn);
}

export function currentTraceId(): string | undefined {
  return traceStore.getStore();
}

/**
 * Structured JSON logger: one JSON object per line with `service`, `worker` and, inside
 * {@link withTraceId}, `traceId`. Errors go under `err` with type, message and stack.
 */
export function createLogger(service: string, options: CreateLoggerOptions = {}): Logger {
  const pretty = options.pretty ?? process.env['NODE_ENV'] === 'development';
  const config: LoggerOptions = {
    level: options.level ?? process.env['LOG_LEVEL'] ?? 'info',
    base: { service, worker: options.worker ?? process.env['WORKER_NAME'] ?? null },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => {
      const traceId = traceStore.getStore();
      return traceId === undefined ? {} : { traceId };
    },
  };

  if (pretty) {
    return pino({
      ...config,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, singleLine: true, ignore: 'pid,hostname' },
      },
    });
  }
  return options.destination ? pino(config, options.destination) : pino(config);
}
