// Local type for the outbox event payload in contracts §1
// (packages/protocol/schema/outbox-event.v2.json). Step 6 reads these from Redis.

export interface ChangeEvent {
  schema: 2;
  /** Entity type, e.g. "items". */
  type: string;
  id: string;
  op: 'upsert' | 'delete';
  version: number;
  /** Gapless per-type sequence; a gap means a lost event. */
  typeSeq: number;
  committedAt: string;
  /**
   * Upsert only. Insert: `new` has every business field, `old` is empty.
   * Update: only the fields whose values differ. No-op update: both empty.
   */
  changes?: {
    old: Record<string, unknown>;
    new: Record<string, unknown>;
  };
}
