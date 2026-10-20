import { TestBed } from '@angular/core/testing';
import { ConnectionStatus, clockTime, describeStatus } from './connection-status';

describe('describeStatus', () => {
  const at = new Date(2026, 0, 1, 12, 3, 5).getTime();

  it('formats the top-bar states', () => {
    expect(describeStatus('open', null)).toEqual({ text: 'Live', tone: 'live' });
    expect(describeStatus('reconnecting', null).text).toBe('Reconnecting…');
    expect(describeStatus('open', at)).toEqual({ text: 'Stale since 12:03:05', tone: 'stale' });
    expect(describeStatus('connecting', null).text).toBe('Connecting…');
    expect(describeStatus('idle', null).text).toBe('Not connected');
  });

  it('prefers the connection problem over stale data', () => {
    expect(describeStatus('reconnecting', at).text).toBe('Reconnecting…');
  });

  it('pads the clock', () => {
    expect(clockTime(new Date(2026, 0, 1, 1, 2, 3).getTime())).toBe('01:02:03');
  });
});

describe('ConnectionStatus', () => {
  it('renders text and tone from its inputs', async () => {
    const fixture = TestBed.createComponent(ConnectionStatus);
    fixture.componentRef.setInput('connection', 'open');
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent?.trim()).toBe('Live');
    expect(el.dataset['tone']).toBe('live');
    fixture.componentRef.setInput('connection', 'reconnecting');
    await fixture.whenStable();
    expect(el.textContent?.trim()).toBe('Reconnecting…');
    expect(el.dataset['tone']).toBe('warn');
  });
});
