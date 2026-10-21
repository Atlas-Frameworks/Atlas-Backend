import type { ChangeEvent } from './change-event.js';

/** Builds a valid v2 change event for tests; override any field. */
export function changeEvent(overrides: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    schema: 2,
    type: 'orders',
    id: 'order-1',
    op: 'upsert',
    version: 2,
    typeSeq: 1,
    committedAt: '2026-10-21T10:00:00.000Z',
    changes: { old: { item_id: 'a' }, new: { item_id: 'b' } },
    ...overrides,
  };
}
