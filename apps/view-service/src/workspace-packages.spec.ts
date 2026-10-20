// Smoke test for F-01: apps consume workspace packages through `@atlas/*` references.
// Vitest resolves them to their TypeScript sources (the "@atlas/source" export condition).
import * as viewEngine from '@atlas/view-engine';
import { PROTOCOL_VERSION } from '@atlas/protocol';

describe('workspace packages', () => {
  it('imports @atlas/view-engine and @atlas/protocol', () => {
    expect(viewEngine).toBeTypeOf('object');
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
