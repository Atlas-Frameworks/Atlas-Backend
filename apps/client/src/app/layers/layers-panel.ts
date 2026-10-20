import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Placeholder: replaced by its task. Reads and writes shared state only via WorkspaceStore. */
@Component({
  selector: 'app-layers-panel',
  template: '<p class="muted">Filters, grouping and live pages (A-04)</p>',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LayersPanel {}
