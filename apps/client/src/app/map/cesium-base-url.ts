// Cesium loads its workers, sky box and other static files from `CESIUM_BASE_URL` (copied to
// `cesium/` by the assets config in angular.json). It must be set before the `cesium` module
// runs, so cesium-engine.ts imports this file first.
Object.assign(globalThis, { CESIUM_BASE_URL: new URL('cesium/', document.baseURI).href });
