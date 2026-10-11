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
import { PairingListener } from '../src/pairing/listener';
import { encryptPairing } from '../src/pairing/crypto';
import { PlayerActivity } from '../src/activity';
import { Panel } from '../src/discord/panel';
import { Alerts, AlertDeliveryError } from '../src/discord/alerts';
import { commands } from '../src/discord/commands';
import type { Bot } from '../src/discord/bot';

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
      getInteger: () => null,
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
function component(
  customId: string,
  user = 'owner',
  kind: 'button' | 'modal' | 'select' = 'button',
  values: Record<string, string> = {},
) {
  const interaction = Object.assign(command('', '', {}, user), {
    customId,
    message: { id: 'private-message' },
    isChatInputCommand: () => false,
    isButton: () => kind === 'button',
    isModalSubmit: () => kind === 'modal',
    isStringSelectMenu: () => kind === 'select',
    isFromMessage: () => true,
    values: [values.selected],
    fields: { getTextInputValue: (key: string) => values[key] || '' },
    showModal: vi.fn(async (_value: unknown) => {
      void _value;
    }),
    followUp: vi.fn(async (_value: unknown) => {
      void _value;
    }),
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
    }),
  });
  return interaction;
}
describe('interactive pairing and management panels', () => {
  it('does not alter a registration while a switch operation is running', async () => {
    const sessions = (
      host as unknown as { sessions: Map<string, { bot: { devices: { busy: Set<string> } } }> }
    ).sessions;
    sessions.get(second)!.bot.devices.busy.add('42');
    const remove = component(`view:${second}:owner:device:remove-confirm:42`);
    emit(remove);
    await vi.waitFor(() => expect(remove.editReply).toHaveBeenCalled());
    expect(output(remove)).toContain('request for this device is running');
    expect(servers.store(second).devices()).toHaveLength(1);
    sessions.get(second)!.bot.devices.busy.delete('42');
  });
  it('toggles chat and alarm settings through the UI with fresh administrator checks', async () => {
    const enable = component(`view:${second}:owner:chat:enable:0`);
    emit(enable);
    await vi.waitFor(() => expect(enable.editReply).toHaveBeenCalled());
    expect(servers.store(second).get('chatEnabled', false)).toBe(true);
    const denied = component(`view:${second}:friend:chat:disable:0`, 'friend');
    emit(denied);
    await vi.waitFor(() => expect(denied.editReply).toHaveBeenCalled());
    expect(servers.store(second).get('chatEnabled', false)).toBe(true);
    servers.store(second).add({ id: '77', name: 'Outer wall', type: 'alarm' });
    const disable = component(`view:${second}:owner:alarm:disable:77`);
    emit(disable);
    await vi.waitFor(() => expect(disable.editReply).toHaveBeenCalled());
    expect(servers.store(second).device('77').enabled).toBe(false);
    const restore = component(`view:${second}:owner:alarm:enable:77`);
    emit(restore);
    await vi.waitFor(() => expect(restore.editReply).toHaveBeenCalled());
    expect(servers.store(second).device('77').enabled).toBe(true);
  });
  it('uses website pairing with the browser extension and no desktop fallback when configured', async () => {
    config.PAIRING_WEB_URL = 'https://pair.example.org';
    config.PAIRING_HELPER_URL = 'https://example.org/old-desktop.zip';
    const start = command('pair', 'start', {}, 'friend');
    emit(start);
    await vi.waitFor(() => expect(start.editReply).toHaveBeenCalled());
    expect(output(start)).toContain('Open pairing website');
    expect(output(start)).toContain('https://pair.example.org/#code=');
    expect(output(start)).not.toContain('npm');
    expect(output(start)).not.toContain('RustPlus Pairing.cmd');
    expect(output(start)).toContain('Chrome / Edge extension');
    expect(output(start)).not.toContain('old-desktop.zip');
    const codes = output(start).match(/[a-f0-9]{32}\.[A-Za-z0-9_-]+/g)!;
    expect(host.pairing.isChallengeActive(codes[0])).toBe(true);
  });
  it('paginates private inboxes within Discord limits and opens a naming modal', async () => {
    for (let i = 0; i < 6; i++)
      host.pairing.receive('owner', {
        type: 'entity',
        ip: secondPairing.ip,
        port: secondPairing.port,
        entityId: String(100 + i),
        entityType: 1,
        entityName: `Lights ${i}`,
      });
    const inbox = command('pair', 'inbox');
    emit(inbox);
    await vi.waitFor(() => expect(inbox.editReply).toHaveBeenCalled());
    const payload = inbox.editReply.mock.calls[0][0] as { components: unknown[] };
    expect(payload.components).toHaveLength(5);
    expect(output(inbox)).toContain('Accept 1');
    expect(output(inbox)).toContain('Decline 1');
    const id = host.pairing.inbox('owner')[0].id;
    const accept = component(`pairui:accept:owner:${id}:0`);
    emit(accept);
    await vi.waitFor(() => expect(accept.showModal).toHaveBeenCalled());
    expect(JSON.stringify(accept.showModal.mock.calls[0][0])).toContain('Friendly name');
    expect(host.pairing.inbox('owner')).toHaveLength(6);
  });
  it('saves names and sensitive switches without activating devices; rejects replay', async () => {
    host.pairing.receive('owner', {
      type: 'entity',
      ip: secondPairing.ip,
      port: secondPairing.port,
      entityId: '99',
      entityType: 1,
    });
    const id = host.pairing.inbox('owner')[0].id;
    const control = vi.spyOn(Connection.prototype, 'setSwitch');
    const save = component(`pairui:save:owner:${id}:0`, 'owner', 'modal', {
      name: 'Workshop power',
      sensitive: 'yes',
    });
    emit(save);
    await vi.waitFor(() => expect(save.editReply).toHaveBeenCalled());
    expect(servers.store(second).device('99')).toMatchObject({
      name: 'Workshop power',
      sensitive: true,
    });
    expect(control).not.toHaveBeenCalled();
    expect(host.pairing.inbox('owner')).toHaveLength(0);
    const replay = component(save.customId, 'owner', 'modal', { name: 'Other', sensitive: 'no' });
    emit(replay);
    await vi.waitFor(() => expect(replay.followUp).toHaveBeenCalled());
    expect(servers.store(second).device('99').name).toBe('Workshop power');
  });
  it('renames an existing pairing and never downgrades an existing safety flag', async () => {
    servers.store(second).markSensitive('42');
    host.pairing.receive('owner', {
      type: 'entity',
      ip: secondPairing.ip,
      port: secondPairing.port,
      entityId: '42',
      entityType: 1,
    });
    const id = host.pairing.inbox('owner')[0].id;
    const save = component(`pairui:save:owner:${id}:0`, 'owner', 'modal', {
      name: 'New name',
      sensitive: 'no',
    });
    emit(save);
    await vi.waitFor(() => expect(save.editReply).toHaveBeenCalled());
    expect(servers.store(second).device('42')).toMatchObject({ name: 'New name', sensitive: true });
  });
  it('rejects stolen inbox buttons and administrative pairing by ordinary operators', async () => {
    host.pairing.receive('owner', secondPairing);
    const id = host.pairing.inbox('owner')[0].id;
    const stolen = component(`pairui:decline:owner:${id}:0`, 'friend');
    emit(stolen);
    await vi.waitFor(() => expect(stolen.reply).toHaveBeenCalled());
    expect(host.pairing.inbox('owner')).toHaveLength(1);
    host.pairing.receive('friend', {
      type: 'entity',
      ip: secondPairing.ip,
      port: secondPairing.port,
      entityId: '99',
      entityType: 1,
    });
    const own = host.pairing.inbox('friend')[0].id;
    const accept = component(`pairui:accept:friend:${own}:0`, 'friend');
    emit(accept);
    await vi.waitFor(() => expect(accept.reply).toHaveBeenCalled());
    expect(accept.showModal).not.toHaveBeenCalled();
    expect(servers.store(second).devices()).toHaveLength(1);
  });
  it('checks fresh roles again when a server pairing modal is submitted', async () => {
    host.pairing.receive('friend', {
      ...secondPairing,
      playerId: '76561198000000002',
      playerToken: '999',
    });
    const id = host.pairing.inbox('friend')[0].id;
    const accept = component(`pairui:accept:friend:${id}:0`, 'friend');
    emit(accept);
    await vi.waitFor(() => expect(accept.showModal).toHaveBeenCalled());
    role = [];
    const save = component(`pairui:save:friend:${id}:0`, 'friend', 'modal', { name: 'Server' });
    emit(save);
    await vi.waitFor(() => expect(save.followUp).toHaveBeenCalled());
    expect(servers.identity(second, 'friend')).toBeUndefined();
  });
  it('declines only the selected entry and selects servers using a dropdown', async () => {
    host.pairing.receive('owner', secondPairing);
    host.pairing.receive('friend', secondPairing);
    const id = host.pairing.inbox('owner')[0].id;
    const decline = component(`pairui:decline:owner:${id}:0`);
    emit(decline);
    await vi.waitFor(() => expect(decline.editReply).toHaveBeenCalled());
    expect(host.pairing.inbox('owner')).toHaveLength(0);
    expect(host.pairing.inbox('friend')).toHaveLength(1);
    const select = component('servers:select:friend', 'friend', 'select', { selected: second });
    emit(select);
    await vi.waitFor(() => expect(select.editReply).toHaveBeenCalled());
    expect(servers.selected('friend')).toBe(second);
    expect(servers.get('default').enabled).toBe(true);
  });
  it('requires administrator access for dropdown server pause controls', async () => {
    const pause = component(`servers:pause:friend:${second}`, 'friend');
    emit(pause);
    await vi.waitFor(() => expect(pause.followUp).toHaveBeenCalled());
    expect(servers.get(second).enabled).toBe(true);
  });
  it('routes device rename modals to the correct server with fresh admin checks', async () => {
    const rename = component(`view:${second}:owner:device:rename:42`);
    emit(rename);
    await vi.waitFor(() => expect(rename.showModal).toHaveBeenCalled());
    const save = component(`view:${second}:owner:device:rename-save:42`, 'owner', 'modal', {
      name: 'Roof lights',
    });
    emit(save);
    await vi.waitFor(() => expect(save.editReply).toHaveBeenCalled());
    expect(servers.store(second).device('42').name).toBe('Roof lights');
    expect(store.device('42').name).toBe('Main lights');
    const denied = component(`view:${second}:friend:device:remove-confirm:42`, 'friend');
    emit(denied);
    await vi.waitFor(() => expect(denied.editReply).toHaveBeenCalled());
    expect(servers.store(second).devices()).toHaveLength(1);
  });
  it('asks for removal confirmation and supports self unlink after role revocation', async () => {
    const remove = component(`view:${second}:owner:device:remove:42`);
    emit(remove);
    await vi.waitFor(() => expect(remove.editReply).toHaveBeenCalled());
    expect(output(remove)).toContain('Confirm removal');
    expect(servers.store(second).devices()).toHaveLength(1);
    const confirm = component(`view:${second}:owner:device:remove-confirm:42`);
    emit(confirm);
    await vi.waitFor(() => expect(confirm.editReply).toHaveBeenCalled());
    expect(servers.store(second).devices()).toHaveLength(0);
    servers.link(second, 'friend', { playerId: secondPairing.playerId, playerToken: '456' });
    role = [];
    const unlink = component('pairui:unlink:friend:none:0', 'friend');
    emit(unlink);
    await vi.waitFor(() => expect(unlink.reply).toHaveBeenCalled());
    expect(servers.identity(second, 'friend')).toBeDefined();
    const revoke = component('pairui:unlink-confirm:friend:none:0', 'friend');
    emit(revoke);
    await vi.waitFor(() => expect(revoke.editReply).toHaveBeenCalled());
    expect(servers.identity(second, 'friend')).toBeUndefined();
  });
});

describe('slash-command server picker', () => {
  async function picker(request: ReturnType<typeof command>) {
    emit(request);
    await vi.waitFor(() => expect(output(request)).toContain('command-server:'));
    return output(request).match(/command-server:[a-f0-9]+/)![0];
  }
  it("keeps chat options and waits for an explicit choice even in another server's channel", async () => {
    store.set('chatEnabled', true);
    const request = command('chat', 'setup', { channel: 'main-chat' }, 'owner', 'main-chat');
    const id = await picker(request);
    expect(output(request)).toContain('Main');
    expect(output(request)).toContain('Second');
    expect(request.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(servers.store(second).get('chatChannel', '')).toBe('second-chat');
    const select = component(id, 'owner', 'select', { selected: second });
    emit(select);
    await vi.waitFor(() => expect(output(select)).toContain('Team chat'));
    expect(servers.store(second).get('chatChannel', '')).toBe('main-chat');
    expect(store.get('chatChannel', '')).toBe('');
    expect(store.get('chatEnabled', true)).toBe(false);
    expect(servers.selected('owner')).toBe('default'); // A command choice does not change the user's default.
    expect(request.deferReply).toHaveBeenCalledOnce();
    expect(select.deferUpdate).toHaveBeenCalledOnce();
  });
  it('supports settings, devices, alarms, panels and status through the existing handlers', async () => {
    servers.store(second).add({ id: '77', type: 'alarm', name: 'Outer wall' });
    const panel = vi.spyOn(Panel.prototype, 'create').mockResolvedValue(undefined);
    const simulated = vi.spyOn(Alerts.prototype, 'send').mockResolvedValue(undefined);
    const cases: [string, string, Record<string, string>][] = [
      ['settings', 'alerts', { channel: 'shared-alerts' }],
      ['device', 'rename', { id: '42', name: 'Workshop' }],
      ['alarm', 'disable', { id: '77' }],
      ['alarm', 'test', { id: '77' }],
      ['device', 'list', {}],
      ['panel', '', {}],
      ['status', '', {}],
      ['ping', '', {}],
      ['pair', 'status', {}],
    ];
    for (const [name, sub, values] of cases) {
      const id = await picker(command(name, sub, values));
      const select = component(id, 'owner', 'select', { selected: second });
      emit(select);
      await vi.waitFor(() => expect(select.editReply.mock.calls.length).toBeGreaterThan(1));
      expect(output(select)).not.toContain('Request failed');
      expect(output(select)).not.toContain('request failed');
    }
    expect(servers.store(second).get('alertChannel', '')).toBe('shared-alerts');
    expect(store.get('alertChannel', '')).toBe('');
    expect(servers.store(second).device('42').name).toBe('Workshop');
    expect(store.device('42').name).toBe('Main lights');
    expect(servers.store(second).device('77').enabled).toBe(false);
    expect(panel).toHaveBeenCalledWith('general');
    expect(simulated).toHaveBeenCalledWith(expect.objectContaining({ id: '77' }), true);
  });
  it('lets /server use, pause and resume work without typing an ID, including paused servers', async () => {
    const use = component(await picker(command('server', 'use')), 'owner', 'select', {
      selected: second,
    });
    emit(use);
    await vi.waitFor(() => expect(output(use)).toContain('Server selected'));
    expect(servers.selected('owner')).toBe(second);
    const pause = component(await picker(command('server', 'pause')), 'owner', 'select', {
      selected: second,
    });
    emit(pause);
    await vi.waitFor(() => expect(output(pause)).toContain('Server updated'));
    expect(servers.get(second).enabled).toBe(false);
    const resumeRequest = command('server', 'resume');
    const resume = component(await picker(resumeRequest), 'owner', 'select', { selected: second });
    expect(output(resumeRequest)).toContain('Paused');
    emit(resume);
    await vi.waitFor(() => expect(output(resume)).toContain('Server updated'));
    expect(servers.get(second).enabled).toBe(true);
    expect(servers.get('default').enabled).toBe(true);
    const useCommand = commands.find((c) => c.name === 'server')!;
    expect(JSON.stringify(useCommand.options?.find((o) => o.name === 'use'))).not.toContain(
      '"required":true',
    );
  });
  it("rejects other users, another guild and forged choices without consuming the owner's selection", async () => {
    const id = await picker(command('settings', 'alerts', { channel: 'alerts' }));
    const wrongUser = component(id, 'friend', 'select', { selected: second });
    emit(wrongUser);
    await vi.waitFor(() => expect(wrongUser.reply).toHaveBeenCalled());
    const wrongGuild = component(id, 'owner', 'select', { selected: second });
    wrongGuild.guildId = 'other-guild';
    emit(wrongGuild);
    await vi.waitFor(() => expect(wrongGuild.reply).toHaveBeenCalled());
    const forged = component(id, 'owner', 'select', { selected: 'not-a-server' });
    emit(forged);
    await vi.waitFor(() => expect(forged.reply).toHaveBeenCalled());
    expect(servers.store(second).get('alertChannel', '')).toBe('');
    const valid = component(id, 'owner', 'select', { selected: second });
    emit(valid);
    await vi.waitFor(() => expect(output(valid)).toContain('Alerts configured'));
  });
  it('rechecks permissions after selection and filters operator choices per server', async () => {
    servers.store(second).set('allowedRoles', ['other-role']);
    const request = command('server', 'use', {}, 'friend');
    const id = await picker(request);
    expect(output(request)).toContain('Main');
    expect(output(request)).not.toContain('Second');
    role = [];
    const revoked = component(id, 'friend', 'select', { selected: 'default' });
    emit(revoked);
    await vi.waitFor(() => expect(output(revoked)).toContain('operator role'));
    const denied = command('settings', 'alerts', { channel: 'alerts' }, 'friend');
    emit(denied);
    await vi.waitFor(() => expect(output(denied)).toContain('Administrator'));
    expect(output(denied)).not.toContain('command-server:');
    const adminId = await picker(command('chat', 'setup', { channel: 'alerts' }));
    config.ADMIN_USER_ID = 'different-admin';
    const lostAdmin = component(adminId, 'owner', 'select', { selected: second });
    emit(lostAdmin);
    await vi.waitFor(() => expect(output(lostAdmin)).toContain('Administrator'));
    expect(servers.store(second).get('chatChannel', '')).toBe('second-chat');
  });
  it('consumes a selection once, supports cancellation and rejects expired or restarted prompts', async () => {
    const simulated = vi.spyOn(Alerts.prototype, 'send').mockResolvedValue(undefined);
    servers.store(second).add({ id: '77', type: 'alarm', name: 'Outer wall' });
    const id = await picker(command('alarm', 'test', { id: '77' }));
    const first = component(id, 'owner', 'select', { selected: second });
    const duplicate = component(id, 'owner', 'select', { selected: second });
    emit(first);
    emit(duplicate);
    await vi.waitFor(() => expect(simulated).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(duplicate.reply).toHaveBeenCalled());
    const cancelId = await picker(command('settings', 'alerts', { channel: 'alerts' }));
    const cancel = component(cancelId.replace('command-server:', 'command-cancel:'));
    emit(cancel);
    await vi.waitFor(() => expect(output(cancel)).toContain('Command cancelled'));
    expect(servers.store(second).get('alertChannel', '')).toBe('');
    const expiredId = await picker(command('settings', 'alerts', { channel: 'alerts' }));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
    const expired = component(expiredId, 'owner', 'select', { selected: second });
    emit(expired);
    await vi.waitFor(() => expect(expired.reply).toHaveBeenCalled());
    expect(JSON.stringify(expired.reply.mock.calls)).toContain('expired');
    const unknown = component('command-server:previous-process-token', 'owner', 'select', {
      selected: second,
    });
    emit(unknown);
    await vi.waitFor(() => expect(unknown.reply).toHaveBeenCalled());
    expect(simulated).toHaveBeenCalledOnce();
  });
  it('keeps explicit IDs and global commands direct, and bounds pending prompts', async () => {
    const explicit = command('settings', 'alerts', { channel: 'alerts', server: second });
    emit(explicit);
    await vi.waitFor(() => expect(output(explicit)).toContain('Alerts configured'));
    expect(output(explicit)).not.toContain('command-server:');
    for (const [name, sub] of [
      ['help', ''],
      ['pair', 'status'],
    ]) {
      const request = command(name, sub, { server: second });
      emit(request);
      await vi.waitFor(() => expect(request.editReply).toHaveBeenCalled());
      expect(output(request)).not.toContain('command-server:');
    }
    for (let i = 0; i < 5; i++) await picker(command('status', ''));
    const full = command('status', '');
    emit(full);
    await vi.waitFor(() => expect(output(full)).toContain('previous server selections'));
  });
  it('runs directly for a single saved server', async () => {
    store.set('serverProfiles', [servers.get('default')]);
    const request = command('settings', 'alerts', { channel: 'single-alerts' });
    emit(request);
    await vi.waitFor(() => expect(output(request)).toContain('Alerts configured'));
    expect(store.get('alertChannel', '')).toBe('single-alerts');
    expect(output(request)).not.toContain('command-server:');
  });
  it('allows another server panel in the same channel and preserves actionable failure responses', async () => {
    const panel = vi.spyOn(Panel.prototype, 'create').mockResolvedValue(undefined);
    const id = await picker(command('panel', '', {}, 'owner', 'main-panel-channel'));
    const selection = component(id, 'owner', 'select', { selected: second });
    emit(selection);
    await vi.waitFor(() => expect(output(selection)).toContain('Panel created or refreshed'));
    expect(panel).toHaveBeenCalledWith('main-panel-channel');
    servers.store(second).add({ id: '77', name: 'Outer wall', type: 'alarm' });
    vi.spyOn(Alerts.prototype, 'send').mockRejectedValue(
      new AlertDeliveryError('ALERT_MISSING_PERMISSIONS'),
    );
    const alarm = component(
      await picker(command('alarm', 'test', { id: '77' })),
      'owner',
      'select',
      { selected: second },
    );
    emit(alarm);
    await vi.waitFor(() => expect(output(alarm)).toContain('Send Messages and Embed Links'));
    expect(output(alarm)).not.toContain('Simulated notification sent');
  });
  it('renames through the picker and updates live display names without reconnecting or changing registrations', async () => {
    const sessions = (host as unknown as { sessions: Map<string, { bot: Bot; rust: Connection }> })
      .sessions;
    const session = sessions.get(second)!;
    const credentials = servers.connectionConfig(second);
    const panelId = servers.store(second).get('panel', null);
    const start = vi.spyOn(session.rust, 'start');
    const stop = vi.spyOn(session.rust, 'stop');
    const schedule = vi.spyOn(session.bot.panel, 'schedule').mockImplementation(() => {});
    const select = component(
      await picker(command('server', 'rename', { name: '  Trio Vanilla  ' })),
      'owner',
      'select',
      { selected: second },
    );
    emit(select);
    await vi.waitFor(() => expect(output(select)).toContain('Server renamed'));
    expect(servers.get(second).name).toBe('Trio Vanilla');
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledOnce();
    expect(servers.store(second).get('panel', null)).toEqual(panelId);
    expect(servers.store(second).device('42').name).toBe('Second lights');
    expect(servers.connectionConfig(second)).toEqual({ ...credentials, BASE_NAME: 'Trio Vanilla' });
    expect(JSON.stringify(session.bot.management.view('status', 'owner'))).toContain(
      'Trio Vanilla',
    );
    const send = vi.fn(async () => ({}));
    vi.spyOn(host.client.channels, 'fetch').mockResolvedValue({
      isTextBased: () => true,
      send,
    } as never);
    servers.store(second).set('alertChannel', 'alerts');
    await session.bot.alerts.send(
      { id: '77', name: 'Test sensor', type: 'alarm', enabled: true, sensitive: false },
      true,
    );
    expect(JSON.stringify(send.mock.calls)).toContain('Trio Vanilla');
    expect(JSON.stringify(send.mock.calls)).not.toContain('Second');
  });
  it('restricts renaming to administrators and validates names, including paused servers', async () => {
    const denied = command('server', 'rename', { server: second, name: 'Nope' }, 'friend');
    emit(denied);
    await vi.waitFor(() => expect(output(denied)).toContain('Administrator'));
    for (const name of ['   ', 'a'.repeat(81), 'Bad\nName']) {
      const invalid = command('server', 'rename', { server: second, name });
      emit(invalid);
      await vi.waitFor(() => expect(output(invalid)).toContain('1–80 characters'));
    }
    expect(servers.get(second).name).toBe('Second');
    servers.enable(second, false);
    const rename = command('server', 'rename', { server: second, name: 'Paused Duo' });
    emit(rename);
    await vi.waitFor(() => expect(output(rename)).toContain('Server renamed'));
    expect(servers.get(second).enabled).toBe(false);
    expect(servers.get(second).name).toBe('Paused Duo');
  });
});
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
    store.set('panel', { channelId: 'shared-panels', messageId: 'main-panel' });
    servers.store(second).set('panel', { channelId: 'shared-panels', messageId: 'second-panel' });
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
    const secondControl = Object.assign(command('', ''), {
      channelId: 'shared-panels',
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: 'switch:on:42',
      message: { id: 'second-panel' },
    });
    emit(secondControl);
    await vi.waitFor(() => expect(output(secondControl)).toContain('Switch state confirmed'));
    expect(output(secondControl)).toContain('Second lights');
    expect(output(secondControl)).not.toContain('Main lights');
    expect(control).toHaveBeenCalledTimes(2);
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
  it('transfers an occupied chat channel and disables its former server bridge', async () => {
    store.set('chatEnabled', true);
    const setup = command('chat', 'setup', { server: second, channel: 'main-chat' });
    emit(setup);
    await vi.waitFor(() => expect(setup.editReply).toHaveBeenCalled());
    expect(output(setup)).not.toContain('different Discord');
    expect(servers.store(second).get('chatChannel', '')).toBe('main-chat');
    expect(servers.store(second).get('chatEnabled', false)).toBe(true);
    expect(store.get('chatChannel', '')).toBe('');
    expect(store.get('chatEnabled', true)).toBe(false);
    const reenable = command('chat', 'enable', { server: 'default' });
    emit(reenable);
    await vi.waitFor(() => expect(reenable.editReply).toHaveBeenCalled());
    expect(output(reenable)).toContain('setup first');
  });
  it('does not allow an operator to override a channel without administrator permission', async () => {
    const setup = command('chat', 'setup', { server: second, channel: 'main-chat' }, 'friend');
    emit(setup);
    await vi.waitFor(() => expect(setup.editReply).toHaveBeenCalled());
    expect(output(setup)).toContain('administrator');
    expect(store.get('chatChannel', '')).toBe('main-chat');
    expect(servers.store(second).get('chatChannel', '')).toBe('second-chat');
  });
  it('allows two servers to configure the same alert channel independently', async () => {
    const main = command('settings', 'alerts', { server: 'default', channel: 'shared-alerts' });
    const other = command('settings', 'alerts', { server: second, channel: 'shared-alerts' });
    emit(main);
    emit(other);
    await vi.waitFor(() => expect(main.editReply).toHaveBeenCalled());
    await vi.waitFor(() => expect(other.editReply).toHaveBeenCalled());
    expect(store.get('alertChannel', '')).toBe('shared-alerts');
    expect(servers.store(second).get('alertChannel', '')).toBe('shared-alerts');
  });
  it('serializes competing chat overrides so only one server owns the channel', async () => {
    const main = command('chat', 'setup', { server: 'default', channel: 'shared-chat' });
    const other = command('chat', 'setup', { server: second, channel: 'shared-chat' });
    emit(main);
    emit(other);
    await vi.waitFor(() => expect(main.editReply).toHaveBeenCalled());
    await vi.waitFor(() => expect(other.editReply).toHaveBeenCalled());
    const owners = servers
      .list()
      .filter(
        (profile) => servers.store(profile.id).get<string>('chatChannel', '') === 'shared-chat',
      );
    expect(owners).toHaveLength(1);
    expect(
      servers.list().filter((profile) => servers.store(profile.id).get('chatEnabled', false)),
    ).toHaveLength(1);
  });
  it('routes FCM death reports only to the matching server with an accepted personal identity', async () => {
    const listeners: PairingListener[] = [];
    vi.spyOn(PairingListener.prototype, 'connect').mockImplementation(function (
      this: PairingListener,
    ) {
      listeners.push(this);
      return Promise.resolve();
    });
    const notify = vi.spyOn(PlayerActivity.prototype, 'death').mockReturnValue(true);
    servers.link(second, 'friend', { playerId: '76561198000000002', playerToken: '789' });
    const code = host.pairing.challenge('friend');
    host.pairing.import('friend', encryptPairing(code, { androidId: '123', securityToken: '456' }));
    const listener = listeners[0];
    const wire = (ip: string, port: number, id: string) => ({
      persistentId: id,
      appData: [
        { key: 'channelId', value: 'player' },
        { key: 'title', value: 'You died' },
        {
          key: 'body',
          value: JSON.stringify({ type: 'death', ip, port, targetId: '76561198000000009' }),
        },
      ],
    });
    listener._onDataMessage(wire(secondPairing.ip, secondPairing.port, 'second-death'));
    expect(notify).toHaveBeenCalledWith(
      'friend',
      '76561198000000002',
      expect.objectContaining({ title: 'You died' }),
    );
    listener._onDataMessage(wire(config.RUST_SERVER_IP, config.RUST_APP_PORT, 'not-linked'));
    listener._onDataMessage(wire('unknown.example.org', 1234, 'unknown-server'));
    servers.enable(second, false);
    listener._onDataMessage(wire(secondPairing.ip, secondPairing.port, 'paused-server'));
    expect(notify).toHaveBeenCalledOnce();
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
