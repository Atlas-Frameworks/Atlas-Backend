/** Public request and status types of the SDK core. */

/** The filter tree of contracts §5, or its JSON text. `null` = no filter. */
export type FilterInput = Record<string, unknown> | string | null;

export type ViewScope = { countries: string[] } | { connectionId: string };

export interface ViewSpec {
  entityType: string;
  filter?: FilterInput;
  scope: ViewScope;
}

export interface Layout {
  groupBy: string[];
  sort?: { field: string; dir: 'asc' | 'desc' };
}

export interface WindowSpec {
  /** Group values from the outermost group; `[]` = the whole list. */
  groupPath: string[];
  /** 0-based. */
  page: number;
  pageSize: number;
}

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ErrorInfo {
  /** Protocol code name: `INVALID_FILTER`, `LIMIT`, `AUTH`, `RETRY`, or `TRANSPORT`. */
  code: string;
  message: string;
  at: number;
  url?: string;
  viewRef?: string;
  subId?: string;
}

export interface SessionStatus {
  url: string;
  state: ConnectionState;
  /** Reconnect attempts since the last stable connection. */
  attempt: number;
  /** When the next connect attempt is due, while reconnecting. */
  nextRetryAt: number | null;
  lastError: ErrorInfo | null;
}

export interface SubscriptionStatus {
  key: string;
  kind: 'map' | 'page' | 'detail';
  state: 'pending' | 'snapshot-wait' | 'live' | 'stale' | 'resyncing';
  staleSince: number | null;
}

export interface AtlasStatus {
  /** The worst state across services: `reconnecting` beats `connecting` beats `open`. */
  connection: ConnectionState;
  connections: SessionStatus[];
  subscriptions: SubscriptionStatus[];
  /** Earliest `staleSince` of any subscription, or `null` when everything is in sync. */
  staleSince: number | null;
  lastError: ErrorInfo | null;
  /** True while the page is hidden and frames are paused. */
  hidden: boolean;
}

export interface LocateAnswer {
  found: boolean;
  groupPath: string[];
  page: number;
}
