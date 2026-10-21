import { describe, expect, it } from 'vitest';

import { readPublisherConfig } from './config.js';

describe('readPublisherConfig', () => {
  it('uses the isolated Publisher schema by default', () => {
    const config = readPublisherConfig({});
    expect(config.sourceSchema).toBe('benchmark_publisher');
  });

  it('rejects a schema outside the Publisher environment', () => {
    expect(() => readPublisherConfig({ PUBLISHER_SCHEMA: 'public' })).toThrow(
      'PUBLISHER_SCHEMA must be benchmark_publisher',
    );
  });
});
