import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Events, type Interaction } from 'discord.js';
import { Store } from '../src/database';
import { Bot } from '../src/discord/bot';
import type { Connection } from '../src/rust/connection';
import type { Config } from '../src/config';

let store: Store;
let bot: Bot;
let setSwitch: ReturnType<typeof vi.fn>;
let roles: string[];
function button(customId: string, user = 'friend', messageId = 'saved-panel') {
  const interaction = {
    customId,
    user: { id: user },
    guildId: 'guild',
    message: { id: messageId },
    deferred: false,
    isChatInputCommand: () => false,
    isButton: () => true,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async (payload: unknown) => {
      void payload;
      return {};
    }),
    reply: vi.fn(async () => ({})),
  };
  return interaction;
}
function emit(interaction: ReturnType<typeof button>) {
  bot.client.emit(Events.InteractionCreate, interaction as unknown as Interaction);
}
beforeEach(() => {
  store = new Store(':memory:');
  store.add({ id: '1', name: 'Lights', type: 'switch' });
  store.add({ id: '2', name: 'Explosives', type: 'switch' });
  store.add({ id: '3', name: 'Garage', type: 'switch' });
  store.set('panel', { channelId: 'channel', messageId: 'saved-panel', page: 0 });
  roles = ['operator'];
  setSwitch = vi.fn(async () => false);
  const rust = Object.assign(new EventEmitter(), {
    state: 'connected',
    online: true,
    unavailableDevices: [],
    setSwitch,
    queryDevice: vi.fn(async () => false),
    refreshHealth: vi.fn(),
    stop: vi.fn(),
  });
  bot = new Bot(
    {
      DISCORD_GUILD_ID: 'guild',
      ADMIN_USER_ID: 'owner',
      ALLOWED_ROLE_IDS: ['operator'],
      ALARM_COOLDOWN_SECONDS: 60,
    } as Config,
    store,
    rust as unknown as Connection,
  );
  vi.spyOn(bot.client.guilds, 'fetch').mockResolvedValue({
    id: 'guild',
    members: {
      fetch: vi.fn(async ({ user }: { user: string }) => ({
        id: user,
        permissions: { has: () => false },
        roles: { cache: new Map(roles.map((r) => [r, {}])) },
      })),
    },
  } as never);
});
afterEach(async () => {
  await bot.stop();
  store.close();
  vi.restoreAllMocks();
});

describe('server-side persistent button authorization', () => {
  it('rejects unauthorized users, forged entity IDs and inactive panels', async () => {
    roles = [];
    const denied = button('switch:on:1');
    emit(denied);
    await vi.waitFor(() => expect(denied.editReply).toHaveBeenCalled());
    expect(setSwitch).not.toHaveBeenCalled();
    roles = ['operator'];
    const unknown = button('switch:on:999');
    const stale = button('switch:on:1', 'friend', 'old-panel');
    emit(unknown);
    emit(stale);
    await vi.waitFor(() => expect(stale.editReply).toHaveBeenCalled());
    expect(setSwitch).not.toHaveBeenCalled();
  });
  it('requires a user-bound confirmation and fetches permissions again on confirmation', async () => {
    const first = button('switch:on:2');
    emit(first);
    await vi.waitFor(() => expect(first.editReply).toHaveBeenCalled());
    expect(setSwitch).not.toHaveBeenCalled();
    const payload = first.editReply.mock.calls[0][0] as {
      components: { toJSON(): { components: { custom_id: string }[] } }[];
    };
    const id = payload.components[0].toJSON().components[0].custom_id;
    const stolen = button(id, 'stranger');
    emit(stolen);
    await vi.waitFor(() => expect(stolen.editReply).toHaveBeenCalled());
    expect(setSwitch).not.toHaveBeenCalled();
    roles = [];
    const revoked = button(id);
    emit(revoked);
    await vi.waitFor(() => expect(revoked.editReply).toHaveBeenCalled());
    expect(setSwitch).not.toHaveBeenCalled();
    roles = ['operator'];
    const valid = button(id);
    emit(valid);
    await vi.waitFor(() => expect(setSwitch).toHaveBeenCalledOnce());
    expect(setSwitch).toHaveBeenCalledWith('2', true);
    const replay = button(id);
    emit(replay);
    await vi.waitFor(() => expect(replay.editReply).toHaveBeenCalled());
    expect(setSwitch).toHaveBeenCalledOnce();
  });
  it('reserves a switch lock before awaiting Discord progress; other switches work independently', async () => {
    let finish!: (value: boolean) => void;
    setSwitch.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    let progress!: () => void;
    const first = button('switch:on:1');
    first.editReply.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          progress = () => resolve({});
        }),
    );
    emit(first);
    await vi.waitFor(() => expect(first.editReply).toHaveBeenCalledOnce());
    expect(setSwitch).toHaveBeenCalledOnce();
    const repeated = button('switch:off:1');
    const independent = button('switch:on:3');
    emit(repeated);
    emit(independent);
    await vi.waitFor(() => expect(independent.editReply).toHaveBeenCalledTimes(2));
    expect(setSwitch.mock.calls).toEqual([
      ['1', true],
      ['3', true],
    ]);
    progress();
    finish(false);
    await vi.waitFor(() => expect(first.editReply).toHaveBeenCalledTimes(2));
    const payload = first.editReply.mock.calls[1][0] as {
      embeds: { toJSON(): { title: string; description: string } }[];
    };
    expect(payload.embeds[0].toJSON().description).toContain('OFF');
    expect(payload.embeds[0].toJSON().description).toContain('differs');
  });
  it('clears cached state and never reports success when a write fails', async () => {
    bot.devices.states.set('1', false);
    setSwitch.mockRejectedValueOnce(new Error('uncertain write'));
    const interaction = button('switch:on:1');
    emit(interaction);
    await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledTimes(2));
    const payload = interaction.editReply.mock.calls[1][0] as {
      embeds: { toJSON(): { title: string } }[];
    };
    expect(payload.embeds[0].toJSON().title).toBe('Request failed');
    expect(bot.devices.states.has('1')).toBe(false);
  });
  it('rejects expired sensitive confirmations', async () => {
    const first = button('switch:off:2');
    emit(first);
    await vi.waitFor(() => expect(first.editReply).toHaveBeenCalled());
    const payload = first.editReply.mock.calls[0][0] as {
      components: { toJSON(): { components: { custom_id: string }[] } }[];
    };
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000);
    const expired = button(payload.components[0].toJSON().components[0].custom_id);
    emit(expired);
    await vi.waitFor(() => expect(expired.editReply).toHaveBeenCalled());
    expect(setSwitch).not.toHaveBeenCalled();
  });
});
