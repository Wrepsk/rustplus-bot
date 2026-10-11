import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerActivity } from '../src/activity';
import { Store, type Notification } from '../src/database';
import type { Connection } from '../src/rust/connection';
import type { RustResponse } from '../src/rust/protocol';
import type { Config } from '../src/config';
import { parseDeathPush } from '../src/pairing/schema';

const steamId = '76561198000000000';
function team(online: boolean, name = 'Alper'): NonNullable<RustResponse['teamInfo']> {
  return { leaderSteamId: steamId, members: [{ steamId, name, isOnline: online }] };
}
class Rust extends EventEmitter {
  online = true;
  team = team(false);
  request = vi.fn<() => Promise<RustResponse>>(async () => ({ seq: 1, teamInfo: this.team }));
}
const fixtures: { activity: PlayerActivity; store: Store }[] = [];
function fixture(store = new Store(':memory:')) {
  store.set('alertChannel', 'alerts');
  const rust = new Rust();
  const alerts = {
    notify: vi.fn((notification: Notification) => store.enqueueNotification(notification)),
    wake: vi.fn(),
  };
  const activity = new PlayerActivity(rust as unknown as Connection, store, alerts, {} as Config);
  fixtures.push({ activity, store });
  activity.start();
  return { rust, activity, store, alerts };
}
const death = {
  ip: 'rust.example.org',
  port: 28082,
  title: 'You were killed by a player',
  message: 'Main Rust',
  persistentId: 'synthetic-push-one',
};
afterEach(async () => {
  for (const { activity, store } of fixtures.splice(0)) {
    activity.stop();
    await activity.drain();
    store.close();
  }
  vi.useRealTimers();
});

describe('Rust+ team activity', () => {
  it('baselines startup and emits real online/offline transitions once without requiring chat', async () => {
    const f = fixture();
    await f.activity.drain();
    expect(f.alerts.notify).not.toHaveBeenCalled();
    f.rust.emit('teamChanged', team(true, 'Alper @everyone'));
    f.rust.emit('teamChanged', team(true));
    f.rust.emit('teamChanged', team(false));
    expect(f.alerts.notify.mock.calls.map(([n]) => n.kind)).toEqual([
      'player-online',
      'player-offline',
    ]);
    expect(f.store.get('chatEnabled', false)).toBe(false);
  });
  it('polls for changes without overlap and does not report startup/reconnect as player events', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.activity.drain();
    f.rust.team = team(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.alerts.notify).toHaveBeenCalledOnce();
    f.rust.online = false;
    f.rust.emit('status', 'reconnecting');
    f.rust.team = team(false);
    f.rust.online = true;
    f.rust.emit('ready');
    await f.activity.drain();
    expect(f.alerts.notify).toHaveBeenCalledOnce();
    f.activity.start();
    expect(f.rust.listenerCount('teamChanged')).toBe(1);
    f.activity.stop();
    const count = f.rust.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(90000);
    expect(f.rust.request).toHaveBeenCalledTimes(count);
    expect(f.rust.listenerCount('teamChanged')).toBe(0);
  });
  it('does not turn joining/leaving a team or an unreadable snapshot into false login/logout notices', async () => {
    const f = fixture();
    await f.activity.drain();
    f.rust.emit('teamChanged', {
      ...team(false),
      members: [{ steamId: '76561198000000001', name: 'New member', isOnline: true }],
    });
    f.rust.emit('teamChanged', undefined);
    f.rust.emit('teamChanged', team(true));
    expect(f.alerts.notify).not.toHaveBeenCalled();
    f.store.set('alertChannel', '');
    f.rust.emit('teamChanged', team(false));
    expect(f.alerts.notify).not.toHaveBeenCalled();
  });
  it('discards an old polling snapshot after a newer broadcast and ignores late shutdown responses', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.activity.drain();
    let resolve!: (response: RustResponse) => void;
    f.rust.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.rust.request).toHaveBeenCalledTimes(2);
    f.rust.emit('teamChanged', team(true));
    resolve({ seq: 1, teamInfo: team(false) });
    await f.activity.drain();
    f.rust.emit('teamChanged', team(true));
    expect(f.alerts.notify).toHaveBeenCalledOnce();
    f.activity.stop();
    f.rust.emit('ready');
    f.rust.emit('teamChanged', team(false));
    expect(f.alerts.notify).toHaveBeenCalledOnce();
  });
});

describe('offline death pushes', () => {
  it('validates only the documented player/death channel and strips unneeded body fields', () => {
    const wire = {
      persistentId: 'wire-id',
      appData: [
        { key: 'channelId', value: 'player' },
        { key: 'title', value: death.title },
        { key: 'message', value: death.message },
        {
          key: 'body',
          value: JSON.stringify({
            ...death,
            type: 'death',
            targetId: 'killer',
            playerToken: 'private',
          }),
        },
      ],
    };
    expect(parseDeathPush(wire)).toEqual({ ...death, persistentId: 'wire-id' });
    expect(
      parseDeathPush({
        ...wire,
        appData: wire.appData.map((e) => (e.key === 'channelId' ? { ...e, value: 'pairing' } : e)),
      }),
    ).toBeNull();
    expect(
      parseDeathPush({
        appData: [
          { key: 'channelId', value: 'player' },
          { key: 'body', value: '{bad json' },
        ],
      }),
    ).toBeNull();
    expect(
      parseDeathPush({
        appData: [
          { key: 'channelId', value: 'player' },
          {
            key: 'body',
            value: JSON.stringify({ type: 'death', ip: 'rust.example.org', port: 99999 }),
          },
        ],
      }),
    ).toBeNull();
  });
  it('queues death alerts even with Rust+ disconnected and deduplicates IDs and duplicate registrations', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.activity.drain();
    f.rust.online = false;
    f.rust.emit('status', 'reconnecting');
    expect(f.activity.death('owner', steamId, death)).toBe(true);
    expect(f.activity.death('owner', steamId, death)).toBe(false);
    expect(
      f.activity.death('other-registration', steamId, { ...death, persistentId: 'another-id' }),
    ).toBe(false);
    expect(f.store.notificationJobs()[0].kind).toBe('player-death');
    expect(f.store.notificationJobs()[0].description).toContain('may have been delayed');
    expect(f.alerts.wake).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(31000);
    expect(f.activity.death('owner', steamId, death)).toBe(false); // wire ID persists beyond fingerprint window.
    expect(
      f.activity.death('other-registration', steamId, { ...death, persistentId: 'another-id' }),
    ).toBe(false); // A suppressed registration's wire ID is recorded too.
    expect(f.activity.death('owner', steamId, { ...death, persistentId: 'new-death' })).toBe(true);
  });
  it('uses a short fingerprint window without a push ID and rolls back failed persistence', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.activity.drain();
    const withoutId = { ...death, persistentId: undefined };
    const enqueue = vi.spyOn(f.store, 'enqueueNotification').mockImplementationOnce(() => {
      throw new Error('Synthetic database failure');
    });
    expect(() => f.activity.death('owner', steamId, withoutId)).toThrow('database failure');
    expect(f.activity.death('owner', steamId, withoutId)).toBe(true);
    expect(f.activity.death('owner', steamId, withoutId)).toBe(false);
    await vi.advanceTimersByTimeAsync(31000);
    expect(f.activity.death('owner', steamId, withoutId)).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(3);
  });
  it('persists deduplication and queued delivery across process restarts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rust-activity-'));
    const path = join(directory, 'bot.sqlite');
    const f = fixture(new Store(path));
    await f.activity.drain();
    expect(f.activity.death('owner', steamId, death)).toBe(true);
    f.activity.stop();
    await f.activity.drain();
    f.store.close();
    fixtures.pop();
    const restarted = fixture(new Store(path));
    await restarted.activity.drain();
    expect(restarted.activity.death('owner', steamId, death)).toBe(false);
    expect(restarted.store.notificationJobs()[0].kind).toBe('player-death');
    restarted.activity.stop();
    await restarted.activity.drain();
    restarted.store.close();
    fixtures.pop();
    if (!directory.startsWith(join(tmpdir(), 'rust-activity-'))) throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  });
  it('does not keep death notifications when alerts are unconfigured or the service is stopped', async () => {
    const f = fixture();
    await f.activity.drain();
    f.store.set('alertChannel', '');
    expect(f.activity.death('owner', steamId, death)).toBe(false);
    f.store.set('alertChannel', 'alerts');
    f.activity.stop();
    expect(f.activity.death('owner', steamId, death)).toBe(false);
    expect(f.store.notificationJobs()).toHaveLength(0);
  });
});
