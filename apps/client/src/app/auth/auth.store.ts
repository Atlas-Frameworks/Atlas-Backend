import { Injectable, computed, signal } from '@angular/core';

/** What the user may see: some countries, or one connection (same shape as the SDK's `ViewScope`). */
export type AuthScope = { countries: string[] } | { connectionId: string };

export interface AuthSession {
  token: string;
  scope: AuthScope;
  /** Short description for the top bar, e.g. "3 countries" or the connection name. */
  label: string;
}

/**
 * The signed-in session. Kept in memory only (POC): a reload signs the user out, and the dev JWT
 * never reaches localStorage or cookies.
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly current = signal<AuthSession | null>(null);

  readonly session = this.current.asReadonly();
  readonly token = computed(() => this.current()?.token ?? null);
  readonly signedIn = computed(() => this.current() !== null);

  signIn(session: AuthSession): void {
    this.current.set(session);
  }

  signOut(): void {
    this.current.set(null);
  }
}
