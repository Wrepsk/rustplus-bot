import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { Store } from '../src/database';
import { Devices } from '../src/devices';
import { Alerts } from '../src/discord/alerts';
import type { Connection } from '../src/rust/connection';
import type { Config } from '../src/config';

let store: Store;
let rust: EventEmitter & { online: boolean };
let devices: Devices;
let alerts: Alerts;
let ready: boolean;
let send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  store = new Store(':memory:');
  store.add({ id: '42', name: 'Outer Wall', type: 'alarm' });
  rust = Object.assign(new EventEmitter(), { online: true });
  devices = new Devices(store, rust as unknown as Connection, 60);
  send = vi.fn(async () => ({}));
  ready = true;
  const client = {
    isReady: () => ready,
    channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) },
  } as unknown as Client;
  alerts = new Alerts(client, store, {
    ALERT_CHANNEL_ID: 'channel',
    ALERT_ROLE_ID: 'raid-role',
    BASE_NAME: 'Main Base',
  } as Config);
  devices.on('alarmActive', (d) => alerts.recoveredAlarm(d));
  devices.on('alarm', (d) => alerts.enqueue(d));
  alerts.start();
});
afterEach(async () => {
  await alerts.stop();
  store.close();
  vi.useRealTimers();
});
function reconnect(active: boolean) {
  rust.online = false;
  rust.emit('status');
  rust.online = true;
  rust.emit('device', '42', active, true);
}
const titles = () => send.mock.calls.map((call) => call[0].embeds[0].toJSON().title as string);

describe('recovery warnings and persistent delivery', () => {
  it('delivers player events from two servers into the same alerts channel with distinct server labels and no pings', async () => {
    const secondStore = new Store(':memory:');
    const secondAlerts = new Alerts(
      {
        isReady: () => ready,
        channels: { fetch: async () => ({ isTextBased: () => true, send }) },
      } as unknown as Client,
      secondStore,
      {
        ALERT_CHANNEL_ID: 'channel',
        ALERT_ROLE_ID: 'raid-role',
        BASE_NAME: 'Second Server',
      } as Config,
    );
    try {
      ready = false;
      secondAlerts.start();
      alerts.notify({
        id: 'online-1',
        family: 'player:first',
        kind: 'player-online',
        title: '🟢 Player Online',
        description: '@everyone is online',
        at: Date.now(),
      });
      secondAlerts.notify({
        id: 'death-1',
        family: 'player:second',
        kind: 'player-death',
        title: '☠️ Rust+ Death Notification',
        description: '@here died',
        at: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(10000);
      expect(send).not.toHaveBeenCalled();
      ready = true;
      await vi.advanceTimersByTimeAsync(10000);
      expect(send).toHaveBeenCalledTimes(2);
      expect(
        send.mock.calls.map(([payload]) => payload.embeds[0].toJSON().footer?.text).sort(),
      ).toEqual(['Main Base', 'Second Server']);
      for (const [payload] of send.mock.calls)
        expect(payload.allowedMentions).toEqual({ parse: [] });
      expect(store.notificationJobs()).toHaveLength(0);
      expect(secondStore.notificationJobs()).toHaveLength(0);
    } finally {
      await secondAlerts.stop();
      secondStore.close();
    }
  });
  it('warns on an active startup baseline without inventing a new raid or pinging roles', async () => {
    rust.emit('device', '42', true, true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(titles()).toEqual(['⚠️ Alarm Active After Reconnection']);
    expect(send.mock.calls[0][0].embeds[0].toJSON().description).toContain(
      'cannot determine when it activated',
    );
    expect(send.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
    expect(store.lastAlert('42')).toBe(0);
  });
  it('suppresses repeated active recovery snapshots until an inactive state is observed', async () => {
    reconnect(true);
    await vi.advanceTimersByTimeAsync(10000);
    reconnect(true);
    reconnect(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledOnce();
    rust.emit('device', '42', false, false);
    reconnect(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(titles()).toEqual([
      '⚠️ Alarm Active After Reconnection',
      '⚠️ Alarm Active After Reconnection',
    ]);
  });
  it('preserves live inactive-to-active detection, duplicate suppression and cooldown across reconnect', async () => {
    rust.emit('device', '42', false, true);
    rust.emit('device', '42', true, false);
    rust.emit('device', '42', true, false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(titles()).toEqual(['🚨 RAID ALERT!']);
    reconnect(false);
    rust.emit('device', '42', true, false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);
    rust.emit('device', '42', false, false);
    rust.emit('device', '42', true, false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(titles()).toEqual(['🚨 RAID ALERT!', '🚨 RAID ALERT!']);
  });
  it('queues warnings while Discord is down and delivers once after readiness resumes', async () => {
    ready = false;
    reconnect(true);
    reconnect(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(send).not.toHaveBeenCalled();
    expect(store.notificationJobs()).toHaveLength(1);
    ready = true;
    alerts.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledOnce();
    expect(store.notificationJobs()).toHaveLength(0);
    alerts.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledOnce();
  });
  it('honors disabled/deleted alarm settings, including pending warnings', async () => {
    ready = false;
    reconnect(true);
    store.enable('42', false);
    reconnect(true);
    ready = true;
    alerts.wake();
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).not.toHaveBeenCalled();
    expect(store.notificationJobs()).toHaveLength(0);
    store.enable('42', true);
    ready = false;
    reconnect(true);
    store.remove('42');
    ready = true;
    alerts.wake();
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).not.toHaveBeenCalled();
  });
  it('cannot acknowledge a newer raid job using an older in-flight job', () => {
    store.enqueueAlarm('42', 'Outer Wall');
    const first = store.alarmJobs()[0];
    store.enable('42', false);
    store.enable('42', true);
    store.enqueueAlarm('42', 'Outer Wall');
    store.acknowledgeAlarm('42', first.nonce);
    store.retryAlarm('42', 2, first.nonce);
    expect(store.alarmJobs()).toHaveLength(1);
    expect(store.alarmJobs()[0].nonce).not.toBe(first.nonce);
  });
  it('delivers queued connection notices in outage order after Discord reconnects', async () => {
    ready = false;
    alerts.notify({
      id: 'outage:lost',
      family: 'outage',
      kind: 'connection-lost',
      title: '⚠️ Rust+ Connection Lost',
      description: 'Unavailable',
      at: Date.now(),
    });
    alerts.notify({
      id: 'outage:restored',
      family: 'outage',
      kind: 'connection-restored',
      title: '✅ Rust+ Connection Restored',
      description: 'Recovered',
      at: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(30000);
    expect(send).not.toHaveBeenCalled();
    ready = true;
    alerts.wake();
    await vi.advanceTimersByTimeAsync(20000);
    expect(titles()).toEqual(['⚠️ Rust+ Connection Lost', '✅ Rust+ Connection Restored']);
    expect(store.notificationJobs()).toHaveLength(0);
    for (const call of send.mock.calls) expect(call[0].allowedMentions).toEqual({ parse: [] });
    alerts.wake();
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
