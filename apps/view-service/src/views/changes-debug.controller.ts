import { Controller, Get } from '@nestjs/common';
import { ChangeBuffer } from '../changes/change-buffer.js';
import type { ChangeEvent } from '../changes/change-event.js';
import { ChangeFeed } from '../changes/change-feed.js';
import { DependencyIndex } from './dependency-index.js';

export interface ChangesDebug {
  /** stream → id of the last entry read. */
  positions: Record<string, string>;
  /** type → last typeSeq seen. */
  typeSeq: Record<string, number>;
  feed: ChangeFeed['stats'];
  buffer: ChangeBuffer['stats'];
  /** Events waiting for the tick (step 7), with the views each one may affect. */
  pending: (Pick<ChangeEvent, 'type' | 'id' | 'op' | 'version' | 'typeSeq'> & {
    fields: string[];
    candidates: { own: string[]; linked: string[] };
  })[];
}

/** GET /changes — debug: what the change feed has read and what it would re-check. */
@Controller('changes')
export class ChangesDebugController {
  constructor(
    private readonly feed: ChangeFeed,
    private readonly buffer: ChangeBuffer,
    private readonly dependencies: DependencyIndex,
  ) {}

  @Get()
  get(): ChangesDebug {
    return {
      positions: this.feed.streamPositions(),
      typeSeq: this.buffer.sequences(),
      feed: this.feed.stats,
      buffer: this.buffer.stats,
      pending: this.buffer.peek().map((evt) => {
        const { own, linked } = this.dependencies.candidates(evt);
        return {
          type: evt.type,
          id: evt.id,
          op: evt.op,
          version: evt.version,
          typeSeq: evt.typeSeq,
          fields: Object.keys({ ...evt.changes?.old, ...evt.changes?.new }),
          candidates: { own, linked: linked.map((c) => c.viewKey) },
        };
      }),
    };
  }
}
