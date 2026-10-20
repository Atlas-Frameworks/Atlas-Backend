export interface AtlasErrorOptions {
  /** Stable, machine-readable code, e.g. "REPLICA_LAG" or "INVALID_FILTER". */
  code: string;
  cause?: unknown;
  /** Extra structured fields for logs. Must not contain secrets. */
  details?: Record<string, unknown>;
}

/** Base class: every error the apps raise on purpose carries a `code`. */
export abstract class AtlasError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  abstract readonly retryable: boolean;

  constructor(message: string, options: AtlasErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.details = options.details;
  }
}

/** Transient failure (timeout, failover, lock contention). The caller may retry with backoff. */
export class RetryableError extends AtlasError {
  readonly retryable = true;
}

/** Unrecoverable: the process or operation must stop (e.g. replication slot lost, bad schema). */
export class FatalError extends AtlasError {
  readonly retryable = false;
}

/** The input was rejected (bad filter, unknown field, malformed event). Retrying won't help. */
export class InvalidInputError extends AtlasError {
  readonly retryable = false;
}

/** True only for {@link RetryableError}. Unknown errors are not retried by default. */
export function isRetryable(err: unknown): boolean {
  return err instanceof AtlasError && err.retryable;
}
