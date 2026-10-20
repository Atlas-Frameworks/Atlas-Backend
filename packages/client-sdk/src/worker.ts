/**
 * Worker entry point: runs the SDK core in a dedicated Web Worker.
 *
 * In an app, add a one-line worker file and pass it to `createAtlasClient`:
 *
 * ```ts
 * // sdk.worker.ts
 * import '@atlas/client-sdk/worker';
 * // app
 * createAtlasClient({ services, worker: () => new Worker(new URL('./sdk.worker', import.meta.url), { type: 'module' }) });
 * ```
 */
import type { Endpoint } from './bridge/endpoint.js';
import type { FromWorker, ToWorker } from './bridge/messages.js';
import { WorkerHost } from './bridge/worker-host.js';

const scope: Endpoint<ToWorker, FromWorker> = {
  postMessage: (message, transfer) => globalThis.postMessage(message, { transfer: transfer ?? [] }),
  addEventListener: (_type, listener) =>
    globalThis.addEventListener('message', (ev: MessageEvent<ToWorker>) =>
      listener({ data: ev.data }),
    ),
};

/** The SDK instance of this Worker. */
export const host = new WorkerHost(scope);
