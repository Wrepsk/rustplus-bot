import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatIdentities } from '../src/chat-identities';
import { Servers } from '../src/servers';
import { Store } from '../src/database';
import type { Config } from '../src/config';
import type { Connection } from '../src/rust/connection';
import type { RustRequest, RustResponse } from '../src/rust/protocol';

class FakeRust extends EventEmitter {
  online = false;
  state = 'stopped';
  members = ['76561198000000000', '76561198000000001'];
  leader = '76561198000000000';
  invalid = false;
  start = vi.fn(() => {
    this.online = !this.invalid;
    this.state = this.invalid ? 'invalid-credentials' : 'connected';
    this.emit('status', this.state);
  });
  stop = vi.fn(() => {
    this.online = false;
    this.state = 'stopped';
    this.emit('status', this.state);
  });
  request = vi.fn(
    async (
      request: RustRequest,
      _internal?: boolean,
      beforeSend?: () => void,
    ): Promise<RustResponse> => {
      void _internal;
      beforeSend?.();
      if (request.getTeamInfo)
        return {
          seq: 1,
          teamInfo: {
            leaderSteamId: this.leader,
            members: this.members.map((steamId) => ({ steamId, name: 'Player' })),
          },
        };
      return { seq: 1, success: {} };
    },
  );
}
const cleanup: (() => void)[] = [];
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'rust-identities-test-'));
  const store = new Store(join(path, 'bot.sqlite'));
  const config = {
    DATABASE_PATH: join(path, 'bot.sqlite'),
    BASE_NAME: 'Main',
    RUST_SERVER_IP: 'rust.example.org',
    RUST_APP_PORT: 28082,
    RUST_STEAM_ID: '76561198000000000',
    RUST_PLAYER_TOKEN: '123',
    ADMIN_USER_ID: 'owner',
  } as Config;
  const servers = new Servers(config, store);
  const primary = new FakeRust();
  primary.start();
  const personal = new FakeRust();
  const factory = vi.fn((_config: Config) => {
    void _config;
    return personal as unknown as Connection;
  });
  const sender = new ChatIdentities(servers, 'default', primary as unknown as Connection, factory);
  cleanup.push(() => {
    sender.stop();
    servers.close();
    store.close();
    if (!path.startsWith(join(tmpdir(), 'rust-identities-test-')))
      throw new Error('Unsafe cleanup path');
    rmSync(path, { recursive: true, force: true });
  });
  const link = (user = 'alice', playerId = '76561198000000001') =>
    servers.link('default', user, { playerId, playerToken: '-456' });
  return { servers, store, sender, primary, personal, factory, link };
}
afterEach(() => {
  for (const clean of cleanup.splice(0)) clean();
  vi.useRealTimers();
});

describe('personal Rust+ chat identities', () => {
  it('rejects unknown zero leaders even if both snapshots contain matching members', async () => {
    const { sender, primary, personal, link } = fixture();
    link();
    primary.leader = personal.leader = '0';
    await expect(sender.send('alice', 'private text', vi.fn())).rejects.toThrow('mirrored');
    expect(personal.request.mock.calls.some(([r]) => r.sendTeamMessage)).toBe(false);
  });
  it('requires a pairing and never falls back to the monitoring account', async () => {
    const { sender, primary, factory } = fixture();
    await expect(sender.send('alice', 'hello', vi.fn())).rejects.toThrow('Link your personal');
    expect(factory).not.toHaveBeenCalled();
    expect(primary.request).not.toHaveBeenCalled();
  });
  it('sends using the paired Steam ID/token and reuses the connection', async () => {
    const { sender, primary, personal, factory, link } = fixture();
    link();
    const before = vi.fn();
    await sender.send('alice', '[Discord] Alice: first', before);
    await sender.send('alice', '[Discord] Alice: second', before);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0][0]).toMatchObject({
      RUST_STEAM_ID: '76561198000000001',
      RUST_PLAYER_TOKEN: '-456',
    });
    expect(primary.request.mock.calls.every(([r]) => !r.sendTeamMessage)).toBe(true);
    expect(personal.request.mock.calls.filter(([r]) => r.sendTeamMessage)).toHaveLength(2);
    expect(before).toHaveBeenCalledTimes(2);
  });
  it('reuses the owner connection only when the matching personal pairing exists', async () => {
    const { sender, primary, factory, servers } = fixture();
    await sender.send('owner', 'hello', vi.fn());
    expect(factory).not.toHaveBeenCalled();
    expect(primary.request.mock.calls.some(([r]) => !!r.sendTeamMessage)).toBe(true);
    servers.unlink('owner');
    await expect(sender.send('owner', 'no', vi.fn())).rejects.toThrow('Link your personal');
  });
  it('rejects another team and a removed team member before sending', async () => {
    const { sender, primary, personal, link } = fixture();
    link();
    personal.leader = '76561198000000002';
    await expect(sender.send('alice', 'private text', vi.fn())).rejects.toThrow('mirrored');
    expect(personal.request.mock.calls.some(([r]) => !!r.sendTeamMessage)).toBe(false);
    personal.leader = primary.leader;
    primary.members.pop();
    await expect(sender.send('alice', 'private text', vi.fn())).rejects.toThrow('mirrored');
  });
  it('pauses rejected credentials until a new server pairing is accepted', async () => {
    const { sender, personal, factory, link } = fixture();
    link();
    personal.invalid = true;
    await expect(sender.send('alice', 'one', vi.fn())).rejects.toThrow('rejected');
    await expect(sender.send('alice', 'two', vi.fn())).rejects.toThrow('expired');
    expect(factory).toHaveBeenCalledOnce();
    personal.invalid = false;
    link();
    await sender.send('alice', 'three', vi.fn());
    expect(factory).toHaveBeenCalledTimes(2);
  });
  it('suppresses personal echoes, including delayed echoes after unlink, without swallowing other players', () => {
    const { sender, servers, link } = fixture();
    link();
    const message = {
      steamId: '76561198000000001',
      name: 'Alice',
      time: 1,
      message: '[Discord] Alice: hello',
    };
    expect(sender.isOwn(message)).toBe(true);
    servers.unlink('alice');
    expect(sender.isOwn(message)).toBe(true);
    expect(sender.isOwn({ ...message, steamId: '76561198000000002' })).toBe(false);
    expect(sender.isOwn({ ...message, message: 'normal chat' })).toBe(false);
  });
  it('closes idle connections and cancels on shutdown without duplicate listeners', async () => {
    vi.useFakeTimers();
    const { sender, personal, link } = fixture();
    link();
    await sender.send('alice', 'hello', vi.fn());
    expect(personal.listenerCount('status')).toBe(0);
    await vi.advanceTimersByTimeAsync(75001);
    expect(personal.stop).toHaveBeenCalledOnce();
    sender.stop();
    await expect(sender.send('alice', 'later', vi.fn())).rejects.toThrow('disconnected');
  });
  it('rechecks linking at actual dispatch and never retries an uncertain send', async () => {
    const { sender, personal, servers, link } = fixture();
    link();
    const normal = personal.request.getMockImplementation()!;
    personal.request.mockImplementation(async (request, internal, beforeSend) => {
      if (request.sendTeamMessage) servers.unlink('alice');
      return normal(request, internal, beforeSend);
    });
    await expect(sender.send('alice', 'hello', vi.fn())).rejects.toThrow('changed');
    expect(personal.request.mock.calls.filter(([r]) => !!r.sendTeamMessage)).toHaveLength(1);
  });
});
