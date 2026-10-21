import type { DbService } from '../db/db.service.js';
import { View } from './view.js';
import { sql } from './sql.js';
import { hashRow } from './view-diff.js';
import { recheckStatement, ViewLoader } from './view-loader.js';

const statement = {
  text: 'SELECT o.id, o.version FROM orders o WHERE o.name = $1',
  values: ['x'],
};

function setup(query: () => Promise<{ id: string; version: string }[]>) {
  const db = { query: vi.fn(query) };
  const loader = new ViewLoader(db as unknown as DbService);
  return { db, loader, view: new View('key', 'orders', statement) };
}

describe('ViewLoader', () => {
  it("fills the view with ids, versions and row hashes from the view's statement", async () => {
    const { db, loader, view } = setup(async () => [
      { id: 'a', version: '3', name: 'x' },
      { id: 'b', version: '1', name: 'y' },
    ]);

    await loader.ensureLoaded(view);

    expect(db.query).toHaveBeenCalledWith(statement);
    expect(view.loaded).toBe(true);
    expect([...view.ids]).toEqual([
      ['a', 3],
      ['b', 1],
    ]);
    expect(view.hashes.get('a')).toBe(
      hashRow({ id: 'a', version: 3, name: 'x' }),
    );
  });

  it('keeps the sortable columns of every loaded row', async () => {
    const db = {
      query: vi.fn(async () => [
        { id: 'a', version: '1', item_price: '25.50' },
        { id: 'b', version: '1', item_price: '7.00' },
      ]),
    };
    const loader = new ViewLoader(db as unknown as DbService);
    const view = new View('key', 'orders', statement, {
      item_price: 'number',
    });

    await loader.ensureLoaded(view);

    expect(view.sortKeys.get('item_price', 'a')).toBe(25.5);
    expect(view.sortKeys.get('item_price', 'b')).toBe(7);
  });

  it('fails the load when the query does not select a sortable column', async () => {
    const db = { query: vi.fn(async () => [{ id: 'a', version: '1' }]) };
    const loader = new ViewLoader(db as unknown as DbService);
    const view = new View('key', 'orders', statement, { name: 'text' });

    await expect(loader.ensureLoaded(view)).rejects.toThrow(
      'sortable column name is not selected by the query',
    );
    expect(view.loaded).toBe(false);
  });

  it('runs one query for callers that arrive while it loads', async () => {
    const { db, loader, view } = setup(async () => [{ id: 'a', version: '1' }]);

    await Promise.all([
      loader.ensureLoaded(view),
      loader.ensureLoaded(view),
      loader.ensureLoaded(view),
    ]);
    await loader.ensureLoaded(view);

    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('tries again after a failed load', async () => {
    let calls = 0;
    const { db, loader, view } = setup(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('connection refused');
      }
      return [{ id: 'a', version: '1' }];
    });

    await expect(loader.ensureLoaded(view)).rejects.toThrow(
      'connection refused',
    );
    expect(view.loaded).toBe(false);
    await loader.ensureLoaded(view);

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(view.ids.has('a')).toBe(true);
  });

  it("reads rows by id with the view's own SQL, the ids as the next parameter", async () => {
    const { db, loader, view } = setup(async () => [
      { id: 'a', version: '4', name: 'x' },
    ]);

    const rows = await loader.fetchByIds(view, ['a', 'b']);

    expect(db.query).toHaveBeenCalledWith({
      text: 'SELECT q.* FROM (SELECT o.id, o.version FROM orders o WHERE o.name = $1) q WHERE q.id = ANY($2)',
      values: ['x', ['a', 'b']],
    });
    expect(rows).toEqual([{ id: 'a', version: 4, name: 'x' }]);
  });

  it('reads no rows for no ids, without a query', async () => {
    const { db, loader, view } = setup(async () => []);

    expect(await loader.fetchByIds(view, [])).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('runs a link for changed ids of a related type', async () => {
    const { db, loader } = setup(async () => [{ id: 'a', version: '1' }]);

    const ids = await loader.linked(
      (itemIds) =>
        sql`SELECT o.id FROM orders o WHERE o.item_id = ANY(${itemIds})`,
      ['item-1'],
    );

    expect(db.query).toHaveBeenCalledWith({
      text: 'SELECT o.id FROM orders o WHERE o.item_id = ANY($1)',
      values: [['item-1']],
    });
    expect(ids).toEqual(['a']);
  });
});

describe('recheckStatement', () => {
  it('works for SQL without parameters', () => {
    expect(
      recheckStatement({ text: 'SELECT id, version FROM orders', values: [] }, [
        'a',
      ]),
    ).toEqual({
      text: 'SELECT q.* FROM (SELECT id, version FROM orders) q WHERE q.id = ANY($1)',
      values: [['a']],
    });
  });
});
