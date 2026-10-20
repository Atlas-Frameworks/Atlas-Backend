import { describe, expect, it } from 'vitest';
import {
  AtlasError,
  FatalError,
  InvalidInputError,
  RetryableError,
  isRetryable,
} from './errors.js';

describe('error types', () => {
  it('carry a code, details, cause and their own name', () => {
    const cause = new Error('socket closed');
    const err = new RetryableError('replica lagging', {
      code: 'REPLICA_LAG',
      cause,
      details: { lagMs: 2500 },
    });
    expect(err).toBeInstanceOf(AtlasError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RetryableError');
    expect(err.code).toBe('REPLICA_LAG');
    expect(err.details).toEqual({ lagMs: 2500 });
    expect(err.cause).toBe(cause);
  });

  it('only RetryableError is retryable', () => {
    expect(isRetryable(new RetryableError('x', { code: 'A' }))).toBe(true);
    expect(isRetryable(new FatalError('x', { code: 'SLOT_LOST' }))).toBe(false);
    expect(isRetryable(new InvalidInputError('x', { code: 'INVALID_FILTER' }))).toBe(false);
    expect(isRetryable(new Error('unknown'))).toBe(false);
  });
});
