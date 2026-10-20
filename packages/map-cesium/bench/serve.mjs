// Serves bench/ on http://127.0.0.1:5181, and Cesium's static assets (workers, sky box, CSS) under
// /cesium/ straight from node_modules/cesium/Build/Cesium. Static files only.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(import.meta.dirname);
const cesiumRoot = join(
  dirname(fileURLToPath(import.meta.resolve('cesium/package.json'))),
  'Build',
  'Cesium',
);
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};
const port = Number(process.env.PORT ?? 5181);

createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
  const [base, rel] = path.startsWith('/cesium/')
    ? [cesiumRoot, path.slice('/cesium/'.length)]
    : [root, path === '/' ? 'index.html' : path];
  const file = join(base, rel);
  if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`bench on http://127.0.0.1:${port}/`));
