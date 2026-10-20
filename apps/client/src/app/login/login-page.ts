import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  resource,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import type { AuthScope } from '../auth/auth.store';
import { AuthStore } from '../auth/auth.store';
import { DevAuthApi } from '../auth/dev-auth.api';

type Mode = 'countries' | 'connection';

/**
 * POC login stub: pick one or several countries, or one connection, from `GET /dev/scopes`, then
 * fetch a dev JWT from `POST /dev/token`. The token is kept in memory (AuthStore) only.
 */
@Component({
  selector: 'app-login-page',
  templateUrl: './login-page.html',
  styleUrl: './login-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPage {
  private readonly api = inject(DevAuthApi);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  protected readonly scopes = resource({
    loader: ({ abortSignal }) => this.api.scopes(abortSignal),
  });
  protected readonly mode = signal<Mode>('countries');
  protected readonly countryIds = signal<ReadonlySet<string>>(new Set());
  protected readonly connectionId = signal<string | null>(null);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly canSubmit = computed(
    () =>
      !this.submitting() &&
      (this.mode() === 'countries' ? this.countryIds().size > 0 : this.connectionId() !== null),
  );

  protected setMode(mode: Mode): void {
    this.mode.set(mode);
  }

  protected toggleCountry(id: string, checked: boolean): void {
    this.countryIds.update((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  protected selectAllCountries(all: boolean): void {
    const countries = this.scopes.hasValue() ? this.scopes.value().countries : [];
    this.countryIds.set(new Set(all ? countries.map((c) => c.id) : []));
  }

  protected async submit(event?: Event): Promise<void> {
    event?.preventDefault();
    if (!this.canSubmit()) return;
    const { scope, label } = this.selection();
    this.submitting.set(true);
    this.error.set(null);
    try {
      const token = await this.api.token(scope);
      this.auth.signIn({ token, scope, label });
      await this.router.navigate(['/']);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.submitting.set(false);
    }
  }

  private selection(): { scope: AuthScope; label: string } {
    const data = this.scopes.hasValue() ? this.scopes.value() : { countries: [], connections: [] };
    if (this.mode() === 'connection') {
      const id = this.connectionId() ?? '';
      const name = data.connections.find((c) => c.id === id)?.name ?? id;
      return { scope: { connectionId: id }, label: name };
    }
    const ids = [...this.countryIds()];
    const first = data.countries.find((c) => c.id === ids[0]);
    const label = ids.length === 1 ? (first?.name ?? ids[0] ?? '') : `${ids.length} countries`;
    return { scope: { countries: ids }, label };
  }
}
