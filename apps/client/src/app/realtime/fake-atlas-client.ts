import { Store } from '@atlas/client-sdk';
import type {
  AtlasClient,
  AtlasClientConfig,
  AtlasStatus,
  DetailHandle,
  DetailState,
  ErrorInfo,
  FrameListener,
  MapFrame,
  PageHandle,
  PageOptions,
  PageState,
  ViewHandle,
  ViewSpec,
} from '@atlas/client-sdk';

export const IDLE: AtlasStatus = {
  connection: 'idle',
  connections: [],
  subscriptions: [],
  staleSince: null,
  lastError: null,
  hidden: false,
};

export interface FakePage {
  options: PageOptions | undefined;
  store: Store<PageState | null>;
  closed: boolean;
}

export interface FakeView {
  spec: ViewSpec;
  error: Store<ErrorInfo | null>;
  pages: FakePage[];
  closed: boolean;
}

export interface FakeDetail {
  entityType: string;
  id: string;
  store: Store<DetailState | null>;
  closed: boolean;
}

/** In-memory stand-in for the SDK client (tests only): records calls, lets tests push updates. */
export class FakeAtlasClient implements AtlasClient {
  readonly status = new Store<AtlasStatus>(IDLE);
  readonly views: FakeView[] = [];
  readonly details: FakeDetail[] = [];
  readonly frameListeners = new Set<FrameListener>();
  readonly tokens: string[] = [];
  destroyed = false;

  constructor(readonly config: AtlasClientConfig) {}

  setToken(token: string): void {
    this.tokens.push(token);
  }

  openView(spec: ViewSpec): ViewHandle {
    const view: FakeView = {
      spec,
      error: new Store<ErrorInfo | null>(null),
      pages: [],
      closed: false,
    };
    this.views.push(view);
    return {
      id: `v${this.views.length}`,
      spec,
      error: view.error,
      setLayout: () => undefined,
      subscribeMap: (layerId = 'layer') => ({ layerId, close: () => undefined }),
      subscribePage: (options) => {
        const page: FakePage = { options, store: new Store<PageState | null>(null), closed: false };
        view.pages.push(page);
        return fakePageHandle(page);
      },
      locate: () => Promise.resolve({ found: false, groupPath: [], page: 0 }),
      close: () => {
        view.closed = true;
      },
    };
  }

  openDetail(entityType: string, id: string): DetailHandle {
    const detail: FakeDetail = {
      entityType,
      id,
      store: new Store<DetailState | null>(null),
      closed: false,
    };
    this.details.push(detail);
    return {
      entityType,
      id,
      subscribe: (l) => detail.store.subscribe(l),
      getSnapshot: () => detail.store.getSnapshot(),
      close: () => {
        detail.closed = true;
      },
    };
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  attachMap(adapter: { applyFrame(frame: MapFrame): void }): () => void {
    return this.onFrame((frame) => adapter.applyFrame(frame));
  }

  /** What the real client does when the Worker posts a frame: call every listener synchronously. */
  emitFrame(frame: MapFrame): void {
    for (const l of this.frameListeners) l(frame);
  }

  setCamera(): void {}
  setSelected(): void {}
  setHidden(): void {}

  destroy(): void {
    this.destroyed = true;
  }
}

function fakePageHandle(page: FakePage): PageHandle {
  return {
    id: 'p',
    subscribe: (l) => page.store.subscribe(l),
    getSnapshot: () => page.store.getSnapshot(),
    setPage: () => undefined,
    setGroupPath: () => undefined,
    setFreezeOrder: () => undefined,
    locate: () => Promise.resolve({ found: false, groupPath: [], page: 0 }),
    close: () => {
      page.closed = true;
    },
  };
}

export function pageState(patch: Partial<PageState> = {}): PageState {
  return {
    rows: [],
    total: 0,
    pageCount: 0,
    page: 0,
    pageSize: 50,
    groupPath: [],
    groupCounts: [],
    loading: false,
    stale: false,
    staleSince: null,
    frozen: false,
    pendingReorder: 0,
    ...patch,
  };
}

export function mapFrame(count: number): MapFrame {
  return {
    layerId: 'layer',
    count,
    ids: Array.from({ length: count }, (_, i) => `e${i}`),
    positions: new Float64Array(count * 3),
    icons: new Uint16Array(count),
    visible: new Uint8Array(count).fill(1),
    labels: new Map(),
  };
}
