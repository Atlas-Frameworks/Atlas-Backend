import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { NestPinoLogger } from './nest-logger.js';

function setup() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      done();
    },
  });
  const nest = new NestPinoLogger(
    createLogger('svc', { level: 'trace', pretty: false, destination }),
  );
  return { nest, lines };
}

describe('NestPinoLogger', () => {
  it('maps Nest context to a field', () => {
    const { nest, lines } = setup();
    nest.log('Nest application successfully started', 'NestApplication');
    expect(lines[0]).toMatchObject({
      level: 'info',
      context: 'NestApplication',
      msg: 'Nest application successfully started',
    });
  });

  it('keeps the stack and context of error(message, stack, context)', () => {
    const { nest, lines } = setup();
    nest.error('failed to bind', 'Error: x\n    at y', 'RoutesResolver');
    expect(lines[0]).toMatchObject({
      level: 'error',
      context: 'RoutesResolver',
      stack: 'Error: x\n    at y',
      msg: 'failed to bind',
    });
  });

  it('serializes Error objects', () => {
    const { nest, lines } = setup();
    nest.error(new Error('boom'));
    expect(lines[0]).toMatchObject({ level: 'error', msg: 'boom', err: { message: 'boom' } });
  });

  it('maps verbose to trace and merges object messages', () => {
    const { nest, lines } = setup();
    nest.verbose({ route: '/health' }, 'RouterExplorer');
    expect(lines[0]).toMatchObject({ level: 'trace', route: '/health', context: 'RouterExplorer' });
  });
});

describe('NestPinoLogger error() argument shapes', () => {
  it('treats a single string as the context', () => {
    const { nest, lines } = setup();
    nest.error('no stack', 'InstanceLoader');
    expect(lines[0]).toMatchObject({ context: 'InstanceLoader', msg: 'no stack' });
    expect(lines[0]).not.toHaveProperty('stack');
  });

  it('treats a single multi-line string as the stack', () => {
    const { nest, lines } = setup();
    nest.error('only stack', 'Error: x\n    at y');
    expect(lines[0]).toMatchObject({ stack: 'Error: x\n    at y', msg: 'only stack' });
    expect(lines[0]).not.toHaveProperty('context');
  });
});
