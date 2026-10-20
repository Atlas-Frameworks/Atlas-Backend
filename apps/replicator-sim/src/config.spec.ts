import { loadConfig as load } from '@atlas/node-common';
import { configSchema } from './config.js';

describe('replicator-sim config', () => {
  it('defaults PORT to 3100 and rejects invalid ports', () => {
    expect(load(configSchema, {}).PORT).toBe(3100);
    expect(() => load(configSchema, { PORT: 'abc' })).toThrow(/PORT: invalid/);
  });
});
