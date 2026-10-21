import { DependencyIndex } from './dependency-index.js';
import type { ViewLoader } from './view-loader.js';
import { ViewRegistry } from './view-registry.js';
import { ViewService } from './view.service.js';
import type { ViewEvent } from './view.js';

function setup() {
  const registry = new ViewRegistry();
  const service = new ViewService(
    registry,
    {} as ViewLoader,
    new DependencyIndex(),
  );
  const view = registry.open('key', 'orders', { text: 'SELECT', values: [] });
  view.ids.set('a', 1).set('b', 2);
  return { service, view };
}

describe('ViewService', () => {
  it('takes a snapshot of the ids at the current seq', () => {
    const { service, view } = setup();
    view.nextSeq();

    expect(service.snapshot(view)).toEqual({
      viewKey: 'key',
      seq: 1,
      total: 2,
      ids: ['a', 'b'],
    });
  });

  it('sends each published event to every listener with the next seq', () => {
    const { service, view } = setup();
    const first: ViewEvent[] = [];
    const second: ViewEvent[] = [];
    view.listeners.add({ send: (e) => first.push(e) });
    view.listeners.add({ send: (e) => second.push(e) });

    service.publish(view, 'test', { n: 1 });
    service.publish(view, 'test', { n: 2 });

    expect(first).toEqual([
      { type: 'test', seq: 1, data: { n: 1 } },
      { type: 'test', seq: 2, data: { n: 2 } },
    ]);
    expect(second).toEqual(first);
    expect(view.seq).toBe(2);
  });

  it('counts seq even when nobody is listening', () => {
    const { service, view } = setup();

    expect(service.publish(view, 'test', {}).seq).toBe(1);
  });
});
