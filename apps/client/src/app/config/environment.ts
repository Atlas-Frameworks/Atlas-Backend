import { InjectionToken } from '@angular/core';
import { environment } from '../../environments/environment';

/** The map's base imagery (A-03). */
export interface BasemapConfig {
  /**
   * XYZ tile URL template with `{z}`, `{x}`, `{y}` (e.g. the on-prem tile server,
   * `https://tiles.example.internal/osm/{z}/{x}/{y}.png`). `null`: no tiles, a plain globe with a
   * lat/lon grid, which needs no network or token.
   */
  url: string | null;
  /** Deepest tile level the server has (default 19). */
  maximumLevel?: number;
  /** Attribution shown on the map. */
  credit?: string;
  /** Globe colour under (or instead of) the tiles. */
  baseColor: string;
}

/** Where the app finds its backends. */
export interface AtlasEnvironment {
  /** Entity type -> view-service WebSocket URL; `'*'` is the fallback for any other type. */
  services: Record<string, string>;
  /** Base URL of the dev auth endpoints `GET /dev/scopes` and `POST /dev/token` (POC only). */
  devApiUrl: string;
  /** Field registry metadata, `GET /meta/registry` (filter builder, A-04). */
  registryUrl: string;
  basemap: BasemapConfig;
}

export const ATLAS_ENV = new InjectionToken<AtlasEnvironment>('ATLAS_ENV', {
  providedIn: 'root',
  factory: () => environment,
});
