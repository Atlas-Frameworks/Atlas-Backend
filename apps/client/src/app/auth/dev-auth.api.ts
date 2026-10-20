import { Injectable, inject } from '@angular/core';
import { ATLAS_ENV } from '../config/environment';
import type { AuthScope } from './auth.store';

export interface DevCountry {
  id: string;
  code: string;
  name: string;
  region: string;
}

export interface DevConnection {
  id: string;
  name: string;
  countryIds: string[];
}

export interface DevScopes {
  countries: DevCountry[];
  connections: DevConnection[];
}

/**
 * The POC's dev auth endpoints (replicator-sim W-03, or the C-07 mock): the scopes a dev user can
 * pick, and a dev JWT for the chosen one. Not used in production.
 */
@Injectable({ providedIn: 'root' })
export class DevAuthApi {
  private readonly env = inject(ATLAS_ENV);

  async scopes(signal?: AbortSignal): Promise<DevScopes> {
    const body = await this.request('GET', '/dev/scopes', undefined, signal);
    return parseScopes(body);
  }

  async token(scope: AuthScope): Promise<string> {
    const body = await this.request(
      'POST',
      '/dev/token',
      'countries' in scope ? { countries: scope.countries } : { connectionId: scope.connectionId },
    );
    const token = isRecord(body) ? body['token'] : undefined;
    if (typeof token !== 'string' || token === '') throw new Error('POST /dev/token: no token');
    return token;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const res = await fetch(`${this.env.devApiUrl}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
    const json: unknown = await res.json();
    return json;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function parseScopes(body: unknown): DevScopes {
  if (!isRecord(body)) throw new Error('GET /dev/scopes: not an object');
  const list = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter(isRecord) : [];
  return {
    countries: list(body['countries']).map((c) => ({
      id: str(c['id']),
      code: str(c['code']),
      name: str(c['name']),
      region: str(c['region']),
    })),
    connections: list(body['connections']).map((c) => ({
      id: str(c['id']),
      name: str(c['name']),
      countryIds: Array.isArray(c['countryIds']) ? c['countryIds'].map(str) : [],
    })),
  };
}
