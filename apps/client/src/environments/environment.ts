import type { AtlasEnvironment } from '../app/config/environment';

/**
 * Default (local development) endpoints. Until the replicator-sim dev endpoints (W-03) and the
 * view-service exist, everything points at the C-07 mock server (`npm run dev:mock`, port 8090).
 */
export const environment: AtlasEnvironment = {
  services: { '*': 'ws://127.0.0.1:8090/ws' },
  devApiUrl: 'http://127.0.0.1:8090',
  registryUrl: 'http://127.0.0.1:8090/meta/registry',
  // Offline default: a plain globe with a grid. For the on-prem basemap set `url` to its XYZ
  // template, e.g. 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' with credit '© OpenStreetMap'.
  basemap: { url: null, baseColor: '#16324a' },
};
