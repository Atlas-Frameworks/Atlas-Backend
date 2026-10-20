/**
 * @atlas/client-sdk
 *
 * Must not import Angular, React, Cesium, deck.gl or MapLibre.
 * Modules (see docs/tasks/boaz/06-client-sdk.md):
 *
 * - core/       C-01  transport per service, protocol, seq checks, resync, reconnect, hidden-tab handling
 * - map-store/  C-02  typed arrays per subscription, slot table, frame scheduling and buffer rotation
 * - pages/      C-03  page windows, detail subscriptions, locate(id)
 * - bridge/     C-04  worker <-> main thread API (control calls + transferred frames)
 * - adapters/   C-05  MapAdapter interface (Cesium / deck.gl implementations live in separate packages)
 */
export * from './core/index.js';
export * from './map-store/index.js';
export * from './adapters/index.js';
export * from './pages/index.js';
export * from './bridge/index.js';
