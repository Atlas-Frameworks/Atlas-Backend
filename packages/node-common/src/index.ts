/**
 * @atlas/node-common
 *
 * Shared by every Node app (view-service, replicator-sim) so they read config, log and report
 * errors the same way. Not for browser code.
 */
export { z } from 'zod';
export {
  ConfigError,
  commonEnv,
  loadConfig,
  loadConfigOrExit,
  port,
  type ConfigIssue,
} from './config.js';
export {
  createLogger,
  currentTraceId,
  withTraceId,
  type CreateLoggerOptions,
  type Logger,
} from './logger.js';
export { NestPinoLogger } from './nest-logger.js';
export {
  AtlasError,
  FatalError,
  InvalidInputError,
  RetryableError,
  isRetryable,
  type AtlasErrorOptions,
} from './errors.js';
