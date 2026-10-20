import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Placeholder: replaced by its task. Reads and writes shared state only via WorkspaceStore. */
@Component({
  selector: 'app-detail-drawer',
  template: '<p class="muted">Select a point on the map or a row in a list (A-05)</p>',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DetailDrawer {}
