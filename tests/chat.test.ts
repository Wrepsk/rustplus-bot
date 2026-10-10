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
  request = vi.fn(async (request: RustRequest): Promise<RustResponse> => {
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
  });
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
    expect(rust.request).toHaveBeenCalledWith({
      sendTeamMessage: { message: '[Discord] Alper: Hello Rust' },
    });
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
});
