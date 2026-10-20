import { InjectionToken } from '@angular/core';
import { createAtlasClient } from '@atlas/client-sdk';
import type { AtlasClient, AtlasClientConfig } from '@atlas/client-sdk';

export type AtlasClientFactory = (config: AtlasClientConfig) => AtlasClient;

/**
 * Creates the SDK client. The default runs the SDK core in a Web Worker (bundled by the Angular
 * builder from `./sdk.worker`); tests provide a fake.
 */
export const ATLAS_CLIENT_FACTORY = new InjectionToken<AtlasClientFactory>('ATLAS_CLIENT_FACTORY', {
  providedIn: 'root',
  factory: () => (config) =>
    createAtlasClient({
      ...config,
      worker: () => new Worker(new URL('./sdk.worker', import.meta.url), { type: 'module' }),
    }),
});
