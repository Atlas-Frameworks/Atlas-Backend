import { pageState } from '../realtime/fake-atlas-client';
import { FreezeOrder, reorderBanner } from './freeze-order';
import type { FreezeTimers } from './freeze-order';

/** Manual timers: `tick()` runs whatever is due. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers = {
    set: (fn: () => void, ms: number) => {
      due.set(next, { at: now + ms, fn });
      return next++;
    },
    clear: (h: number) => due.delete(h),
  } satisfies FreezeTimers;
  const tick = (ms: number) => {
    now += ms;
    for (const [id, t] of due) {
      if (t.at <= now) {
        due.delete(id);
        t.fn();
      }
    }
  };
  return { timers, tick, pending: () => due.size };
}

function setup() {
  const calls: boolean[] = [];
  const t = fakeTimers();
  const freeze = new FreezeOrder((f) => calls.push(f), 1_000, t.timers);
  return { calls, freeze, ...t };
}

describe('FreezeOrder', () => {
  it('freezes once on enter and thaws once on leave', () => {
    const { calls, freeze } = setup();
    freeze.pointerEnter();
    freeze.pointerEnter();
    expect(calls).toEqual([true]);
    expect(freeze.isFrozen).toBe(true);
    freeze.pointerLeave();
    expect(calls).toEqual([true, false]);
  });

  it('stays frozen while scrolling and thaws when scrolling goes idle', () => {
    const { calls, freeze, tick } = setup();
    freeze.scrolled();
    tick(600);
    freeze.scrolled();
    tick(600);
    expect(calls).toEqual([true]);
    tick(400);
    expect(calls).toEqual([true, false]);
  });

  it('does not thaw on idle scroll while the pointer is still over the list', () => {
    const { calls, freeze, tick } = setup();
    freeze.pointerEnter();
    freeze.scrolled();
    tick(5_000);
    expect(calls).toEqual([true]);
    freeze.pointerLeave();
    expect(calls).toEqual([true, false]);
  });

  it('keeps the order frozen after leaving if a scroll is still settling', () => {
    const { calls, freeze, tick } = setup();
    freeze.pointerEnter();
    freeze.scrolled();
    freeze.pointerLeave();
    expect(calls).toEqual([true]);
    tick(1_000);
    expect(calls).toEqual([true, false]);
  });

  it('refresh applies the latest order and refreezes; nothing when not frozen', () => {
    const { calls, freeze } = setup();
    freeze.refresh();
    expect(calls).toEqual([]);
    freeze.pointerEnter();
    freeze.refresh();
    expect(calls).toEqual([true, false, true]);
    expect(freeze.isFrozen).toBe(true);
  });

  it('resend repeats the frozen state for a new page subscription', () => {
    const { calls, freeze } = setup();
    freeze.resend();
    freeze.pointerEnter();
    freeze.resend();
    expect(calls).toEqual([true, true]);
  });

  it('dispose thaws and cancels the idle timer', () => {
    const { calls, freeze, pending } = setup();
    freeze.pointerEnter();
    freeze.scrolled();
    freeze.dispose();
    expect(calls).toEqual([true, false]);
    expect(pending()).toBe(0);
  });
});

describe('reorderBanner', () => {
  it('shows N pending changes only while frozen', () => {
    expect(reorderBanner(null)).toBeNull();
    expect(reorderBanner(pageState({ frozen: true, pendingReorder: 0 }))).toBeNull();
    expect(reorderBanner(pageState({ frozen: false, pendingReorder: 4 }))).toBeNull();
    expect(reorderBanner(pageState({ frozen: true, pendingReorder: 4 }))).toBe(
      '4 changed — refresh order',
    );
  });
});
