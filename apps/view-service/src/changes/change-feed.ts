import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ChangeBuffer } from './change-buffer.js';
import { parseEntry } from './parse-entry.js';
import { StreamReader, type StreamEntry } from './stream-reader.js';

/** How long one read waits for new entries; also the delay before a new type is read. */
export const BLOCK_MS = 1_000;
/** Entries per stream per read. */
export const READ_COUNT = 500;
/** Wait after a failed read before trying again. */
export const RETRY_MS = 1_000;

const streamOf = (type: string): string => `changes:${type}`;

/**
 * Reads `changes:<type>` for every type a view depends on and pushes the
 * events into the ChangeBuffer. A type is read from the position recorded
 * when it was first watched, so nothing after that point is missed.
 */
@Injectable()
export class ChangeFeed implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ChangeFeed.name);
  /** stream → id of the last entry read. */
  private readonly positions = new Map<string, string>();
  private readonly watching = new Map<string, Promise<void>>();
  private stopped = false;
  private wake: (() => void) | undefined;
  private loop: Promise<void> | undefined;
  readonly stats = { entries: 0, invalid: 0, readErrors: 0 };
  /** A type watched during a read joins on the next one, at most this much later. */
  blockMs = BLOCK_MS;

  constructor(
    private readonly reader: StreamReader,
    private readonly buffer: ChangeBuffer,
  ) {}

  onApplicationBootstrap(): void {
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.reader.close();
    await this.loop;
  }

  /**
   * Starts reading these types, from their current stream position.
   * Resolves once the positions are recorded; call it before a view's first
   * load so every change after the load's snapshot is read.
   */
  async watch(types: Iterable<string>): Promise<void> {
    await Promise.all([...types].map((type) => this.watchOne(type)));
  }

  /** The stream positions being read (for debugging). */
  streamPositions(): Record<string, string> {
    return Object.fromEntries(this.positions);
  }

  private watchOne(type: string): Promise<void> {
    let pending = this.watching.get(type);
    if (!pending) {
      const stream = streamOf(type);
      pending = this.reader.lastId(stream).then(
        (id) => {
          this.positions.set(stream, id);
          this.wake?.();
        },
        (err: unknown) => {
          this.watching.delete(type);
          throw err;
        },
      );
      this.watching.set(type, pending);
    }
    return pending;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      if (this.positions.size === 0) {
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = undefined;
        continue;
      }
      try {
        const read = await this.reader.read(
          new Map(this.positions),
          this.blockMs,
          READ_COUNT,
        );
        this.apply(read);
      } catch (err) {
        if (this.stopped) {
          break;
        }
        this.stats.readErrors += 1;
        this.logger.error('reading change streams failed', err);
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  }

  private apply(read: Map<string, StreamEntry[]>): void {
    for (const [stream, entries] of read) {
      for (const entry of entries) {
        this.stats.entries += 1;
        const { events, invalid } = parseEntry(entry.fields);
        for (const event of events) {
          this.buffer.push(event);
        }
        if (invalid.length > 0) {
          this.stats.invalid += invalid.length;
          this.logger.warn(`${stream} ${entry.id}: skipped an invalid event`);
        }
        this.positions.set(stream, entry.id);
      }
    }
  }
}
