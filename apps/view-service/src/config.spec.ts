import { loadConfig as load } from '@atlas/node-common';
import { configSchema } from './config.js';

describe('view-service config', () => {
  it('requires WORKER_NAME and defaults the ports', () => {
    expect(load(configSchema, { WORKER_NAME: 'view-service-0' })).toMatchObject({
      WORKER_NAME: 'view-service-0',
      PORT: 3000,
      GRPC_PORT: 50051,
    });
    expect(() => load(configSchema, {})).toThrow(/WORKER_NAME: missing/);
  });
});
