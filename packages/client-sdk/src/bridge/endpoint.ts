/**
 * The two ends of the main ↔ worker channel. A dedicated `Worker` and the worker's `self` both
 * fit this shape; {@link inProcessChannel} links two ends in one thread (the fallback for
 * environments without Workers, and tests).
 */
export interface Endpoint<In, Out> {
  postMessage(message: Out, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: { data: In }) => void): void;
}

/** Two linked ends in one thread. Messages are delivered on a microtask, never re-entrantly. */
export function inProcessChannel<A, B>(): { a: Endpoint<B, A>; b: Endpoint<A, B> } {
  const toA: ((ev: { data: B }) => void)[] = [];
  const toB: ((ev: { data: A }) => void)[] = [];
  return {
    a: {
      postMessage: (message) => queueMicrotask(() => toB.forEach((l) => l({ data: message }))),
      addEventListener: (_t, l) => toA.push(l),
    },
    b: {
      postMessage: (message) => queueMicrotask(() => toA.forEach((l) => l({ data: message }))),
      addEventListener: (_t, l) => toB.push(l),
    },
  };
}
