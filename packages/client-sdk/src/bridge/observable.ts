/**
 * A minimal observable value: `subscribe` plus `getSnapshot`, the shape React's
 * `useSyncExternalStore` takes and that Angular signals or RxJS wrap in a few lines.
 */
export interface Observable<T> {
  /** Calls `listener` on every change; returns an unsubscribe function. */
  subscribe(listener: (value: T) => void): () => void;
  /** The current value (stable identity until it changes). */
  getSnapshot(): T;
}

export class Store<T> implements Observable<T> {
  private readonly listeners = new Set<(value: T) => void>();

  constructor(private value: T) {}

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): T {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    for (const l of this.listeners) l(value);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
