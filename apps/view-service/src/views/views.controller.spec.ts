import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { ViewsModule } from './views.module.js';

const booksOver100 = {
  entityType: 'orders',
  filter: {
    and: [
      { field: 'item.type', op: 'eq', value: 'book' },
      { field: 'item.price', op: 'gt', value: 100 },
    ],
  },
};

describe('POST /views', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ViewsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('opens a view and returns its key and empty state', async () => {
    const res = await request(app.getHttpServer())
      .post('/views')
      .send(booksOver100)
      .expect(200);

    expect(res.body).toEqual({
      viewKey: expect.stringMatching(/^[0-9a-f]{32}$/),
      seq: 0,
      total: 0,
      ids: [],
    });
  });

  it('returns the same view for the same query', async () => {
    const server = app.getHttpServer();
    const first = await request(server).post('/views').send(booksOver100);
    const second = await request(server).post('/views').send(booksOver100);

    expect(second.body.viewKey).toBe(first.body.viewKey);
  });

  it('returns 400 INVALID_FILTER for a bad filter', async () => {
    const res = await request(app.getHttpServer())
      .post('/views')
      .send({
        entityType: 'orders',
        filter: { field: 'item.price', op: 'gt', value: 'cheap' },
      })
      .expect(400);

    expect(res.body).toEqual({
      code: 'INVALID_FILTER',
      message: 'filter.value must be a number',
    });
  });

  it('returns 400 for a missing body', async () => {
    const res = await request(app.getHttpServer()).post('/views').expect(400);

    expect(res.body.code).toBe('INVALID_FILTER');
  });
});
