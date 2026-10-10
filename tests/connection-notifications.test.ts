import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionNotifications } from '../src/connection-notifications';
import { Store, type Notification } from '../src/database';
import type { Connection, ConnectionState } from '../src/rust/connection';
import type { Alerts } from '../src/discord/alerts';

class Transport extends EventEmitter {
  state: ConnectionState = 'connecting';
  unavailableDevices: { name: string }[] = [];
  get online() {
    return this.state === 'connected';
  }
  status(state: ConnectionState) {
    this.state = state;
    this.emit('status', state);
  }
  ready() {
    this.status('connected');
    this.emit('ready');
  }
}
let store: Store;
let rust: Transport;
let tracker: ConnectionNotifications;
let notify: ReturnType<typeof vi.fn>;
function start() {
  notify = vi.fn((n: Notification) => store.enqueueNotification(n));
  tracker = new ConnectionNotifications(rust as unknown as Connection, store, {
    notify,
  } as unknown as Alerts);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T00:00:00Z'));
  store = new Store(':memory:');
  rust = new Transport();
  start();
});
afterEach(() => {
  tracker.stop();
  store.close();
  vi.useRealTimers();
});

describe('connection outage notifications', () => {
  it('does not invent an outage on initial startup, including invalid initial credentials', async () => {
    rust.status('invalid-credentials');
    await vi.advanceTimersByTimeAsync(120000);
    expect(notify).not.toHaveBeenCalled();
    rust.ready();
    expect(tracker.lastSuccessfulAt).toBe(Date.now());
    expect(notify).not.toHaveBeenCalled();
  });
  it('ignores a brief outage and waits for initialized ready, not just a connected status', async () => {
    rust.ready();
    rust.status('reconnecting');
    await vi.advanceTimersByTimeAsync(59000);
    rust.status('synchronizing');
    rust.ready();
    await vi.advanceTimersByTimeAsync(1000);
    expect(notify).not.toHaveBeenCalled();
  });
  it('sends one lost and one recovery notice after the threshold, with downtime', async () => {
    rust.ready();
    rust.status('reconnecting');
    await vi.advanceTimersByTimeAsync(59999);
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(notify).toHaveBeenCalledTimes(1);
    rust.status('connecting');
    rust.status('synchronizing');
    await vi.advanceTimersByTimeAsync(60000);
    expect(notify).toHaveBeenCalledTimes(1);
    rust.status('connected');
    expect(notify).toHaveBeenCalledTimes(1);
    rust.emit('ready');
    rust.emit('ready');
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0].description).toContain('120 seconds');
    expect(store.get('connectionOutage', 'missing')).toBeNull();
  });
  it('reports degraded device initialization without claiming operational monitoring', async () => {
    rust.ready();
    rust.status('reconnecting');
    await vi.advanceTimersByTimeAsync(60000);
    rust.unavailableDevices = [{ name: 'Outer Wall' }];
    rust.ready();
    const recovery = notify.mock.calls[1][0] as Notification;
    expect(recovery.title).toContain('Degraded');
    expect(recovery.description).toContain('Outer Wall');
    expect(recovery.description).not.toContain('operational again');
  });
  it('resumes a known outage across restart and preserves lost-before-restored delivery order', async () => {
    rust.ready();
    rust.status('reconnecting');
    await vi.advanceTimersByTimeAsync(60000);
    const loss = store.notificationJobs()[0];
    store.retryNotification(loss.id, 1);
    tracker.stop();
    start();
    rust.ready();
    expect(notify).toHaveBeenCalledOnce();
    expect(store.notificationJobs()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(store.notificationJobs().map((n) => n.kind)).toEqual(['connection-lost']);
    store.acknowledgeNotification(loss.id);
    expect(store.notificationJobs().map((n) => n.kind)).toEqual(['connection-restored']);
  });
  it('stops timers/listeners on shutdown without creating an outage', async () => {
    rust.ready();
    tracker.stop();
    rust.status('stopped');
    await vi.advanceTimersByTimeAsync(120000);
    expect(notify).not.toHaveBeenCalled();
    expect(rust.listenerCount('ready')).toBe(0);
  });
  it('explains the recovery strategy for rejected credentials', async () => {
    rust.ready();
    rust.status('invalid-credentials');
    await vi.advanceTimersByTimeAsync(60000);
    expect(notify.mock.calls[0][0].description).toContain('automatic retries are paused');
  });
  it('isolates notification failures and retries without disrupting ready listeners', async () => {
    rust.ready();
    rust.status('reconnecting');
    await vi.advanceTimersByTimeAsync(60000);
    notify.mockImplementationOnce(() => {
      throw new Error('temporary outbox failure');
    });
    const ready = vi.fn();
    rust.on('ready', ready);
    rust.ready();
    expect(ready).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10000);
    expect(store.notificationJobs()).toHaveLength(1);
    const loss = store.notificationJobs()[0];
    store.acknowledgeNotification(loss.id);
    expect(store.notificationJobs()[0].kind).toBe('connection-restored');
  });
});
