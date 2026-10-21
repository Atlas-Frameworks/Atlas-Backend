import { StreamReader, type StreamEntry } from './stream-reader.js';

/** In-memory StreamReader for tests. `read` waits like XREAD BLOCK: until an entry is added, `blockMs` passes, or it is closed. */
export class FakeStreamReader extends StreamReader {
  readonly streams = new Map<string, StreamEntry[]>();
  /** Set to make the next calls fail. */
  failNext: Error | undefined;
  private lastSeq = 0;
  private closed = false;
  private waiters: (() => void)[] = [];

  /** Appends one entry the way Debezium writes it: entity key, then event JSON. */
  add(stream: string, event: { id: string }): string {
    return this.addRaw(stream, [
      JSON.stringify(event.id),
      JSON.stringify(event),
    ]);
  }

  /** Appends one entry with these exact fields. */
  addRaw(stream: string, fields: string[]): string {
    this.lastSeq += 1;
    const id = `${this.lastSeq}-0`;
    const entries = this.streams.get(stream) ?? [];
    entries.push({ id, fields });
    this.streams.set(stream, entries);
    this.wakeAll();
    return id;
  }

  lastId(stream: string): Promise<string> {
    const error = this.takeFailure();
    if (error) {
      return Promise.reject(error);
    }
    return Promise.resolve(this.streams.get(stream)?.at(-1)?.id ?? '0-0');
  }

  async read(
    positions: ReadonlyMap<string, string>,
    blockMs: number,
    count: number,
  ): Promise<Map<string, StreamEntry[]>> {
    for (;;) {
      const error = this.takeFailure();
      if (error) {
        throw error;
      }
      if (this.closed) {
        throw new Error('Connection is closed.');
      }
      const result = new Map<string, StreamEntry[]>();
      for (const [stream, after] of positions) {
        const entries = (this.streams.get(stream) ?? [])
          .filter((e) => seqOf(e.id) > seqOf(after))
          .slice(0, count);
        if (entries.length > 0) {
          result.set(stream, entries);
        }
      }
      if (result.size > 0) {
        return result;
      }
      const timedOut = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), blockMs);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      if (timedOut) {
        return result;
      }
    }
  }

  close(): Promise<void> {
    this.closed = true;
    this.wakeAll();
    return Promise.resolve();
  }

  private takeFailure(): Error | undefined {
    const error = this.failNext;
    this.failNext = undefined;
    return error;
  }

  private wakeAll(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) {
      wake();
    }
  }
}

function seqOf(id: string): number {
  return Number(id.split('-')[0]);
}
