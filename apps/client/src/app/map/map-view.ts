import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Placeholder: replaced by its task. Reads and writes shared state only via WorkspaceStore. */
@Component({
  selector: 'app-map-view',
  template: '<p class="muted">Map (A-03)</p>',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapView {}
