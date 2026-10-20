import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthStore } from '../auth/auth.store';
import { ConnectionStatus } from './connection-status';

/**
 * The map workspace: a full-screen map area with the top bar, the collapsible Layers panel (A-04)
 * and the detail drawer (A-05) floating over it. The panels are placeholders until those tasks land.
 */
@Component({
  selector: 'app-workspace-page',
  imports: [ConnectionStatus],
  templateUrl: './workspace-page.html',
  styleUrl: './workspace-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspacePage {
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  protected readonly session = this.auth.session;
  protected readonly layersOpen = signal(true);
  protected readonly drawerOpen = signal(false);

  protected async signOut(): Promise<void> {
    this.auth.signOut();
    await this.router.navigate(['/login']);
  }
}
