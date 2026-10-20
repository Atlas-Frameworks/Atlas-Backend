import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ConfigError, loadConfig, loadConfigOrExit } from './config.js';

const schema = z.object({
  WORKER_NAME: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url(),
  DEBUG_SQL: z.stringbool().default(false),
});

describe('loadConfig', () => {
  it('returns typed, coerced values and applies defaults', () => {
    const config = loadConfig(schema, {
      WORKER_NAME: 'w0',
      DATABASE_URL: 'postgres://h/db',
      DEBUG_SQL: 'true',
    });
    expect(config).toEqual({
      WORKER_NAME: 'w0',
      PORT: 3000,
      DATABASE_URL: 'postgres://h/db',
      DEBUG_SQL: true,
    });
  });

  it('coerces numbers', () => {
    expect(
      loadConfig(schema, { WORKER_NAME: 'w', DATABASE_URL: 'postgres://h/db', PORT: '3010' }).PORT,
    ).toBe(3010);
  });

  it('lists every missing and invalid variable at once', () => {
    let error: unknown;
    try {
      loadConfig(schema, { PORT: '70000', DATABASE_URL: 'not a url' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const issues = (error as ConfigError).issues;
    expect(issues.map((i) => [i.variable, i.kind])).toEqual([
      ['WORKER_NAME', 'missing'],
      ['PORT', 'invalid'],
      ['DATABASE_URL', 'invalid'],
    ]);
    const message = (error as ConfigError).message;
    expect(message).toContain('WORKER_NAME: missing');
    expect(message).toContain('PORT: invalid');
    expect(message).toContain('DATABASE_URL: invalid');
  });

  it('treats empty strings as unset', () => {
    expect(() => loadConfig(schema, { WORKER_NAME: '', DATABASE_URL: 'postgres://h/db' })).toThrow(
      /WORKER_NAME: missing/,
    );
    expect(
      loadConfig(schema, { WORKER_NAME: 'w', DATABASE_URL: 'postgres://h/db', PORT: '' }).PORT,
    ).toBe(3000);
  });

  it('never includes variable values in the message', () => {
    const secretSchema = z.object({ DATABASE_URL: z.url() });
    expect(() => loadConfig(secretSchema, { DATABASE_URL: 's3cret-password' })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('s3cret') }),
    );
  });

  it('ignores variables the schema does not declare', () => {
    const config = loadConfig(z.object({ A: z.string() }), { A: 'a', B: 'b' });
    expect(config).toEqual({ A: 'a' });
  });
});

describe('loadConfigOrExit', () => {
  it('prints the problems and exits with status 1', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => loadConfigOrExit(schema, { DATABASE_URL: 'postgres://h/db' })).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('WORKER_NAME: missing');
    exit.mockRestore();
    stderr.mockRestore();
  });
});

describe('commonEnv and port', () => {
  it('defaults NODE_ENV to production and LOG_LEVEL to info', async () => {
    const { commonEnv, port } = await import('./config.js');
    const s = z.object({ ...commonEnv, PORT: port.default(3000) });
    expect(loadConfig(s, {})).toEqual({ NODE_ENV: 'production', LOG_LEVEL: 'info', PORT: 3000 });
    expect(() => loadConfig(s, { LOG_LEVEL: 'loud', PORT: '0' })).toThrow(
      /LOG_LEVEL: invalid[\s\S]*PORT: invalid/,
    );
  });
});
