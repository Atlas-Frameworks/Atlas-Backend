import { describe, expect, it } from 'vitest';

import { createPublisherConfig, loadPublisherConfig } from './config.js';

const defaultValues = {
  databaseUrl: 'postgresql://publisher@localhost/atlas',
  redisUrl: 'redis://localhost:6380',
  sourceSchema: 'benchmark_publisher',
  batchSize: 1_000,
  leaseSeconds: 30,
  idleDelayMilliseconds: 100,
};

describe('loadPublisherConfig', () => {
  it('loads the checked-in default config when no environment is selected', async () => {
    const config = await loadPublisherConfig();
    expect(config.sourceSchema).toBe('benchmark_publisher');
    expect(config.batchSize).toBe(1_000);
  });

  it('rejects unsafe environment names', async () => {
    await expect(loadPublisherConfig('../production')).rejects.toThrow(
      'PUBLISHER_ENV may contain only letters, numbers, underscores, and hyphens',
    );
  });
});

describe('createPublisherConfig', () => {
  it('overrides only values supplied by the environment config', () => {
    const config = createPublisherConfig({
      defaultValues,
      environmentValues: { batchSize: 250 },
      generateOwner: () => 'generated-owner',
    });
    expect(config.batchSize).toBe(250);
    expect(config.leaseSeconds).toBe(30);
    expect(config.owner).toBe('generated-owner');
  });

  it('uses an explicitly configured owner', () => {
    const config = createPublisherConfig({
      defaultValues,
      environmentValues: { owner: 'publisher-a' },
    });
    expect(config.owner).toBe('publisher-a');
  });

  it('rejects a schema outside the Publisher environment', () => {
    expect(() => createPublisherConfig({
      defaultValues,
      environmentValues: { sourceSchema: 'public' },
    })).toThrow('sourceSchema must be benchmark_publisher');
  });

  it('rejects invalid numeric values', () => {
    expect(() => createPublisherConfig({
      defaultValues,
      environmentValues: { batchSize: 0 },
    })).toThrow('batchSize must be a positive integer');
  });
});
