import { ChangeBuffer } from './change-buffer.js';
import { ChangeFeed, RETRY_MS } from './change-feed.js';
import { FakeStreamReader } from './fake-stream-reader.js';
import { changeEvent } from './test-events.js';

describe('ChangeFeed', () => {
  let reader: FakeStreamReader;
  let buffer: ChangeBuffer;
  let feed: ChangeFeed;

  beforeEach(() => {
    reader = new FakeStreamReader();
    buffer = new ChangeBuffer();
    feed = new ChangeFeed(reader, buffer);
    feed.blockMs = 20;
    vi.spyOn(feed['logger'], 'error').mockImplementation(() => undefined);
    vi.spyOn(feed['logger'], 'warn').mockImplementation(() => undefined);
    feed.onApplicationBootstrap();
  });

  afterEach(async () => {
    await feed.onModuleDestroy();
    vi.useRealTimers();
  });

  it('reads only entries added after a type was watched', async () => {
    reader.add('changes:orders', changeEvent({ id: 'old', typeSeq: 1 }));
    await feed.watch(['orders']);
    expect(feed.streamPositions()).toEqual({ 'changes:orders': '1-0' });

    const id = reader.add(
      'changes:orders',
      changeEvent({ id: 'new', typeSeq: 2 }),
    );

    await vi.waitFor(() =>
      expect(buffer.peek().map((e) => e.id)).toEqual(['new']),
    );
    expect(feed.streamPositions()).toEqual({ 'changes:orders': id });
    expect(feed.stats.entries).toBe(1);
  });

  it('starts at 0-0 for a stream that does not exist yet', async () => {
    await feed.watch(['items']);
    reader.add('changes:items', changeEvent({ type: 'items', id: 'x' }));

    expect(feed.streamPositions()).toEqual({ 'changes:items': '0-0' });
    await vi.waitFor(() => expect(buffer.peek()).toHaveLength(1));
  });

  it('adds a type watched while a read is waiting', async () => {
    await feed.watch(['orders']);
    await feed.watch(['orders', 'items']);
    reader.add('changes:items', changeEvent({ type: 'items', id: 'x' }));

    await vi.waitFor(() =>
      expect(buffer.peek().map((e) => e.type)).toEqual(['items']),
    );
  });

  it('records each stream position once, for concurrent watchers', async () => {
    const lastId = vi.spyOn(reader, 'lastId');

    await Promise.all([feed.watch(['orders']), feed.watch(['orders'])]);
    await feed.watch(['orders']);

    expect(lastId).toHaveBeenCalledTimes(1);
  });

  it('lets watch fail and succeed on the next try', async () => {
    reader.failNext = new Error('redis down');

    await expect(feed.watch(['orders'])).rejects.toThrow('redis down');
    await feed.watch(['orders']);

    expect(feed.streamPositions()).toEqual({ 'changes:orders': '0-0' });
  });

  it('stops reading an unwatched type and drops its pending events', async () => {
    await feed.watch(['orders', 'items']);
    reader.add('changes:orders', changeEvent({ id: 'a', typeSeq: 1 }));
    await vi.waitFor(() => expect(buffer.peek()).toHaveLength(1));

    feed.unwatch(['orders']);
    reader.add('changes:orders', changeEvent({ id: 'b', typeSeq: 2 }));
    reader.add('changes:items', changeEvent({ type: 'items', id: 'x' }));

    await vi.waitFor(() =>
      expect(buffer.peek().map((e) => e.id)).toEqual(['x']),
    );
    expect(Object.keys(feed.streamPositions())).toEqual(['changes:items']);
  });

  it('reads a type watched again from its position at that time', async () => {
    await feed.watch(['orders']);
    feed.unwatch(['orders']);
    reader.add('changes:orders', changeEvent({ id: 'missed', typeSeq: 1 }));

    await feed.watch(['orders']);
    reader.add('changes:orders', changeEvent({ id: 'new', typeSeq: 2 }));

    await vi.waitFor(() =>
      expect(buffer.peek().map((e) => e.id)).toEqual(['new']),
    );
  });

  it('does not start reading a type unwatched while its position was recorded', async () => {
    const watching = feed.watch(['orders']);
    feed.unwatch(['orders']);
    await watching;

    expect(feed.streamPositions()).toEqual({});
  });

  it('counts invalid events and moves past them', async () => {
    await feed.watch(['orders']);
    reader.addRaw('changes:orders', ['k', 'not json']);
    reader.add('changes:orders', changeEvent());

    await vi.waitFor(() => expect(buffer.peek()).toHaveLength(1));
    expect(feed.stats.invalid).toBe(1);
  });

  it('retries after a failed read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await feed.watch(['orders']);
    reader.failNext = new Error('connection lost');
    reader.add('changes:orders', changeEvent());
    await vi.waitFor(() => expect(feed.stats.readErrors).toBe(1));

    await vi.advanceTimersByTimeAsync(RETRY_MS);

    await vi.waitFor(() => expect(buffer.peek()).toHaveLength(1));
  });
});
