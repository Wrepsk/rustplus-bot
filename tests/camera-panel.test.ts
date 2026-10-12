import { afterEach, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { CameraPanel } from '../src/discord/camera-panel';
import { CameraRegistry } from '../src/cameras/registry';
import { Store } from '../src/database';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});
function fixture() {
  const store = new Store(':memory:'),
    registry = new CameraRegistry(store);
  registry.add({ id: 'ROOF', name: 'Roof' });
  store.set('panel', { channelId: 'switch-channel', messageId: 'switch-panel' });
  const status = { name: 'Main', state: 'connected', online: true };
  const edit = vi.fn(async (_payload: unknown) => {
    void _payload;
  });
  const message = { id: 'camera-panel', edit };
  const send = vi.fn(async (_payload: unknown) => {
    void _payload;
    return message;
  });
  const fetch = vi.fn(async (_id: string) => {
    void _id;
    return message;
  });
  const channel = { isTextBased: () => true, send, messages: { fetch } };
  const client = {
    isReady: () => true,
    channels: { fetch: vi.fn(async () => channel) },
  } as unknown as Client;
  const build = () =>
    new CameraPanel(
      client,
      store,
      'default',
      () => registry.list(),
      () => status,
    );
  const panel = build();
  cleanups.push(() => {
    panel.stop();
    store.close();
  });
  return { store, registry, status, edit, send, fetch, client, panel, build };
}
it('persists one camera message across concurrent creation and instance restart without touching switch panels', async () => {
  const f = fixture();
  await Promise.all([f.panel.create('shared'), f.panel.create('shared')]);
  f.panel.stop();
  const restored = f.build();
  cleanups.push(() => restored.stop());
  await restored.create('shared');
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.edit).toHaveBeenCalledTimes(2);
  expect(restored.isPanel('camera-panel', 'shared')).toBe(true);
  expect(restored.isPanel('camera-panel', 'wrong')).toBe(false);
  expect(restored.isPanel('stale', 'shared')).toBe(false);
  expect(f.store.get('panel', null)).toEqual({
    channelId: 'switch-channel',
    messageId: 'switch-panel',
  });
});
it('supports 25 camera choices within Discord limits and marks disconnected selection unavailable', async () => {
  const f = fixture();
  for (let i = 1; i < 25; i++) f.registry.add({ id: `CAM${i}`, name: `Camera ${i}` });
  await f.panel.create('shared');
  const payload = JSON.parse(JSON.stringify(f.send.mock.calls[0][0]));
  expect(payload.components).toHaveLength(2);
  expect(payload.components[0].components[0].options).toHaveLength(25);
  expect(payload.components[0].components[0].custom_id).toBe('campanel:default:watch');
  expect(payload.allowedMentions).toEqual({ parse: [] });
  expect(JSON.stringify(payload)).not.toContain('ticket=');
  f.status.online = false;
  f.status.state = 'reconnecting';
  f.status.name = 'Renamed';
  await f.panel.refresh();
  const offline = JSON.parse(JSON.stringify(f.edit.mock.calls[0][0]));
  expect(offline.components[0].components[0].disabled).toBe(true);
  expect(offline.embeds[0].description).toContain('reconnecting');
  expect(offline.embeds[0].author.name).toBe('Renamed');
  f.status.online = true;
  f.status.state = 'connected';
  await f.panel.refresh();
  expect(
    JSON.parse(JSON.stringify(f.edit.mock.calls[1][0])).components[0].components[0].disabled,
  ).toBe(false);
});
it('preserves existing reference on Discord permission failure and recreates only a deleted message', async () => {
  const f = fixture();
  await f.panel.create('shared');
  f.fetch.mockRejectedValueOnce({ code: 50001 });
  await expect(f.panel.create('shared')).rejects.toEqual({ code: 50001 });
  expect(f.send).toHaveBeenCalledOnce();
  f.fetch.mockRejectedValueOnce({ code: 10008 });
  await f.panel.create('shared');
  expect(f.send).toHaveBeenCalledTimes(2);
  f.send.mockRejectedValueOnce(new Error('send failed'));
  await expect(f.panel.create('another')).rejects.toThrow('send failed');
  expect(f.panel.isPanel('camera-panel', 'shared')).toBe(true);
});
it('moves a camera panel, retires old controls and retains an empty panel after removing every camera', async () => {
  const f = fixture();
  await f.panel.create('shared');
  f.send.mockResolvedValueOnce({ id: 'new-camera-panel', edit: f.edit });
  await f.panel.create('new-channel');
  expect(f.panel.isPanel('camera-panel', 'shared')).toBe(false);
  expect(f.panel.isPanel('new-camera-panel', 'new-channel')).toBe(true);
  expect(f.store.get('serverPanelMessages', [])).toEqual([
    { channelId: 'shared', messageId: 'camera-panel' },
    { channelId: 'new-channel', messageId: 'new-camera-panel' },
  ]);
  expect(f.edit).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  f.registry.remove('ROOF');
  await f.panel.refresh();
  const payload = JSON.parse(JSON.stringify(f.edit.mock.calls.at(-1)![0]));
  expect(payload.components).toHaveLength(1);
  expect(payload.embeds[0].description).toContain('0 cameras');
});
it('coalesces slow background refreshes and drains pending work on shutdown', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.panel.create('shared');
  let finish!: () => void;
  f.edit.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  f.panel.schedule();
  await vi.advanceTimersByTimeAsync(1200);
  for (let i = 0; i < 50; i++) f.panel.schedule();
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.edit).toHaveBeenCalledOnce();
  f.panel.stop();
  let drained = false;
  const drain = f.panel.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  finish();
  await drain;
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.edit).toHaveBeenCalledOnce();
});
