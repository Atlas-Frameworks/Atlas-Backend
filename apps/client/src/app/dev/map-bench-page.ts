import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Placeholder: the map adapter benchmark pages of C-05 (Cesium) and C-06 (deck.gl) land here. */
@Component({
  selector: 'app-map-bench-page',
  template: `
    <main class="bench">
      <h1>Map benchmark</h1>
      <p class="muted">The C-05 / C-06 adapter benchmarks will be mounted here.</p>
    </main>
  `,
  styles: `
    .bench {
      padding: var(--atlas-space-5);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapBenchPage {}
