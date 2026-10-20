import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DetailDrawer } from '../detail/detail-drawer';
import { LayersPanel } from '../layers/layers-panel';
import { MapView } from '../map/map-view';
import { Router } from '@angular/router';
import { AuthStore } from '../auth/auth.store';
import { AtlasRealtimeService } from '../realtime/atlas-realtime.service';
import { ConnectionStatus } from './connection-status';
import { WorkspaceStore } from './workspace.store';

/**
 * The map workspace: a full-screen map area with the top bar, the collapsible Layers panel (A-04)
 * and the detail drawer (A-05) floating over it. The panels are placeholders until those tasks land;
 * the map (A-03), layers panel (A-04) and drawer (A-05) talk only through WorkspaceStore.
 */
@Component({
  selector: 'app-workspace-page',
  imports: [ConnectionStatus, MapView, LayersPanel, DetailDrawer],
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

  private readonly store = inject(WorkspaceStore);

  protected readonly layersOpen = signal(true);
  protected readonly drawerOpen = this.store.drawerOpen;

  protected async signOut(): Promise<void> {
    this.auth.signOut();
    await this.router.navigate(['/login']);
  }
}
