import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { FakeStreamReader } from '../changes/fake-stream-reader.js';
import { StreamReader } from '../changes/stream-reader.js';
import { DbService } from '../db/db.service.js';
import { ExampleModule } from './example.module.js';

const customerId = '0b8a3f4e-2c1d-4e5f-8a9b-1c2d3e4f5a6b';

describe('example OrdersController', () => {
  let app: INestApplication<App>;
  const db = { query: vi.fn(), onModuleDestroy: vi.fn() };

  beforeEach(async () => {
    db.query.mockReset();
    db.query.mockResolvedValue([
      { id: 'order-1', version: '2' },
      { id: 'order-2', version: '1' },
    ]);
    const moduleRef = await Test.createTestingModule({
      imports: [ExampleModule],
    })
      .overrideProvider(DbService)
      .useValue(db)
      .overrideProvider(StreamReader)
      .useValue(new FakeStreamReader())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  type Stmt = { text: string; values: unknown[] };
  const isRowFetch = (stmt: Stmt) => stmt.text.startsWith('SELECT q.*');

  /** The last full query a view ran (not the rows read by id for a snapshot). */
  function lastSql(): Stmt {
    return db.query.mock.calls
      .map(([stmt]) => stmt as Stmt)
      .filter((stmt) => !isRowFetch(stmt))
      .at(-1)!;
  }

  it('opens a view with only the conditions that were sent', async () => {
    const res = await request(app.getHttpServer())
      .get('/orders?type=book&minPrice=100')
      .expect(200);

    expect(res.body).toEqual({
      viewKey: expect.stringMatching(/^[0-9a-f]{32}$/),
      seq: 0,
      total: 2,
      rows: [
        { id: 'order-1', version: 2 },
        { id: 'order-2', version: 1 },
      ],
    });
    expect(lastSql().text).toMatch(
      /WHERE i\.type = ANY\(\$1\) AND i\.price >= \$2$/,
    );
    expect(lastSql().values).toEqual([['book'], 100]);
  });

  it('has no WHERE when no param is sent', async () => {
    await request(app.getHttpServer()).get('/orders').expect(200);

    expect(lastSql().text).not.toContain('WHERE');
    expect(lastSql().values).toEqual([]);
  });

  it('shares one view for the same params in any order, loaded once', async () => {
    const server = app.getHttpServer();
    const first = await request(server).get('/orders?type=book&minPrice=100');
    const second = await request(server).get(
      '/orders?minPrice=100&type=book&maxPrice=',
    );

    expect(second.body.viewKey).toBe(first.body.viewKey);
    const calls = db.query.mock.calls.map(([stmt]) => stmt as Stmt);
    expect(calls.filter((stmt) => !isRowFetch(stmt))).toHaveLength(1);
    // Each open reads the snapshot's rows by id.
    expect(calls.filter(isRowFetch)).toHaveLength(2);
  });

  it('opens a different view for a different route with the same params', async () => {
    const server = app.getHttpServer();
    const search = await request(server).get(
      `/orders?customerId=${customerId}`,
    );
    const byCustomer = await request(server).get(
      `/orders/by-customer/${customerId}`,
    );

    expect(byCustomer.body.viewKey).not.toBe(search.body.viewKey);
    expect(lastSql().values).toEqual([customerId]);
  });

  it('adds the optional type to the by-customer route', async () => {
    await request(app.getHttpServer())
      .get(`/orders/by-customer/${customerId}?type=food&type=book`)
      .expect(200);

    expect(lastSql().text).toMatch(
      /WHERE o\.customer_id = \$1\s+AND i\.type = ANY\(\$2\)$/,
    );
    expect(lastSql().values).toEqual([customerId, ['food', 'book']]);
  });

  it('returns 400 INVALID_PARAM for a bad param, without querying', async () => {
    const res = await request(app.getHttpServer())
      .get('/orders?minPrice=cheap')
      .expect(400);

    expect(res.body).toEqual({
      code: 'INVALID_PARAM',
      message: 'minPrice must be a number',
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns 400 for a path param that is not a uuid', async () => {
    await request(app.getHttpServer())
      .get('/orders/by-customer/not-a-uuid')
      .expect(400);
  });

  it('selects the columns clients get, and reads them by id for the snapshot', async () => {
    await request(app.getHttpServer()).get('/orders?type=book').expect(200);

    const [load, rows] = db.query.mock.calls.map(([stmt]) => stmt as Stmt);
    expect(load.text).toMatch(
      /SELECT\s+o\.id, o\.version, o\.name, o\.customer_id, o\.item_id,\s+i\.type AS item_type, i\.price AS item_price\s+FROM orders o/,
    );
    expect(rows.text).toBe(
      `SELECT q.* FROM (${load.text}) q WHERE q.id = ANY($2)`,
    );
    expect(rows.values).toEqual([['book'], ['order-1', 'order-2']]);
  });

  it('returns 503 RETRY when Postgres fails', async () => {
    db.query.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app.getHttpServer())
      .get('/orders?type=book')
      .expect(503);
    expect(res.body.code).toBe('RETRY');
  });
});
