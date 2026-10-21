import { Redis } from 'ioredis';

export interface StreamEntry {
  id: string;
  /** Field, value, field, value, … */
  fields: string[];
}

/**
 * Reads Redis streams. An abstract class so it works as a Nest token and
 * tests can swap in a fake.
 */
export abstract class StreamReader {
  /** The id of the newest entry, or "0-0" for an empty or missing stream. */
  abstract lastId(stream: string): Promise<string>;
  /**
   * Entries after each stream's position, waiting up to `blockMs` for new ones.
   * Returns an empty map when nothing arrived.
   */
  abstract read(
    positions: ReadonlyMap<string, string>,
    blockMs: number,
    count: number,
  ): Promise<Map<string, StreamEntry[]>>;
  abstract close(): Promise<void>;
}

/** StreamReader on ioredis. Blocking reads get their own connection. */
export class RedisStreamReader extends StreamReader {
  private readonly blocking: Redis;
  private readonly commands: Redis;

  constructor(url: string) {
    super();
    this.blocking = new Redis(url, { maxRetriesPerRequest: null });
    this.commands = new Redis(url);
  }

  async lastId(stream: string): Promise<string> {
    const [newest] = await this.commands.xrevrange(
      stream,
      '+',
      '-',
      'COUNT',
      1,
    );
    return newest?.[0] ?? '0-0';
  }

  async read(
    positions: ReadonlyMap<string, string>,
    blockMs: number,
    count: number,
  ): Promise<Map<string, StreamEntry[]>> {
    const streams = [...positions.keys()];
    const ids = streams.map((stream) => positions.get(stream)!);
    const reply = await this.blocking.xread(
      'COUNT',
      count,
      'BLOCK',
      blockMs,
      'STREAMS',
      ...streams,
      ...ids,
    );
    const result = new Map<string, StreamEntry[]>();
    for (const [stream, entries] of reply ?? []) {
      result.set(
        stream,
        entries.map(([id, fields]) => ({ id, fields })),
      );
    }
    return result;
  }

  async close(): Promise<void> {
    this.blocking.disconnect();
    await this.commands.quit();
  }
}
