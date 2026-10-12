import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { Store } from '../src/database';
import { Devices } from '../src/devices';
import { Panel } from '../src/discord/panel';
import type { Connection } from '../src/rust/connection';

function fixture() {
  const store = new Store(':memory:');
  for (let id = 1; id <= 6; ++id)
    store.add({ id: String(id), name: `Switch ${id}`, type: 'switch' });
  const rust = Object.assign(new EventEmitter(), { online: true, state: 'connected' });
  const devices = new Devices(store, rust as unknown as Connection, 60);
  devices.states.set('1', true);
  devices.states.set('2', false);
  const message = { id: 'panel1', edit: vi.fn(async () => ({})) };
  const send = vi.fn(async () => message);
  const fetch = vi.fn(async () => message);
  const channel = { isTextBased: () => true, send, messages: { fetch } };
  const client = {
    isReady: () => true,
    channels: { fetch: vi.fn(async () => channel) },
  } as unknown as Client;
  const panel = new Panel(client, store, devices);
  return { store, rust, devices, message, send, fetch, client, panel };
}
type Payload = {
  components: { toJSON(): { components: { custom_id: string; disabled: boolean }[] } }[];
  embeds: { toJSON(): { fields: { value: string }[]; footer: { text: string } } }[];
};

describe('persistent Discord control panel', () => {
  it('keeps one saved message across refreshes and a new panel instance after restart', async () => {
    const f = fixture();
    let restored: Panel | undefined;
    try {
      await f.panel.create('channel');
      await f.panel.create('channel');
      restored = new Panel(f.client, f.store, f.devices);
      await restored.create('channel');
      expect(f.send).toHaveBeenCalledOnce();
      expect(f.message.edit).toHaveBeenCalledTimes(2);
      expect(restored.isPanel('panel1')).toBe(true);
      expect(restored.isPanel('old-message')).toBe(false);
    } finally {
      f.panel.stop();
      restored?.stop();
      f.store.close();
    }
  });
  it('paginates within Discord limits and uses reported ON/OFF/UNKNOWN states', async () => {
    const f = fixture();
    try {
      await f.panel.create('channel');
      const initial = (f.send.mock.calls[0] as unknown as [Payload])[0];
      expect(initial.components).toHaveLength(5);
      expect(initial.embeds[0].toJSON().fields[0].value).toContain('ON');
      expect(initial.embeds[0].toJSON().fields[1].value).toContain('OFF');
      expect(initial.embeds[0].toJSON().fields[2].value).toContain('UNKNOWN');
      expect(initial.components[2].toJSON().components.map((button) => button.disabled)).toEqual([
        true,
        true,
        false,
      ]);
      expect(initial.components[0].toJSON().components[0].custom_id).toBe('switch:on:1');
      await f.panel.refresh(1);
      const next = (f.message.edit.mock.calls[0] as unknown as [Payload])[0];
      expect(next.components[0].toJSON().components[0].custom_id).toBe('switch:on:5');
      expect(next.embeds[0].toJSON().footer.text).toContain('Page 2/2');
      f.rust.online = false;
      f.rust.state = 'reconnecting';
      await f.panel.refresh(0);
      const offline = (f.message.edit.mock.calls[1] as unknown as [Payload])[0];
      expect(offline.components[0].toJSON().components.every((button) => button.disabled)).toBe(
        true,
      );
      expect(offline.embeds[0].toJSON().fields[0].value).toContain('DISCONNECTED');
    } finally {
      f.panel.stop();
      f.store.close();
    }
  });
  it('recreates a deleted saved message instead of losing panel access', async () => {
    const f = fixture();
    try {
      f.store.set('panel', { channelId: 'channel', messageId: 'deleted', page: 0 });
      f.fetch.mockRejectedValueOnce({ code: 10008 });
      await f.panel.create('channel');
      expect(f.send).toHaveBeenCalledOnce();
      expect(f.panel.isPanel('panel1')).toBe(true);
    } finally {
      f.panel.stop();
      f.store.close();
    }
  });
  it('moves to the requested channel and retires the previous message', async () => {
    const f = fixture();
    try {
      await f.panel.create('old-channel');
      const moved = { id: 'moved-panel', edit: vi.fn(async () => ({})) };
      f.send.mockResolvedValueOnce(moved);
      await f.panel.create('shared-panels');
      expect(f.store.get('panel', null)).toMatchObject({
        channelId: 'shared-panels',
        messageId: 'moved-panel',
      });
      expect(f.panel.isPanel('panel1')).toBe(false);
      expect(f.panel.isPanel('moved-panel')).toBe(true);
      expect(f.store.get('serverPanelMessages', [])).toEqual([
        { channelId: 'old-channel', messageId: 'panel1' },
        { channelId: 'shared-panels', messageId: 'moved-panel' },
      ]);
      expect(f.message.edit).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
      f.fetch.mockResolvedValue(moved);
      await f.panel.create('shared-panels');
      expect(f.send).toHaveBeenCalledTimes(2);
      expect(moved.edit).toHaveBeenCalledOnce();
      f.panel.setServerName('Renamed server');
      await f.panel.refresh();
      expect(JSON.stringify(moved.edit.mock.calls)).toContain('Renamed server');
    } finally {
      f.panel.stop();
      f.store.close();
    }
  });
  it('keeps the old panel on failed creation and rejects old buttons even if cleanup fails', async () => {
    const f = fixture();
    try {
      await f.panel.create('old-channel');
      f.send.mockRejectedValueOnce(new Error('Synthetic send failure'));
      await expect(f.panel.create('shared-panels')).rejects.toThrow('send failure');
      expect(f.panel.isPanel('panel1')).toBe(true);
      f.send.mockResolvedValueOnce({ id: 'new-panel', edit: vi.fn(async () => ({})) });
      f.fetch.mockRejectedValueOnce({ code: 50001 });
      await f.panel.create('shared-panels');
      expect(f.panel.isPanel('new-panel')).toBe(true);
      expect(f.panel.isPanel('panel1')).toBe(false);
    } finally {
      f.panel.stop();
      f.store.close();
    }
  });
  it('coalesces repeated background updates during a slow Discord edit and drains on shutdown', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: () => void;
    try {
      await f.panel.create('channel');
      f.message.edit.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({});
          }),
      );
      f.panel.schedule();
      await vi.advanceTimersByTimeAsync(1200);
      for (let i = 0; i < 100; ++i) {
        f.panel.schedule();
        await vi.advanceTimersByTimeAsync(1200);
      }
      expect(f.message.edit).toHaveBeenCalledOnce();
      let drained = false;
      f.panel.stop();
      const drain = f.panel.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      finish();
      await drain;
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.message.edit).toHaveBeenCalledOnce();
      expect(f.devices.listenerCount('update')).toBe(0);
    } finally {
      f.panel.stop();
      f.store.close();
      vi.useRealTimers();
    }
  });
});
