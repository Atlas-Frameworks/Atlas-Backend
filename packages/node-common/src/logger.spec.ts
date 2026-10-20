import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, currentTraceId, withTraceId } from './logger.js';

function capture() {
  const lines: string[] = [];
  let buffer = '';
  const destination = new Writable({
    write(chunk: Buffer, _enc, done) {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        lines.push(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
      done();
    },
  });
  return { lines, destination };
}

describe('createLogger', () => {
  it('writes one JSON object per line with service, worker and level', () => {
    const { lines, destination } = capture();
    const log = createLogger('view-service', {
      worker: 'view-service-0',
      pretty: false,
      destination,
    });
    log.info({ views: 3 }, 'tick done');
    log.warn('slow tick');

    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({
      level: 'info',
      service: 'view-service',
      worker: 'view-service-0',
      views: 3,
      msg: 'tick done',
    });
    expect(first.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(lines[1]!).level).toBe('warn');
  });

  it('adds traceId inside withTraceId, across awaits', async () => {
    const { lines, destination } = capture();
    const log = createLogger('replicator-sim', { worker: 'r', pretty: false, destination });
    await withTraceId('trace-123', async () => {
      await new Promise((resolve) => setImmediate(resolve));
      expect(currentTraceId()).toBe('trace-123');
      log.info('inside');
    });
    log.info('outside');
    expect(JSON.parse(lines[0]!).traceId).toBe('trace-123');
    expect(JSON.parse(lines[1]!)).not.toHaveProperty('traceId');
  });

  it('serializes errors under err', () => {
    const { lines, destination } = capture();
    const log = createLogger('svc', { pretty: false, destination });
    log.error({ err: new Error('boom') }, 'failed');
    expect(JSON.parse(lines[0]!).err).toMatchObject({ type: 'Error', message: 'boom' });
  });

  it('respects the level option', () => {
    const { lines, destination } = capture();
    const log = createLogger('svc', { level: 'warn', pretty: false, destination });
    log.info('hidden');
    log.warn('shown');
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(['shown']);
  });
});
