import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthStore } from '../auth/auth.store';
import { AtlasRealtimeService } from '../realtime/atlas-realtime.service';
import { ConnectionStatus } from './connection-status';

/**
 * The map workspace: a full-screen map area with the top bar, the collapsible Layers panel (A-04)
 * and the detail drawer (A-05) floating over it. The panels are placeholders until those tasks land;
 * the Layers panel shows the live total of one airplanes view as a smoke test of the SDK service.
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
  private readonly realtime = inject(AtlasRealtimeService);

  protected readonly session = this.auth.session;
  protected readonly connection = this.realtime.connectionStatus;
  protected readonly staleSince = this.realtime.staleSince;
  protected readonly lastError = this.realtime.lastError;

  /** Placeholder live data until the Layers panel (A-04) builds real views. */
  private readonly airplanes = this.realtime.openView({ entityType: 'airplanes' });
  protected readonly airplanesPage = this.realtime.subscribePage(this.airplanes, { pageSize: 50 });
  protected readonly layersOpen = signal(true);
  protected readonly drawerOpen = signal(false);

  protected async signOut(): Promise<void> {
    this.auth.signOut();
    await this.router.navigate(['/login']);
  }
}
