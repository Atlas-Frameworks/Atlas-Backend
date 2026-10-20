// CSP and bundle-boundary check for the browser entry point (P-01 acceptance):
// bundle `@atlas/protocol` the way a browser app would (esbuild, platform
// browser, minified) and check it never evaluates strings as code, and never
// pulls in the cluster schema or Node-only modules.
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

async function bundle(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    logLevel: 'silent',
  });
  const out = result.outputFiles[0];
  if (!out) throw new Error('esbuild produced no output');
  return out.text;
}

// protobuf-es embeds each file descriptor as base64; this is the stable prefix of the cluster
// file's descriptor (field 1 = its name), so it identifies the cluster schema in a minified bundle.
const CLUSTER_DESCRIPTOR = Buffer.from('\n!atlas/cluster/v1/view_owner.proto')
  .subarray(0, 33)
  .toString('base64');

const CODE_FROM_STRING = [
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /\bFunction\s*\(\s*["'`]/,
  /setTimeout\s*\(\s*["'`]/,
];

describe('browser bundle of @atlas/protocol', () => {
  it('works under a strict CSP: no eval / new Function', async () => {
    const code = await bundle('./index.ts');
    for (const pattern of CODE_FROM_STRING) {
      expect(code, `browser bundle matches ${pattern}`).not.toMatch(pattern);
    }
    console.info(
      `[bundle] @atlas/protocol browser entry: ${(code.length / 1024).toFixed(1)} KiB minified`,
    );
  });

  it('does not include the cluster schema or Node modules', async () => {
    const code = await bundle('./index.ts');
    expect(code).not.toContain(CLUSTER_DESCRIPTOR);
    expect(code).not.toMatch(/from\s*["']node:/);
    expect(code).not.toContain('@connectrpc');
  });

  it('the cluster entry is CSP-safe too and contains the ViewOwner service', async () => {
    const code = await bundle('./cluster.ts');
    expect(code).toContain(CLUSTER_DESCRIPTOR);
    for (const pattern of CODE_FROM_STRING) expect(code).not.toMatch(pattern);
  });
});
