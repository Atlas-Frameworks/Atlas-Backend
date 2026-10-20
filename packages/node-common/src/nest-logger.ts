import type { Logger } from 'pino';

/**
 * Adapter that makes NestJS write through pino. Implements Nest's `LoggerService` structurally,
 * so this package does not depend on @nestjs/common.
 *
 *   NestFactory.create(AppModule, { logger: new NestPinoLogger(logger) })
 */
export class NestPinoLogger {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    // Nest calls error(message, context), error(message, stack, context) or error(message, stack).
    const strings = params.filter((p): p is string => typeof p === 'string');
    const stack =
      strings.find((s) => s.includes('\n')) ?? (strings.length > 1 ? strings[0] : undefined);
    const context = strings.findLast((s) => s !== stack);
    if (message instanceof Error) {
      this.logger.error({ context, err: message }, message.message);
    } else {
      this.logger.error({ context, stack }, stringify(message));
    }
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  private write(
    level: 'info' | 'warn' | 'debug' | 'trace' | 'fatal',
    message: unknown,
    params: unknown[],
  ): void {
    // Nest passes the context (class name) as the last string parameter.
    const last = params.at(-1);
    const context = typeof last === 'string' ? last : undefined;
    if (message !== null && typeof message === 'object' && !(message instanceof Error)) {
      this.logger[level]({ context, ...message });
    } else {
      this.logger[level]({ context }, stringify(message));
    }
  }
}

function stringify(message: unknown): string {
  if (message instanceof Error) return message.message;
  return typeof message === 'string' ? message : JSON.stringify(message);
}
