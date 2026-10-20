import { InjectionToken } from '@angular/core';
import { environment } from '../../environments/environment';

/** Where the app finds its backends. */
export interface AtlasEnvironment {
  /** Entity type -> view-service WebSocket URL; `'*'` is the fallback for any other type. */
  services: Record<string, string>;
  /** Base URL of the dev auth endpoints `GET /dev/scopes` and `POST /dev/token` (POC only). */
  devApiUrl: string;
  /** Field registry metadata, `GET /meta/registry` (filter builder, A-04). */
  registryUrl: string;
}

export const ATLAS_ENV = new InjectionToken<AtlasEnvironment>('ATLAS_ENV', {
  providedIn: 'root',
  factory: () => environment,
});
