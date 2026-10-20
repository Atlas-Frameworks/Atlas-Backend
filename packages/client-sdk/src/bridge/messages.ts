import type { AtlasStatus, ErrorInfo, Layout, LocateAnswer, ViewSpec } from '../core/types.js';
import type { FrameBuffers, WireMapFrame } from '../map-store/frame.js';
import type { Camera } from '../map-store/label-selector.js';
import type { DetailState } from '../pages/detail-subscription.js';
import type { PageOptions, PageState } from '../pages/page-subscription.js';

/** SDK options that cross into the Worker (no functions: they must be structured-cloneable). */
export interface WorkerConfig {
  /** Entity type → view-service WebSocket URL (`'*'` = any type). */
  services: Record<string, string>;
  token?: string;
  /** Map frames per second per layer (default 10). */
  maxFps?: number;
  /** Labels per frame (default 500). */
  maxLabels?: number;
  /** Page, detail and status updates per second (default 4). */
  updatesPerSecond?: number;
  backoff?: { baseMs?: number; maxMs?: number };
}

/** Control calls, main → worker. Handles (`viewId`, `pageId`, ...) are chosen by the main side. */
export type Command =
  | { op: 'configure'; config: WorkerConfig }
  | { op: 'setToken'; token: string }
  | { op: 'openView'; viewId: string; spec: ViewSpec }
  | { op: 'closeView'; viewId: string }
  | { op: 'setLayout'; viewId: string; layout: Layout }
  | { op: 'subscribeMap'; viewId: string; layerId: string }
  | { op: 'unsubscribeMap'; viewId: string }
  | { op: 'subscribePage'; viewId: string; pageId: string; options: PageOptions }
  | { op: 'setPage'; pageId: string; page: number }
  | { op: 'setGroupPath'; pageId: string; groupPath: string[] }
  | { op: 'setFreezeOrder'; pageId: string; frozen: boolean }
  | { op: 'closePage'; pageId: string }
  | { op: 'openDetail'; detailId: string; entityType: string; id: string }
  | { op: 'closeDetail'; detailId: string }
  | { op: 'setCamera'; camera: Camera | null }
  | { op: 'setSelected'; id: string | null }
  | { op: 'setHidden'; hidden: boolean }
  | { op: 'resetLayer'; layerId: string }
  | { op: 'destroy' };

/** Calls that answer, main → worker. */
export type Query =
  | { op: 'locate'; viewId: string; id: string; pageSize?: number }
  | { op: 'locatePage'; pageId: string; id: string; jump: boolean };

export type ToWorker =
  | { kind: 'command'; command: Command }
  | { kind: 'query'; callId: number; query: Query }
  | { kind: 'release'; layerId: string; buffers: FrameBuffers };

/** One coalesced state update (the latest per key wins within a batch). */
export type Update =
  | { kind: 'page'; pageId: string; state: PageState }
  | { kind: 'detail'; detailId: string; state: DetailState }
  | { kind: 'status'; status: AtlasStatus }
  | { kind: 'viewError'; viewId: string; error: ErrorInfo };

export type FromWorker =
  | { kind: 'frame'; frame: WireMapFrame }
  | { kind: 'updates'; updates: Update[] }
  | { kind: 'answer'; callId: number; ok: true; value: LocateAnswer }
  | { kind: 'answer'; callId: number; ok: false; error: string };
