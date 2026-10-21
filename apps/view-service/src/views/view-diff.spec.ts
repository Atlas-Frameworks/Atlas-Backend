import {
  applyDeletes,
  applyFull,
  applyRecheck,
  emptyDiff,
  isEmpty,
} from './view-diff.js';

function held(): Map<string, number> {
  return new Map([
    ['a', 1],
    ['b', 1],
  ]);
}

describe('view diff', () => {
  it('adds, updates and removes the re-checked ids', () => {
    const ids = held();
    const diff = emptyDiff();
    const expected = new Map([
      ['a', 2],
      ['b', 0],
      ['c', 1],
    ]);

    const retry = applyRecheck(
      ids,
      expected,
      [
        { id: 'a', version: 2 },
        { id: 'c', version: 1 },
      ],
      diff,
    );

    expect(diff).toEqual({ added: ['c'], updated: ['a'], removed: ['b'] });
    expect([...ids]).toEqual([
      ['a', 2],
      ['c', 1],
    ]);
    expect(retry.size).toBe(0);
  });

  it('leaves ids that were not re-checked alone', () => {
    const ids = held();
    const diff = emptyDiff();

    applyRecheck(ids, new Map([['a', 0]]), [{ id: 'a', version: 1 }], diff);

    expect(isEmpty(diff)).toBe(true);
    expect(ids.has('b')).toBe(true);
  });

  it('retries a row older than the event instead of applying it', () => {
    const ids = held();
    const diff = emptyDiff();

    const retry = applyRecheck(
      ids,
      new Map([['a', 3]]),
      [{ id: 'a', version: 2 }],
      diff,
    );

    expect(retry).toEqual(new Map([['a', 3]]));
    expect(isEmpty(diff)).toBe(true);
    expect(ids.get('a')).toBe(1);
  });

  it('removes deleted ids that the view holds', () => {
    const ids = held();
    const diff = emptyDiff();

    applyDeletes(ids, ['a', 'z'], diff);

    expect(diff.removed).toEqual(['a']);
    expect([...ids.keys()]).toEqual(['b']);
  });

  it('diffs a full run against the ids held', () => {
    const ids = held();
    const diff = emptyDiff();

    applyFull(
      ids,
      [
        { id: 'b', version: 4 },
        { id: 'c', version: 1 },
      ],
      diff,
    );

    expect(diff).toEqual({ added: ['c'], updated: ['b'], removed: ['a'] });
    expect([...ids]).toEqual([
      ['b', 4],
      ['c', 1],
    ]);
  });
});
