import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { FakeStreamReader } from '../changes/fake-stream-reader.js';
import { StreamReader } from '../changes/stream-reader.js';
import { changeEvent } from '../changes/test-events.js';
import { DbService } from '../db/db.service.js';
import { ExampleModule } from '../example/example.module.js';
import { TickService } from './tick.service.js';

describe('GET /changes', () => {
  let app: INestApplication<App>;
  let reader: FakeStreamReader;

  beforeEach(async () => {
    reader = new FakeStreamReader();
    const db = {
      query: vi.fn().mockResolvedValue([
        {
          id: 'order-1',
          version: '1',
          name: 'n',
          item_type: 'book',
          item_price: '10.00',
        },
      ]),
      onModuleDestroy: vi.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [ExampleModule],
    })
      .overrideProvider(DbService)
      .useValue(db)
      .overrideProvider(StreamReader)
      .useValue(reader)
      .compile();
    // Keep the events pending, so the test sees them before a tick takes them.
    moduleRef.get(TickService).tickMs = 60_000;
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('reads nothing before a view is open', async () => {
    const res = await request(app.getHttpServer()).get('/changes').expect(200);

    expect(res.body).toMatchObject({ positions: {}, pending: [] });
  });

  it('shows events read after a view opened, with the views they may affect', async () => {
    reader.add('changes:orders', changeEvent({ id: 'before-open' }));
    const opened = await request(app.getHttpServer())
      .get('/orders?type=book')
      .expect(200);
    const { viewKey } = opened.body as { viewKey: string };

    reader.add(
      'changes:orders',
      changeEvent({ id: 'order-1', version: 3, typeSeq: 2 }),
    );
    reader.add(
      'changes:orders',
      changeEvent({
        id: 'order-2',
        version: 5,
        typeSeq: 3,
        // A field no query reads or sends.
        changes: { old: { note: 'a' }, new: { note: 'b' } },
      }),
    );

    await vi.waitFor(async () => {
      const res = await request(app.getHttpServer()).get('/changes');
      expect(res.body.pending).toHaveLength(2);
    });
    const res = await request(app.getHttpServer()).get('/changes').expect(200);
    expect(res.body).toMatchObject({
      positions: { 'changes:orders': '3-0', 'changes:items': '0-0' },
      typeSeq: { orders: 3 },
      feed: { entries: 2, invalid: 0, readErrors: 0 },
      buffer: { received: 2, duplicates: 0, gaps: 0 },
      tick: { ticks: 0 },
      pending: [
        {
          type: 'orders',
          id: 'order-1',
          op: 'upsert',
          version: 3,
          typeSeq: 2,
          fields: ['item_id'],
          candidates: { own: [viewKey], linked: [] },
        },
        {
          id: 'order-2',
          fields: ['note'],
          candidates: { own: [], linked: [] },
        },
      ],
    });
  });
});
