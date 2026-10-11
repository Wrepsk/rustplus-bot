import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client, Message } from 'discord.js';
import { ChatBridge } from '../src/chat';
import { Store } from '../src/database';
import { Permissions } from '../src/permissions';
import type { Config } from '../src/config';
import type { Connection } from '../src/rust/connection';
import type { RustRequest, RustResponse } from '../src/rust/protocol';
import { messageKey, type TeamMessage } from '../src/domain';

class ChatRust extends EventEmitter {
  online = true;
  history: TeamMessage[] = [];
  teamInfo: NonNullable<RustResponse['teamInfo']> = {
    leaderSteamId: '76561198000000000',
    members: [{ steamId: '76561198000000000', name: 'ConnectedPlayer' }],
  };
  request = vi.fn(
    async (
      request: RustRequest,
      _internal = false,
      beforeSend?: () => void,
    ): Promise<RustResponse> => {
      void _internal;
      beforeSend?.();
      if (request.getTeamInfo) return { seq: 1, teamInfo: this.teamInfo };
      if (request.getTeamChat) return { seq: 1, teamChat: { messages: this.history } };
      if (request.sendTeamMessage)
        this.emit('chat', {
          steamId: '76561198000000000',
          name: 'ConnectedPlayer',
          message: request.sendTeamMessage.message,
          time: 400,
        });
      return { seq: 1, success: {} };
    },
  );
}
const fixtures: { bridge: ChatBridge; store: Store }[] = [];
function fixture() {
  const store = new Store(':memory:');
  store.set('chatEnabled', true);
  store.set('chatChannel', 'channel');
  const rust = new ChatRust();
  const send = vi.fn(async () => ({}));
  const client = {
    channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) },
  } as unknown as Client;
  const config = {
    DISCORD_GUILD_ID: 'guild',
    RUST_STEAM_ID: '76561198000000000',
    CHAT_POLL_SECONDS: 30,
    RUST_CHAT_MAX_LENGTH: 128,
  } as Config;
  const bridge = new ChatBridge(
    client,
    rust as unknown as Connection,
    store,
    config,
    new Permissions('guild', 'owner', () => ['operator']),
  );
  fixtures.push({ bridge, store });
  const member = {
    id: 'friend',
    displayName: 'Alper',
    permissions: { has: () => false },
    roles: { cache: new Map([['operator', {}]]) },
  };
  const reply = vi.fn(async () => ({}));
  const discord = {
    id: 'message1',
    content: 'Hello Rust',
    channelId: 'channel',
    guildId: 'guild',
    author: { id: 'friend', bot: false },
    webhookId: null,
    guild: { members: { fetch: vi.fn(async () => member) } },
    reply,
  } as unknown as Message;
  return { store, rust, bridge, send, discord, reply, member };
}
it('waits for a real team without reconnecting, then resumes baseline sync after joining', async () => {
  vi.useFakeTimers();
  const { bridge, rust, discord, reply, send } = fixture();
  const validTeam = rust.teamInfo;
  rust.teamInfo = { leaderSteamId: '0', members: [] };
  await bridge.reset();
  expect(bridge.status()).toContain('check team membership');
  expect(bridge.status()).not.toContain('Live');
  expect(rust.online).toBe(true);
  expect(rust.request.mock.calls.some(([r]) => r.getTeamChat)).toBe(false);
  await bridge.fromDiscord(discord);
  expect(reply).toHaveBeenCalledOnce();
  expect(rust.request.mock.calls.some(([r]) => r.sendTeamMessage)).toBe(false);
  rust.teamInfo = validTeam;
  rust.history = [{ steamId: '76561198000000000', name: 'Owner', message: 'old', time: 100 }];
  await vi.advanceTimersByTimeAsync(30000);
  expect(bridge.status()).toContain('Live');
  expect(send).not.toHaveBeenCalled();
});
async function settle(bridge: ChatBridge) {
  await bridge.drain();
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.bridge.stop();
    await f.bridge.drain();
    f.store.close();
  }
  vi.useRealTimers();
});
describe('two-way chat application', () => {
  it('ignores ordinary team updates and rebaselines only when membership changes', async () => {
    const { bridge, rust, send } = fixture();
    await bridge.reset();
    const before = rust.request.mock.calls.length;
    rust.emit('teamChanged', rust.teamInfo);
    expect(rust.request.mock.calls.length).toBe(before);
    rust.history = [
      { steamId: 'other', name: 'New teammate', message: 'old team history', time: 20 },
    ];
    rust.teamInfo = {
      ...rust.teamInfo,
      members: [...rust.teamInfo.members, { steamId: 'other', name: 'New teammate' }],
    };
    rust.emit('teamChanged', rust.teamInfo);
    await vi.waitFor(() => expect(bridge.status()).toContain('Live'));
    await bridge.drain();
    expect(send).not.toHaveBeenCalled();
    rust.emit('chat', { ...rust.history[0], message: 'new live chat', time: 21 });
    await bridge.drain();
    expect(send).toHaveBeenCalledOnce();
  });
  it('baselines history and forwards a live message once with original player name and text', async () => {
    const { rust, bridge, send } = fixture();
    const old = { steamId: 'other', name: 'Hakan', message: 'old text', time: 1 };
    rust.history = [old];
    await bridge.reset();
    expect(send).not.toHaveBeenCalled();
    const live = { ...old, message: 'Anyone got sulfur?', time: 2 };
    rust.emit('chat', live);
    rust.emit('chat', live);
    await settle(bridge);
    expect(send).toHaveBeenCalledOnce();
    const payload = send.mock.calls[0] as unknown as [
      { embeds: { toJSON(): { author: { name: string }; description: string } }[] },
    ];
    expect(payload[0].embeds[0].toJSON().author.name).toBe('Hakan [Rust]');
    expect(payload[0].embeds[0].toJSON().description).toBe('Anyone got sulfur?');
  });
  it('relays authorized Discord text, ignores duplicate IDs and suppresses the Rust echo', async () => {
    const { bridge, rust, discord, send } = fixture();
    await bridge.reset();
    await bridge.fromDiscord(discord);
    await bridge.fromDiscord(discord);
    await settle(bridge);
    expect(rust.request.mock.calls.filter(([r]) => r.sendTeamMessage)).toHaveLength(1);
    expect(rust.request).toHaveBeenCalledWith(
      {
        sendTeamMessage: { message: '[Discord] Alper: Hello Rust' },
      },
      false,
      expect.any(Function),
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects bots, webhooks, other channels, attachments-only messages and unauthorized users', async () => {
    const { bridge, rust, discord, member } = fixture();
    await bridge.reset();
    await bridge.fromDiscord({ ...discord, author: { ...discord.author, bot: true } } as Message);
    await bridge.fromDiscord({ ...discord, webhookId: 'webhook' } as Message);
    await bridge.fromDiscord({ ...discord, channelId: 'elsewhere' } as Message);
    await bridge.fromDiscord({
      ...discord,
      content: '',
      attachments: new Map([['file', {}]]),
    } as unknown as Message);
    member.roles.cache.clear();
    await bridge.fromDiscord(discord);
    expect(rust.request.mock.calls.filter(([r]) => r.sendTeamMessage)).toHaveLength(0);
  });
  it('does not replay messages at reconnect and resumes after a fresh baseline', async () => {
    const { rust, bridge, send } = fixture();
    await bridge.reset();
    rust.online = false;
    rust.emit('status');
    const offline = { steamId: 'other', name: 'Hakan', message: 'offline', time: 2 };
    rust.history = [offline];
    rust.online = true;
    await bridge.reset();
    rust.emit('chat', offline);
    await settle(bridge);
    expect(send).not.toHaveBeenCalled();
    rust.emit('chat', { ...offline, message: 'after reconnect', time: 3 });
    await settle(bridge);
    expect(send).toHaveBeenCalledOnce();
  });
  it('recovers missed live messages through polling without replaying history', async () => {
    vi.useFakeTimers();
    const { bridge, rust, send } = fixture();
    await bridge.reset();
    rust.history = [{ steamId: 'other', name: 'Hakan', message: 'missed broadcast', time: 3 }];
    await vi.advanceTimersByTimeAsync(30000);
    await settle(bridge);
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30000);
    await settle(bridge);
    expect(send).toHaveBeenCalledOnce();
  });
  it('reports disconnected messages rather than queuing stale text', async () => {
    const { bridge, rust, discord, reply } = fixture();
    await bridge.reset();
    rust.online = false;
    await bridge.fromDiscord(discord);
    expect(reply).toHaveBeenCalledOnce();
    expect(rust.request.mock.calls.filter(([r]) => r.sendTeamMessage)).toHaveLength(0);
  });
  it('remembers successfully delivered incoming message keys', async () => {
    const { bridge, rust, store } = fixture();
    await bridge.reset();
    const message = { steamId: 'other', name: 'Alper', message: 'hello', time: 2 };
    rust.emit('chat', message);
    await settle(bridge);
    expect(store.seen(messageKey(message))).toBe(true);
  });
  it('deduplicates live broadcasts overlapping with history polling', async () => {
    vi.useFakeTimers();
    const { bridge, rust, send } = fixture();
    await bridge.reset();
    const message = { steamId: 'other', name: 'Hakan', message: 'overlap', time: 10 };
    rust.history = [message];
    rust.emit('chat', message);
    await vi.advanceTimersByTimeAsync(30000);
    await bridge.drain();
    expect(send).toHaveBeenCalledOnce();
  });
  it('retries failed incoming delivery on later polls without losing older queued messages', async () => {
    vi.useFakeTimers();
    const { bridge, rust, send } = fixture();
    await bridge.reset();
    send.mockRejectedValueOnce(new Error('Discord disconnected'));
    rust.history = [{ steamId: 'other', name: 'Hakan', message: 'retry me', time: 10 }];
    await vi.advanceTimersByTimeAsync(30000);
    await bridge.drain();
    expect(send).toHaveBeenCalledOnce();
    rust.history.push({ ...rust.history[0], message: 'next message', time: 11 });
    await vi.advanceTimersByTimeAsync(30000);
    await bridge.drain();
    expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30000);
    await bridge.drain();
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('never echoes its reserved outgoing prefix after fingerprint expiry but allows teammates to quote it', async () => {
    vi.useFakeTimers();
    const { bridge, rust, send } = fixture();
    await bridge.reset();
    await vi.advanceTimersByTimeAsync(360000);
    const echo = {
      steamId: '76561198000000000',
      name: 'ConnectedPlayer',
      message: '[Discord] Alper: delayed echo',
      time: 500,
    };
    rust.emit('chat', echo);
    await bridge.drain();
    expect(send).not.toHaveBeenCalled();
    rust.emit('chat', { ...echo, steamId: 'teammate' });
    await bridge.drain();
    expect(send).toHaveBeenCalledOnce();
  });
  it('keeps outgoing order when member fetch is slow', async () => {
    const { bridge, rust, discord, member } = fixture();
    await bridge.reset();
    let finish!: (member: unknown) => void;
    const firstMessage = {
      ...discord,
      guild: {
        members: {
          fetch: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        },
      },
    } as unknown as Message;
    const first = bridge.fromDiscord(firstMessage);
    const second = bridge.fromDiscord({ ...discord, id: 'message2', content: 'second' } as Message);
    await Promise.resolve();
    await Promise.resolve();
    expect(rust.request.mock.calls.filter(([r]) => r.sendTeamMessage)).toHaveLength(0);
    finish(member);
    await Promise.all([first, second]);
    expect(
      rust.request.mock.calls.flatMap(([r]) =>
        r.sendTeamMessage ? [r.sendTeamMessage.message] : [],
      ),
    ).toEqual(['[Discord] Alper: Hello Rust', '[Discord] Alper: second']);
  });
  it('rechecks session at actual dispatch and reports an uncertain outgoing failure without retry', async () => {
    const { bridge, rust, discord, reply } = fixture();
    await bridge.reset();
    const normal = rust.request.getMockImplementation()!;
    rust.request.mockImplementation(async (request, internal, beforeSend) => {
      if (!request.sendTeamMessage) return normal(request, internal, beforeSend);
      rust.online = false;
      rust.emit('status');
      beforeSend?.();
      return { seq: 1, success: {} };
    });
    await bridge.fromDiscord(discord);
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]).toMatchObject([
      {
        content: expect.stringContaining('could not confirm delivery'),
        allowedMentions: { parse: [], repliedUser: false },
      },
    ]);
    expect(rust.request.mock.calls.filter(([r]) => r.sendTeamMessage)).toHaveLength(1);
  });
  it('stops in-flight history sync before draining and closing the database', async () => {
    const { bridge, rust, send } = fixture();
    const normal = rust.request.getMockImplementation()!;
    let finish!: (response: RustResponse) => void;
    rust.request.mockImplementation((request, internal, beforeSend) =>
      request.getTeamChat
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : normal(request, internal, beforeSend),
    );
    const sync = bridge.reset();
    await Promise.resolve();
    await Promise.resolve();
    bridge.stop();
    let drained = false;
    const drain = bridge.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish({
      seq: 1,
      teamChat: { messages: [{ steamId: 'other', name: 'Hakan', message: 'shutdown', time: 1 }] },
    });
    await Promise.all([sync, drain]);
    expect(send).not.toHaveBeenCalled();
  });
});
