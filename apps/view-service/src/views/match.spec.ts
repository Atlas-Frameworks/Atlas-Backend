import { changeEvent } from '../changes/test-events.js';
import { checkMatch, matchOf, mayMatch } from './match.js';

const forX = matchOf({ customer_id: 'X', status: undefined });

describe('match', () => {
  it('drops conditions whose param is not set', () => {
    expect(forX).toEqual({ customer_id: 'X' });
  });

  it('rules out an insert for another customer, and keeps one for this customer', () => {
    const insert = (customer: string) =>
      changeEvent({
        changes: {
          old: {},
          new: { name: 'n', item_id: 'i', customer_id: customer },
        },
      });

    expect(mayMatch(forX, insert('Y'), undefined)).toBe(false);
    expect(mayMatch(forX, insert('X'), undefined)).toBe(true);
  });

  it('uses the new value when the field changed', () => {
    const moved = changeEvent({
      changes: { old: { customer_id: 'X' }, new: { customer_id: 'Y' } },
    });

    expect(
      mayMatch(forX, moved, { id: 'order-1', version: 1, customer_id: 'X' }),
    ).toBe(false);
  });

  it('uses the held row when the event does not carry the field', () => {
    const itemChanged = changeEvent();

    expect(
      mayMatch(forX, itemChanged, {
        id: 'order-1',
        version: 1,
        customer_id: 'Y',
      }),
    ).toBe(false);
    expect(
      mayMatch(forX, itemChanged, {
        id: 'order-1',
        version: 1,
        customer_id: 'X',
      }),
    ).toBe(true);
  });

  it('is a maybe when neither the event nor a held row knows the field', () => {
    expect(mayMatch(forX, changeEvent(), undefined)).toBe(true);
  });

  it('compares numbers and numeric text by value text', () => {
    const priced = changeEvent({ changes: { old: {}, new: { qty: 3 } } });

    expect(mayMatch(matchOf({ qty: '3' }), priced, undefined)).toBe(true);
    expect(mayMatch(matchOf({ qty: null }), priced, undefined)).toBe(false);
  });

  it('refuses a match field that is not a filter field', () => {
    expect(() =>
      checkMatch(forX, { filter: ['item_id'], shown: ['name'] }, 'q'),
    ).toThrow(
      'query q: match field customer_id must be a filter field of its own type',
    );
    expect(() => checkMatch(forX, { shown: ['customer_id'] }, 'q')).toThrow(
      'must be a filter field',
    );
    expect(() =>
      checkMatch(forX, { filter: ['customer_id'] }, 'q'),
    ).not.toThrow();
    // No filter list: every field not shown is a filter.
    expect(() => checkMatch(forX, undefined, 'q')).not.toThrow();
  });
});
