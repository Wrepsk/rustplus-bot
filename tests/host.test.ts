import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Events, type Interaction } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordHost } from '../src/discord/host';
import { Servers } from '../src/servers';
import { Store } from '../src/database';
import { Connection } from '../src/rust/connection';
import type { Config } from '../src/config';

let directory: string, store: Store, servers: Servers, host: DiscordHost, second: string;
let config: Config;
let role: string[];
const secondPairing = {
  type: 'server',
  name: 'Second',
  ip: 'second.example.org',
  port: 28083,
  playerId: '76561198000000001',
  playerToken: '456',
} as const;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'rust-host-test-'));
  store = new Store(join(directory, 'bot.sqlite'));
  config = {
    DATABASE_PATH: join(directory, 'bot.sqlite'),
    BASE_NAME: 'Main',
    RUST_SERVER_IP: 'rust.example.org',
    RUST_APP_PORT: 28082,
    RUST_STEAM_ID: '76561198000000000',
    RUST_PLAYER_TOKEN: '123',
    ADMIN_USER_ID: 'owner',
    DISCORD_GUILD_ID: 'guild',
    ALLOWED_ROLE_IDS: ['operator'],
    ALARM_COOLDOWN_SECONDS: 60,
    CHAT_POLL_SECONDS: 30,
    RUST_CHAT_MAX_LENGTH: 128,
  } as Config;
  servers = new Servers(config, store);
  second = servers.add(secondPairing).id;
  store.set('chatChannel', 'main-chat');
  store.set('panel', { channelId: 'main-panel-channel', messageId: 'main-panel' });
  store.add({ id: '42', name: 'Main lights', type: 'switch' });
  servers.store(second).set('chatChannel', 'second-chat');
  servers
    .store(second)
    .set('panel', { channelId: 'second-panel-channel', messageId: 'second-panel' });
  servers.store(second).add({ id: '42', name: 'Second lights', type: 'switch' });
  vi.spyOn(Connection.prototype, 'start').mockImplementation(function (this: Connection) {
    this.state = 'connected';
    this.emit('status', 'connected');
  });
  host = new DiscordHost(config, servers);
  role = ['operator'];
  vi.spyOn(host.client.guilds, 'fetch').mockResolvedValue({
    id: 'guild',
    members: {
      fetch: async ({ user }: { user: string }) => ({
        id: user,
        permissions: { has: () => false },
        roles: { cache: new Map(role.map((r) => [r, {}])) },
      }),
    },
  } as never);
});
afterEach(async () => {
  await host.stop();
  servers.close();
  store.close();
  vi.restoreAllMocks();
  if (!directory.startsWith(join(tmpdir(), 'rust-host-test-')))
    throw new Error('Unsafe cleanup path');
  rmSync(directory, { recursive: true, force: true });
});
function command(
  name: string,
  sub: string,
  values: Record<string, string> = {},
  user = 'owner',
  channelId = 'general',
) {
  const interaction = {
    commandName: name,
    user: { id: user },
    guildId: 'guild',
    channelId,
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => sub,
      getString: (key: string) => values[key] || null,
      getBoolean: () => null,
      getChannel: (key: string) => ({ id: values[key] || '' }),
      getRole: () => null,
    },
    isChatInputCommand: () => true,
    isButton: () => false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async (_value: unknown) => {
      void _value;
      return {};
    }),
    reply: vi.fn(async () => ({})),
  };
  return interaction;
}
function emit(interaction: unknown) {
  host.client.emit(Events.InteractionCreate, interaction as Interaction);
}
function output(interaction: ReturnType<typeof command>) {
  return interaction.editReply.mock.calls.map(([payload]) => JSON.stringify(payload)).join('\n');
}
describe('one Discord client hosting multiple Rust servers', () => {
  it('gives friends a portable download and code instead of developer setup commands', async () => {
    config.PAIRING_HELPER_URL = 'https://example.org/RustPlus-Pairing-Windows-x64.zip';
    const start = command('pair', 'start', {}, 'friend');
    emit(start);
    await vi.waitFor(() => expect(start.editReply).toHaveBeenCalled());
    const response = output(start);
    expect(response).toContain('RustPlus Pairing.cmd');
    expect(response).toContain('Extract all');
    expect(response).toContain('Copy Discord command');
    expect(response).toContain(config.PAIRING_HELPER_URL);
    expect(response).not.toContain('npm');
    expect(response).not.toContain('project folder');
    expect(start.deferReply).toHaveBeenCalledWith({ flags: 64 });
  });
  it('does not give a broken download link when the owner has not published the helper', async () => {
    const start = command('pair', 'start', {}, 'friend');
    emit(start);
    await vi.waitFor(() => expect(start.editReply).toHaveBeenCalled());
    expect(output(start)).toContain('Ask the server owner');
    expect(output(start)).not.toContain('npm');
    const response = start.editReply.mock.calls[0][0] as { components: unknown[] };
    expect(response.components).toEqual([]);
  });
  it('ignores legacy @everyone operator entries for pairing commands', async () => {
    store.set('allowedRoles', ['guild']);
    servers.store(second).set('allowedRoles', ['guild']);
    role = ['guild'];
    const start = command('pair', 'start', {}, 'stranger');
    emit(start);
    await vi.waitFor(() => expect(start.editReply).toHaveBeenCalled());
    expect(output(start)).toContain('operator role');
    expect(output(start)).not.toContain('npm run pair');
  });
  it('routes commands by explicit server, channel, then personal selection', async () => {
    servers.select('owner', second);
    expect(host.selected(command('status', '') as never)).toBe(second);
    expect(host.selected(command('status', '', {}, 'owner', 'main-chat') as never)).toBe('default');
    expect(
      host.selected(command('status', '', { server: second }, 'owner', 'main-chat') as never),
    ).toBe(second);
    const list = command('server', 'list');
    emit(list);
    await vi.waitFor(() => expect(list.editReply).toHaveBeenCalled());
    expect(output(list)).toContain('Second');
    expect(host.client.listenerCount(Events.InteractionCreate)).toBe(1);
    expect(host.client.listenerCount(Events.MessageCreate)).toBe(1);
  });
  it('routes identical persistent entity IDs using the panel message, not the selected server', async () => {
    servers.select('owner', second);
    const control = vi.spyOn(Connection.prototype, 'setSwitch').mockResolvedValue(true);
    const interaction = Object.assign(command('', ''), {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: 'switch:on:42',
      message: { id: 'main-panel' },
    });
    // Mark both connections online without sending any network traffic.
    for (const entry of (
      host as unknown as { sessions: Map<string, { rust: Connection }> }
    ).sessions.values())
      entry.rust.start();
    emit(interaction);
    await vi.waitFor(() => expect(control).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(output(interaction)).toContain('Switch state confirmed'));
    expect(output(interaction)).toContain('Main lights');
    expect(output(interaction)).not.toContain('Second lights');
  });
  it('rejects unauthorized forged controls and administrative pause attempts', async () => {
    role = [];
    const control = vi.spyOn(Connection.prototype, 'setSwitch');
    const interaction = Object.assign(command('', '', {}, 'stranger'), {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: 'switch:on:42',
      message: { id: 'main-panel' },
    });
    emit(interaction);
    await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalled());
    expect(control).not.toHaveBeenCalled();
    role = ['operator'];
    const pause = command('server', 'pause', {}, 'friend');
    emit(pause);
    await vi.waitFor(() => expect(pause.editReply).toHaveBeenCalled());
    expect(output(pause)).toContain('Administrator');
    expect(servers.get('default').enabled).toBe(true);
  });
  it('prevents assigning the same chat channel to two servers', async () => {
    const setup = command('chat', 'setup', { server: second, channel: 'main-chat' });
    emit(setup);
    await vi.waitFor(() => expect(setup.editReply).toHaveBeenCalled());
    expect(output(setup)).toContain('different Discord');
    expect(servers.store(second).get('chatChannel', '')).toBe('second-chat');
  });
  it('links a personal pairing without changing the server monitoring account', async () => {
    host.pairing.receive('friend', {
      ...secondPairing,
      playerId: '76561198000000002',
      playerToken: '-789',
    });
    const id = host.pairing.inbox('friend')[0].id;
    const accept = command('pair', 'accept', { id }, 'friend');
    emit(accept);
    await vi.waitFor(() => expect(accept.editReply).toHaveBeenCalled());
    expect(servers.identity(second, 'friend')?.playerId).toBe('76561198000000002');
    expect(servers.connectionConfig(second).RUST_STEAM_ID).toBe(secondPairing.playerId);
    expect(output(accept)).not.toContain('-789');
  });
  it('lets revoked users unlink their own credentials but prevents reading another inbox', async () => {
    servers.link(second, 'friend', { playerId: secondPairing.playerId, playerToken: '456' });
    host.pairing.receive('owner', secondPairing);
    const inbox = command('pair', 'inbox', {}, 'friend');
    emit(inbox);
    await vi.waitFor(() => expect(inbox.editReply).toHaveBeenCalled());
    expect(output(inbox)).toContain('No pairings');
    role = [];
    const unlink = command('pair', 'unlink', {}, 'friend');
    emit(unlink);
    await vi.waitFor(() => expect(unlink.editReply).toHaveBeenCalled());
    expect(servers.identity(second, 'friend')).toBeUndefined();
    expect(servers.identity('default', 'owner')).toBeDefined();
  });
  it('pauses/resumes only the targeted server without adding Discord listeners', async () => {
    const pause = command('server', 'pause', { server: second });
    emit(pause);
    await vi.waitFor(() => expect(pause.editReply).toHaveBeenCalled());
    expect(servers.get(second).enabled).toBe(false);
    expect(servers.get('default').enabled).toBe(true);
    const resume = command('server', 'resume', { server: second });
    emit(resume);
    await vi.waitFor(() => expect(resume.editReply).toHaveBeenCalled());
    expect(servers.get(second).enabled).toBe(true);
    expect(host.client.listenerCount(Events.InteractionCreate)).toBe(1);
  });
});
