// Copies the map libraries' static files into apps/client/.map-assets (git-ignored), which
// angular.json serves as /cesium/ and /maplibre/. The Angular builder only takes asset paths inside
// the app folder, and npm hoists these packages to the repo root. Runs before build and start.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const out = join(import.meta.dirname, '..', '.map-assets');
const cesium = join(dirname(require.resolve('cesium/package.json')), 'Build', 'Cesium');
const maplibre = join(dirname(require.resolve('maplibre-gl/package.json')), 'dist');

rmSync(out, { recursive: true, force: true });
for (const dir of ['Assets', 'ThirdParty', 'Workers', 'Widgets'])
  cpSync(join(cesium, dir), join(out, 'cesium', dir), { recursive: true });
mkdirSync(join(out, 'maplibre'), { recursive: true });
cpSync(join(maplibre, 'maplibre-gl.css'), join(out, 'maplibre', 'maplibre-gl.css'));
