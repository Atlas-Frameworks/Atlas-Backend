import { parseEntry } from './parse-entry.js';
import { changeEvent } from './test-events.js';

describe('parseEntry', () => {
  it('reads the event from a Debezium entry (entity key, event JSON)', () => {
    const event = changeEvent();

    expect(parseEntry(['"order-1"', JSON.stringify(event)])).toEqual({
      events: [event],
      invalid: [],
    });
  });

  it('reads the event from a field named value', () => {
    const event = changeEvent();

    expect(parseEntry(['value', JSON.stringify(event)]).events).toEqual([
      event,
    ]);
  });

  it('accepts a delete without changes', () => {
    const event = changeEvent({ op: 'delete', changes: undefined });

    expect(parseEntry(['k', JSON.stringify(event)]).events).toHaveLength(1);
  });

  it('puts anything that is not a v2 event in invalid', () => {
    const bad = [
      'not json',
      'null',
      JSON.stringify(changeEvent({ schema: 1 as 2 })),
      JSON.stringify(changeEvent({ op: 'insert' as 'upsert' })),
      JSON.stringify(changeEvent({ version: 1.5 })),
      JSON.stringify(changeEvent({ changes: undefined })),
      JSON.stringify({ ...changeEvent(), changes: { old: [], new: {} } }),
    ];

    const { events, invalid } = parseEntry(bad.flatMap((v) => ['k', v]));

    expect(events).toEqual([]);
    expect(invalid).toEqual(bad);
  });
});
