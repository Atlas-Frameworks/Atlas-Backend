import { Injectable } from '@nestjs/common';
import type { ChangeEvent } from './change-event.js';

// Local stand-in for TickBatcher and SequenceTracker from @atlas/view-engine (E-05).

export type PushResult = 'ok' | 'gap' | 'duplicate';

/** Everything received since the last drain, for one tick. */
export interface ChangeBatch {
  /** One event per entity: the highest version, with the changed fields of all of them. */
  events: ChangeEvent[];
  /** Types with a typeSeq gap: an event was lost, so their views must reload. */
  gapTypes: string[];
}

/**
 * Collects change events between ticks. Keeps one event per entity, drops
 * duplicates by typeSeq and version, and notes typeSeq gaps.
 */
@Injectable()
export class ChangeBuffer {
  private pending = new Map<string, ChangeEvent>();
  private gapTypes = new Set<string>();
  private readonly lastTypeSeq = new Map<string, number>();
  readonly stats = { received: 0, duplicates: 0, gaps: 0 };

  push(evt: ChangeEvent): PushResult {
    this.stats.received += 1;
    const last = this.lastTypeSeq.get(evt.type);
    if (last !== undefined && evt.typeSeq <= last) {
      this.stats.duplicates += 1;
      return 'duplicate';
    }
    this.lastTypeSeq.set(evt.type, evt.typeSeq);
    const gap = last !== undefined && evt.typeSeq > last + 1;
    if (gap) {
      this.stats.gaps += 1;
      this.gapTypes.add(evt.type);
    }
    this.keep(evt);
    return gap ? 'gap' : 'ok';
  }

  /**
   * Puts back a batch whose tick failed, so the next tick runs it again.
   * Skips the typeSeq check: these events were already counted.
   */
  requeue(batch: ChangeBatch): void {
    for (const evt of batch.events) {
      this.keep(evt);
    }
    for (const type of batch.gapTypes) {
      this.gapTypes.add(type);
    }
  }

  /** Returns the batch and starts a new one. */
  drain(): ChangeBatch {
    const batch = {
      events: [...this.pending.values()],
      gapTypes: [...this.gapTypes],
    };
    this.pending = new Map();
    this.gapTypes = new Set();
    return batch;
  }

  /**
   * Forgets a type nobody reads any more: its pending events and its last
   * typeSeq, so reading it again later doesn't count the skipped events as a gap.
   */
  forget(type: string): void {
    this.lastTypeSeq.delete(type);
    this.gapTypes.delete(type);
    for (const [key, evt] of this.pending) {
      if (evt.type === type) {
        this.pending.delete(key);
      }
    }
  }

  /** The pending events, without draining them (for debugging). */
  peek(): ChangeEvent[] {
    return [...this.pending.values()];
  }

  /** The last typeSeq seen per type. */
  sequences(): Record<string, number> {
    return Object.fromEntries(this.lastTypeSeq);
  }

  /** Adds the event to the pending one of the same entity, in version order. */
  private keep(evt: ChangeEvent): void {
    const key = `${evt.type}:${evt.id}`;
    const existing = this.pending.get(key);
    if (!existing) {
      this.pending.set(key, evt);
    } else if (evt.version > existing.version) {
      this.pending.set(key, merge(existing, evt));
    } else if (evt.version < existing.version) {
      this.pending.set(key, merge(evt, existing));
    }
  }
}

/**
 * The newer event, carrying the changed fields of both, so the dependency
 * index still sees a field that only the older event changed.
 * A delete wins; an insert stays an insert.
 */
function merge(older: ChangeEvent, newer: ChangeEvent): ChangeEvent {
  if (newer.op === 'delete' || older.op === 'delete') {
    return { ...newer, op: 'delete', changes: undefined };
  }
  const a = older.changes!;
  const b = newer.changes!;
  const olderIsInsert =
    Object.keys(a.old).length === 0 && Object.keys(a.new).length > 0;
  return {
    ...newer,
    changes: {
      old: olderIsInsert ? {} : { ...b.old, ...a.old },
      new: { ...a.new, ...b.new },
    },
  };
}
