import type { PageState } from '@atlas/client-sdk';

/** How long after the last scroll event the list counts as idle. */
export const SCROLL_IDLE_MS = 1_500;

/** Browser timer ids (`window.setTimeout`), not Node's `Timeout`, even when Node types are loaded. */
type TimerHandle = number;

export interface FreezeTimers {
  set(fn: () => void, ms: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

const browserTimers: FreezeTimers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (h) => window.clearTimeout(h),
};

/**
 * Keeps a live page's order still while the user is on it: the pointer is over the list, or it
 * scrolled less than `idleMs` ago. Calls `setFrozen` only when that changes, so the SDK sees one
 * `setFreezeOrder(true)` on enter and one `false` on leave/idle.
 */
export class FreezeOrder {
  private hovering = false;
  private scrolling = false;
  private idle: TimerHandle | null = null;
  private frozen = false;

  constructor(
    private readonly setFrozen: (frozen: boolean) => void,
    private readonly idleMs = SCROLL_IDLE_MS,
    private readonly timers: FreezeTimers = browserTimers,
  ) {}

  get isFrozen(): boolean {
    return this.frozen;
  }

  pointerEnter(): void {
    this.hovering = true;
    this.update();
  }

  pointerLeave(): void {
    this.hovering = false;
    this.update();
  }

  scrolled(): void {
    this.scrolling = true;
    if (this.idle !== null) this.timers.clear(this.idle);
    this.idle = this.timers.set(() => {
      this.idle = null;
      this.scrolling = false;
      this.update();
    }, this.idleMs);
    this.update();
  }

  /**
   * The banner's "refresh order": applies the latest server order now. If the user is still on
   * the list, the new order is frozen again at once (the SDK handles false-then-true in order).
   */
  refresh(): void {
    if (!this.frozen) return;
    this.setFrozen(false);
    this.setFrozen(true);
  }

  /** Re-sends the current state, e.g. to a page subscription that replaced the previous one. */
  resend(): void {
    if (this.frozen) this.setFrozen(true);
  }

  dispose(): void {
    if (this.idle !== null) this.timers.clear(this.idle);
    this.idle = null;
    this.hovering = false;
    this.scrolling = false;
    this.update();
  }

  private update(): void {
    const frozen = this.hovering || this.scrolling;
    if (frozen === this.frozen) return;
    this.frozen = frozen;
    this.setFrozen(frozen);
  }
}

/** The "N changed — refresh order" banner text, or null when there is nothing to refresh. */
export function reorderBanner(state: PageState | null): string | null {
  if (!state?.frozen || state.pendingReorder <= 0) return null;
  return `${state.pendingReorder} changed — refresh order`;
}
