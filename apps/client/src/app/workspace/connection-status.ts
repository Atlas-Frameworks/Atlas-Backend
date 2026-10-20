import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** The SDK's `ConnectionState`. */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export type StatusTone = 'live' | 'warn' | 'stale' | 'off';

export interface StatusView {
  text: string;
  tone: StatusTone;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** HH:MM:SS in local time. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const NOT_OPEN: Record<Exclude<ConnectionState, 'open'>, StatusView> = {
  reconnecting: { text: 'Reconnecting…', tone: 'warn' },
  connecting: { text: 'Connecting…', tone: 'warn' },
  closed: { text: 'Disconnected', tone: 'off' },
  idle: { text: 'Not connected', tone: 'off' },
};

/**
 * Top-bar wording. A broken connection wins over stale data (it is the cause); with the connection
 * open, any subscription waiting for a resync makes the whole view "Stale since …".
 */
export function describeStatus(connection: ConnectionState, staleSince: number | null): StatusView {
  if (connection !== 'open') return NOT_OPEN[connection];
  return staleSince === null
    ? { text: 'Live', tone: 'live' }
    : { text: `Stale since ${clockTime(staleSince)}`, tone: 'stale' };
}

@Component({
  selector: 'app-connection-status',
  template: `<span class="dot" aria-hidden="true"></span>{{ view().text }}`,
  styles: `
    :host {
      display: inline-flex;
      gap: var(--atlas-space-2);
      align-items: center;
      padding: var(--atlas-space-1) var(--atlas-space-3);
      border-radius: 999px;
      background: var(--atlas-surface-sunken);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: var(--tone);
    }
    :host([data-tone='live']) {
      --tone: var(--atlas-ok);
    }
    :host([data-tone='warn']) {
      --tone: var(--atlas-warn);
    }
    :host([data-tone='stale']) {
      --tone: var(--atlas-stale);
    }
    :host([data-tone='off']) {
      --tone: var(--atlas-text-muted);
    }
  `,
  host: { role: 'status', '[attr.data-tone]': 'view().tone' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConnectionStatus {
  readonly connection = input.required<ConnectionState>();
  readonly staleSince = input<number | null>(null);

  protected readonly view = computed(() => describeStatus(this.connection(), this.staleSince()));
}
