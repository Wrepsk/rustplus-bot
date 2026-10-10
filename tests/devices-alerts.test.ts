import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { Devices } from '../src/devices';
import { Alerts } from '../src/discord/alerts';
import { Store } from '../src/database';
import type { Connection } from '../src/rust/connection';
import type { Config } from '../src/config';

describe('device and alert application behavior', () => {
  it('retries a failed Discord delivery from the persistent alarm queue', async () => {
    vi.useFakeTimers();
    const store = new Store(':memory:');
    const device = store.add({ id: '42', name: 'Outer Wall', type: 'alarm' });
    const send = vi.fn().mockRejectedValueOnce(new Error('Discord outage')).mockResolvedValue({});
    const client = {
      isReady: () => true,
      channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) },
    } as unknown as Client;
    const alerts = new Alerts(client, store, {
      ALERT_CHANNEL_ID: 'channel',
      BASE_NAME: 'Main Base',
    } as Config);
    try {
      alerts.start();
      alerts.enqueue(device);
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10000);
      expect(send).toHaveBeenCalledTimes(2);
      expect(store.alarmJobs()).toHaveLength(0);
    } finally {
      await alerts.stop();
      store.close();
      vi.useRealTimers();
    }
  });
  it('only alerts on live broadcasts and suppresses reconnect snapshots', () => {
    const store = new Store(':memory:');
    store.add({ id: '42', name: 'Outer Wall', type: 'alarm' });
    const rust = Object.assign(new EventEmitter(), { online: true });
    const devices = new Devices(store, rust as unknown as Connection, 0);
    const alarm = vi.fn();
    devices.on('alarm', alarm);
    try {
      rust.emit('device', '42', true, true);
      expect(alarm).not.toHaveBeenCalled();
      rust.emit('device', '42', false, true);
      rust.emit('device', '42', true, false);
      rust.emit('device', '42', true, false);
      expect(alarm).toHaveBeenCalledOnce();
      rust.online = false;
      rust.emit('status');
      rust.online = true;
      rust.emit('device', '42', true, true);
      rust.emit('device', '42', true, false);
      expect(alarm).toHaveBeenCalledOnce();
    } finally {
      store.close();
    }
  });
  it('prevents repeated switch clicks from submitting duplicate requests', async () => {
    const store = new Store(':memory:');
    store.add({ id: '42', name: 'Lights', type: 'switch' });
    let resolve!: (state: boolean) => void;
    const setSwitch = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolve = r;
        }),
    );
    const rust = Object.assign(new EventEmitter(), { online: true, setSwitch });
    const devices = new Devices(store, rust as unknown as Connection, 0);
    try {
      const first = devices.control('42', 'on');
      await expect(devices.control('42', 'on')).rejects.toThrow('already running');
      resolve(true);
      await expect(first).resolves.toBe(true);
      expect(setSwitch).toHaveBeenCalledOnce();
      expect(devices.busy.size).toBe(0);
    } finally {
      store.close();
    }
  });
  it('produces labeled simulated alerts with restricted mentions and no Rust calls', async () => {
    const store = new Store(':memory:');
    const send = vi.fn(async () => ({}));
    const client = {
      channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) },
    } as unknown as Client;
    const alerts = new Alerts(client, store, {
      ALERT_CHANNEL_ID: 'channel',
      ALERT_ROLE_ID: 'role',
      BASE_NAME: 'Main Base',
    } as Config);
    try {
      await alerts.send(
        { id: '42', name: 'Outer Wall', type: 'alarm', enabled: true, sensitive: false },
        true,
      );
      expect(send).toHaveBeenCalledOnce();
      const payload = send.mock.calls[0] as unknown as [
        {
          embeds: { toJSON(): { title: string } }[];
          allowedMentions: { parse: string[]; roles: string[] };
        },
      ];
      expect(payload[0].embeds[0].toJSON().title).toContain('SIMULATED');
      expect(payload[0].allowedMentions).toEqual({ parse: [], roles: ['role'] });
    } finally {
      await alerts.stop();
      store.close();
    }
  });
  it('persists and coalesces undelivered alerts and honors retry scheduling', () => {
    const store = new Store(':memory:');
    try {
      store.enqueueAlarm('42', 'Outer Wall');
      store.enqueueAlarm('42', 'Outer Wall');
      expect(store.alarmJobs()).toHaveLength(1);
      store.retryAlarm('42', 1);
      expect(store.alarmJobs()).toHaveLength(0);
      store.acknowledgeAlarm('42');
      expect(store.alarmJobs()).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
