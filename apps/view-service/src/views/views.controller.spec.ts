import { get, type IncomingMessage } from 'node:http';
import {
  NotFoundException,
  type INestApplication,
  type MessageEvent,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { FakeStreamReader } from '../changes/fake-stream-reader.js';
import { StreamReader } from '../changes/stream-reader.js';
import { DbService } from '../db/db.service.js';
import { ExampleModule } from '../example/example.module.js';
import type { ChangeFeed } from '../changes/change-feed.js';
import { DependencyIndex } from './dependency-index.js';
import type { ViewLoader } from './view-loader.js';
import { ViewRegistry } from './view-registry.js';
import { ViewService } from './view.service.js';
import type { Row } from './view-diff.js';
import { HEARTBEAT_MS, ViewsController } from './views.controller.js';

describe('ViewsController (observable)', () => {
  function setup() {
    const registry = new ViewRegistry();
    const loader = {
      fetchByIds: vi.fn(() =>
        Promise.resolve<Row[]>([{ id: 'a', version: 1, name: 'x' }]),
      ),
    };
    const service = new ViewService(
      registry,
      loader as unknown as ViewLoader,
      new DependencyIndex(),
      {} as ChangeFeed,
    );
    const controller = new ViewsController(
      registry,
      service,
      new DependencyIndex(),
    );
    const view = registry.open('key', 'orders', { text: 'SELECT', values: [] });
    view.ids.set('a', 1);
    view.loaded = true;
    return { controller, service, view, loader };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws 404 for an unknown or not yet loaded view', () => {
    const { controller, view } = setup();

    expect(() => controller.events('unknown', {})).toThrow(NotFoundException);
    view.loaded = false;
    expect(() => controller.events('key', {})).toThrow(NotFoundException);
  });

  it('sends a snapshot with rows first, then events published while the rows were read', async () => {
    const { controller, service, view } = setup();
    const got: MessageEvent[] = [];

    const sub = controller.events('key', {}).subscribe((m) => got.push(m));
    service.publish(view, 'test', { n: 1 });
    expect(got).toEqual([]);

    await vi.waitFor(() => expect(got).toHaveLength(2));
    service.publish(view, 'test', { n: 2 });
    expect(got).toEqual([
      {
        type: 'snapshot',
        id: '0',
        data: {
          viewKey: 'key',
          seq: 0,
          sort: 'id',
          offset: 0,
          total: 1,
          rows: [{ id: 'a', version: 1, name: 'x' }],
        },
      },
      { type: 'test', id: '1', data: { n: 1 } },
      { type: 'test', id: '2', data: { n: 2 } },
    ]);
    sub.unsubscribe();
  });

  it('ends the stream when the rows cannot be read', async () => {
    const { controller, view, loader } = setup();
    loader.fetchByIds.mockRejectedValueOnce(new Error('connection lost'));

    const error = new Promise((resolve) =>
      controller.events('key', {}).subscribe({ error: resolve }),
    );

    expect(await error).toEqual(new Error('connection lost'));
    expect(view.listeners.size).toBe(0);
    clearTimeout(view.closeTimer);
  });

  it('removes the listener when the client goes away, starting the close timer', () => {
    const { controller, view } = setup();

    const sub = controller.events('key', {}).subscribe();
    expect(view.listeners.size).toBe(1);
    expect(view.closesAt).toBeUndefined();
    sub.unsubscribe();
    expect(view.listeners.size).toBe(0);
    expect(view.closesAt).toBeDefined();
    clearTimeout(view.closeTimer);
  });

  it('streams one range when a limit is given: its window first, then its own events', async () => {
    const { controller, service, view } = setup();
    view.ids.set('b', 1);
    const got: MessageEvent[] = [];

    const sub = controller
      .events('key', { offset: '0', limit: '1' })
      .subscribe((m) => got.push(m));
    service.publish(view, 'delta', { n: 1 });
    await vi.waitFor(() => expect(got).toHaveLength(1));

    expect(got).toEqual([
      {
        type: 'window',
        id: '0',
        data: {
          sort: 'id',
          offset: 0,
          total: 2,
          ids: ['a'],
          rows: [{ id: 'a', version: 1, name: 'x' }],
        },
      },
    ]);
    expect(view.windows.size).toBe(1);
    sub.unsubscribe();
    expect(view.windows.size).toBe(0);
    clearTimeout(view.closeTimer);
  });

  it('refuses an offset without a limit', () => {
    const { controller } = setup();

    expect(() => controller.events('key', { offset: '5' })).toThrow(
      'offset needs a limit: without one the stream has every row',
    );
  });

  it('sends a heartbeat comment', () => {
    vi.useFakeTimers();
    const { controller } = setup();
    const got: MessageEvent[] = [];

    const sub = controller.events('key', {}).subscribe((m) => got.push(m));
    vi.advanceTimersByTime(HEARTBEAT_MS);

    expect(got.at(-1)).toEqual({ comment: 'ping' });
    sub.unsubscribe();
  });
});

describe('GET /views/:viewKey/events (HTTP)', () => {
  let app: INestApplication<App>;
  let baseUrl: string;
  const db = {
    query: vi.fn().mockResolvedValue([
      {
        id: 'order-1',
        version: '2',
        name: 'n',
        item_type: 'book',
        item_price: '10.00',
      },
    ]),
    onModuleDestroy: vi.fn(),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ExampleModule],
    })
      .overrideProvider(DbService)
      .useValue(db)
      .overrideProvider(StreamReader)
      .useValue(new FakeStreamReader())
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterEach(async () => {
    await app.close();
  });

  /** Opens the stream and resolves once `text` has arrived. */
  function readUntil(
    url: string,
    text: string,
  ): Promise<{ res: IncomingMessage; body: string }> {
    return new Promise((resolve, reject) => {
      get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.includes(text)) {
            resolve({ res, body });
          }
        });
      }).on('error', reject);
    });
  }

  it('streams the snapshot and published events of a view opened by a route', async () => {
    const opened = await request(app.getHttpServer())
      .get('/orders?type=book')
      .expect(200);
    const { viewKey } = opened.body as { viewKey: string };
    const view = app.get(ViewRegistry).get(viewKey)!;

    const stream = await readUntil(
      `${baseUrl}/views/${viewKey}/events`,
      'event: snapshot',
    );
    expect(stream.res.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toContain(
      `data: {"viewKey":"${viewKey}","seq":0,"sort":"name:asc","offset":0,"total":1,"rows":[{"id":"order-1","version":2,"name":"n","item_type":"book","item_price":"10.00"}]}`,
    );

    const next = new Promise<string>((resolve) => {
      stream.res.on('data', (chunk: string) => resolve(chunk));
    });
    app.get(ViewService).publish(view, 'test', { hello: 'world' });
    expect(await next).toBe('event: test\nid: 1\ndata: {"hello":"world"}\n\n');

    stream.res.destroy();
    await vi.waitFor(() => expect(view.listeners.size).toBe(0));
  });

  it('lists open views with the dependencies they registered', async () => {
    const opened = await request(app.getHttpServer())
      .get('/orders?type=book')
      .expect(200);

    const res = await request(app.getHttpServer()).get('/views').expect(200);

    expect(res.body).toEqual({
      watchedTypes: ['orders', 'items'],
      views: [
        {
          viewKey: opened.body.viewKey,
          entityType: 'orders',
          loaded: true,
          total: 1,
          seq: 0,
          closesAt: expect.any(String),
          listeners: 0,
          windows: [],
          sortable: { name: 'text', item_type: 'text', item_price: 'number' },
          defaultSort: 'name:asc',
          // Built by the page the route returned.
          sorts: ['name:asc'],
          dependsOn: {
            orders: { fields: ['name', 'item_id', 'customer_id'] },
            items: {
              fields: ['type', 'price'],
              link: 'SELECT o.id FROM orders o WHERE o.item_id = ANY($1)',
            },
          },
        },
      ],
    });
  });

  it('shows the ids of a view in a sort order, from memory', async () => {
    db.query.mockResolvedValueOnce([
      {
        id: 'b',
        version: '1',
        name: 'Pen',
        item_type: 'office',
        item_price: '25.00',
      },
      {
        id: 'a',
        version: '1',
        name: 'Book',
        item_type: 'book',
        item_price: '100.00',
      },
      {
        id: 'c',
        version: '1',
        name: 'Cup',
        item_type: 'home',
        item_price: '25.00',
      },
    ]);
    const opened = await request(app.getHttpServer())
      .get('/orders?type=sort-spec')
      .expect(200);
    const url = `/views/${opened.body.viewKey}/order`;
    const queries = db.query.mock.calls.length;

    const byName = await request(app.getHttpServer()).get(url).expect(200);
    const byPrice = await request(app.getHttpServer())
      .get(`${url}?sort=item_price:desc`)
      .expect(200);

    expect(byName.body).toEqual({
      sort: 'name:asc',
      total: 3,
      order: [
        { id: 'a', value: 'Book' },
        { id: 'c', value: 'Cup' },
        { id: 'b', value: 'Pen' },
      ],
    });
    expect(byPrice.body.order).toEqual([
      { id: 'a', value: 100 },
      { id: 'b', value: 25 },
      { id: 'c', value: 25 },
    ]);
    expect(db.query.mock.calls.length).toBe(queries);
  });

  it('returns a page of a view that is already open, by its viewKey', async () => {
    const opened = await request(app.getHttpServer())
      .get('/orders?type=book')
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/views/${opened.body.viewKey}/rows?sort=item_price:desc&limit=5`)
      .expect(200);

    expect(res.body).toEqual({
      viewKey: opened.body.viewKey,
      seq: 0,
      sort: 'item_price:desc',
      offset: 0,
      total: 1,
      rows: [expect.objectContaining({ id: 'order-1' })],
    });
    await request(app.getHttpServer())
      .get(`/views/${opened.body.viewKey}/rows?limit=0`)
      .expect(400);
    await request(app.getHttpServer()).get('/views/nope/rows').expect(404);
  });

  it('returns 400 INVALID_PARAM for a column that is not sortable', async () => {
    const opened = await request(app.getHttpServer())
      .get('/orders?type=book')
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/views/${opened.body.viewKey}/order?sort=customer_id`)
      .expect(400);

    expect(res.body).toEqual({
      code: 'INVALID_PARAM',
      message:
        'cannot sort by customer_id; sortable: name, item_type, item_price',
    });
  });

  it('returns 404 UNKNOWN_VIEW for a view that is not open', async () => {
    const res = await request(app.getHttpServer())
      .get('/views/nope/events')
      .expect(404);

    expect(res.body).toEqual({
      code: 'UNKNOWN_VIEW',
      message: 'view nope is not open',
    });
  });
});
