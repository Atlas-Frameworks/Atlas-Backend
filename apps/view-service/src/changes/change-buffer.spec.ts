import { ChangeBuffer } from './change-buffer.js';
import { changeEvent } from './test-events.js';

describe('ChangeBuffer', () => {
  let buffer: ChangeBuffer;

  beforeEach(() => {
    buffer = new ChangeBuffer();
  });

  it('keeps events until drained', () => {
    const a = changeEvent({ id: 'a', typeSeq: 1 });
    const b = changeEvent({ id: 'b', typeSeq: 2 });

    expect(buffer.push(a)).toBe('ok');
    expect(buffer.push(b)).toBe('ok');

    expect(buffer.drain()).toEqual({ events: [a, b], gapTypes: [] });
    expect(buffer.drain()).toEqual({ events: [], gapTypes: [] });
  });

  it('drops an event whose typeSeq was already seen', () => {
    buffer.push(changeEvent({ typeSeq: 5 }));

    expect(buffer.push(changeEvent({ typeSeq: 5 }))).toBe('duplicate');
    expect(buffer.push(changeEvent({ typeSeq: 4 }))).toBe('duplicate');
    expect(buffer.stats).toEqual({ received: 3, duplicates: 2, gaps: 0 });
  });

  it('reports a typeSeq gap per type, and still keeps the event', () => {
    buffer.push(changeEvent({ id: 'a', typeSeq: 1 }));
    buffer.push(changeEvent({ type: 'items', id: 'x', typeSeq: 7 }));

    expect(buffer.push(changeEvent({ id: 'b', typeSeq: 3 }))).toBe('gap');

    const batch = buffer.drain();
    expect(batch.gapTypes).toEqual(['orders']);
    expect(batch.events.map((e) => e.id)).toEqual(['a', 'x', 'b']);
  });

  it('keeps one event per entity with the changed fields of all of them', () => {
    buffer.push(
      changeEvent({
        version: 2,
        typeSeq: 1,
        changes: { old: { item_id: 'a' }, new: { item_id: 'b' } },
      }),
    );
    buffer.push(
      changeEvent({
        version: 3,
        typeSeq: 2,
        changes: { old: { name: 'x' }, new: { name: 'y' } },
      }),
    );

    expect(buffer.drain().events).toEqual([
      changeEvent({
        version: 3,
        typeSeq: 2,
        changes: {
          old: { item_id: 'a', name: 'x' },
          new: { item_id: 'b', name: 'y' },
        },
      }),
    ]);
  });

  it('ignores an older version of a pending entity', () => {
    buffer.push(changeEvent({ version: 5, typeSeq: 1 }));
    buffer.push(changeEvent({ version: 4, typeSeq: 2 }));

    expect(buffer.drain().events.map((e) => e.version)).toEqual([5]);
  });

  it('keeps an insert an insert, and lets a delete win', () => {
    const insert = { old: {}, new: { name: 'x', item_id: 'a' } };
    buffer.push(
      changeEvent({ id: 'a', version: 1, typeSeq: 1, changes: insert }),
    );
    buffer.push(changeEvent({ id: 'a', version: 2, typeSeq: 2 }));
    buffer.push(changeEvent({ id: 'b', version: 1, typeSeq: 3 }));
    buffer.push(
      changeEvent({
        id: 'b',
        op: 'delete',
        version: 2,
        typeSeq: 4,
        changes: undefined,
      }),
    );

    const [a, b] = buffer.drain().events;
    expect(a.changes).toEqual({ old: {}, new: { name: 'x', item_id: 'b' } });
    expect(b).toMatchObject({ op: 'delete', version: 2, changes: undefined });
  });

  it('shows pending events and sequences without draining', () => {
    buffer.push(changeEvent({ typeSeq: 9 }));

    expect(buffer.peek()).toHaveLength(1);
    expect(buffer.sequences()).toEqual({ orders: 9 });
    expect(buffer.drain().events).toHaveLength(1);
  });
});
