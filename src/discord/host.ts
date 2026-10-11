import {
  Client,
  Events,
  EmbedBuilder,
  MessageFlags,
  REST,
  Routes,
  escapeMarkdown,
  type Interaction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Config } from '../config';
import { Permissions, type Principal } from '../permissions';
import { Bot, UserError } from './bot';
import { commands } from './commands';
import { Servers } from '../servers';
import { Connection, RustFailure } from '../rust/connection';
import { ChatIdentities } from '../chat-identities';
import { PairingService } from '../pairing/service';
import { log, errorCode } from '../log';

interface ServerSession {
  bot: Bot;
  rust: Connection;
  identities: ChatIdentities;
}
export class DiscordHost {
  readonly client: Client = Bot.createClient();
  readonly pairing: PairingService;
  private sessions = new Map<string, ServerSession>();
  private tasks = new Set<Promise<unknown>>();
  private lifecycle: Promise<unknown> = Promise.resolve();
  private stopping = false;
  constructor(
    private config: Config,
    readonly servers: Servers,
  ) {
    this.pairing = new PairingService(servers.root, servers.vault);
    for (const profile of servers.list()) if (profile.enabled) this.create(profile.id);
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!this.stopping) this.track(this.interaction(interaction));
    });
    this.client.on(Events.MessageCreate, (message) => {
      if (this.stopping) return;
      for (const session of this.sessions.values())
        if (session.bot.chat.channelId === message.channelId)
          this.track(session.bot.chat.fromDiscord(message));
    });
    this.client.on(Events.Error, (error) =>
      log.error({ code: errorCode(error) }, 'Discord client error'),
    );
    this.client.on(Events.Warn, () => log.warn('Discord client warning'));
    this.client.on(Events.ShardDisconnect, () =>
      log.warn('Discord disconnected; gateway will reconnect'),
    );
    const resume = () => {
      for (const { bot } of this.sessions.values()) {
        bot.panel.schedule();
        bot.alerts.wake();
      }
    };
    this.client.on(Events.ShardReady, resume);
    this.client.on(Events.ShardResume, resume);
  }
  private track(task: Promise<unknown>): void {
    this.tasks.add(task);
    void task
      .catch((error) => log.warn({ code: errorCode(error) }, 'Discord host operation failed'))
      .finally(() => this.tasks.delete(task));
  }
  private create(id: string): ServerSession {
    const store = this.servers.store(id),
      config = this.servers.connectionConfig(id);
    const rust = new Connection(config, () => store.devices(), undefined, 800, id);
    const identities = new ChatIdentities(this.servers, id, rust);
    const bot = new Bot(config, store, rust, {
      client: this.client,
      sender: identities,
      label: this.servers.get(id).name,
      validateChatChannel: (channel) => {
        if (
          this.servers
            .list()
            .some((p) => p.id !== id && this.servers.store(p.id).get('chatChannel', '') === channel)
        )
          throw new HostError('Each Rust server needs a different Discord team-chat channel.');
      },
    });
    const session = { bot, rust, identities };
    this.sessions.set(id, session);
    return session;
  }
  private async restart(id: string): Promise<void> {
    const previous = this.sessions.get(id);
    this.sessions.delete(id);
    if (previous) {
      previous.identities.stop();
      await previous.bot.stop(true);
    }
    if (!this.stopping && this.servers.get(id).enabled) this.create(id).bot.startServices();
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const task = this.lifecycle
      .catch(() => {})
      .then(() => {
        if (this.stopping) throw new HostError('Bot is shutting down.');
        return work();
      });
    this.lifecycle = task;
    return task;
  }
  async start(): Promise<void> {
    await new REST({ version: '10', timeout: 10000, retries: 2 })
      .setToken(this.config.DISCORD_TOKEN)
      .put(
        Routes.applicationGuildCommands(
          this.config.DISCORD_CLIENT_ID,
          this.config.DISCORD_GUILD_ID,
        ),
        { body: commands },
      );
    this.client.once(Events.ClientReady, () => {
      log.info('Discord ready');
      this.pairing.start();
      for (const { bot } of this.sessions.values()) bot.startServices();
    });
    await this.client.login(this.config.DISCORD_TOKEN);
  }
  // Explicit selection wins; channel ownership wins over a person's default.
  selected(interaction: ChatInputCommandInteraction): string {
    const explicit = interaction.options.getString('server');
    if (explicit) {
      this.servers.get(explicit);
      return explicit;
    }
    const channel = this.servers.list().find((p) => {
      const store = this.servers.store(p.id);
      return (
        store.get('chatChannel', '') === interaction.channelId ||
        store.get<{ channelId: string } | null>('panel', null)?.channelId === interaction.channelId
      );
    });
    return channel?.id || this.servers.selected(interaction.user.id);
  }
  private async principal(interaction: ChatInputCommandInteraction): Promise<Principal> {
    if (interaction.guildId !== this.config.DISCORD_GUILD_ID)
      throw new HostError('Wrong Discord server.');
    const guild = await this.client.guilds.fetch(this.config.DISCORD_GUILD_ID);
    const member = await guild.members.fetch({ user: interaction.user.id, force: true });
    return {
      id: member.id,
      guildId: guild.id,
      administrator: member.permissions.has('Administrator'),
      roles: [...member.roles.cache.keys()],
    };
  }
  private permissions(id: string, principal: Principal, admin = false): void {
    const permissions = new Permissions(
      this.config.DISCORD_GUILD_ID,
      this.config.ADMIN_USER_ID,
      () => this.servers.store(id).get<string[]>('allowedRoles', this.config.ALLOWED_ROLE_IDS),
    );
    if (!(admin ? permissions.admin(principal) : permissions.operate(principal)))
      throw new HostError(
        admin ? 'Administrator access is required.' : 'An allowed operator role is required.',
      );
  }
  private async reply(
    interaction: ChatInputCommandInteraction,
    title: string,
    description: string,
  ): Promise<void> {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(title)
          .setDescription(description.slice(0, 4096))
          .setColor(0xce6f3e),
      ],
      allowedMentions: { parse: [] },
    });
  }
  private async interaction(interaction: Interaction): Promise<void> {
    if (interaction.isButton()) {
      const session = [...this.sessions.values()].find(({ bot }) =>
        bot.ownsButton(interaction.customId, interaction.message.id),
      );
      if (session) session.bot.dispatch(interaction);
      else
        await interaction.reply({
          content: 'This panel is inactive or the server is paused. Use /server resume or /panel.',
          flags: MessageFlags.Ephemeral,
        });
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.guildId !== this.config.DISCORD_GUILD_ID)
        throw new HostError('Wrong Discord server.');
      const id = this.selected(interaction);
      if (!['server', 'pair'].includes(interaction.commandName)) {
        if (
          interaction.commandName === 'panel' &&
          this.servers
            .list()
            .some(
              (p) =>
                p.id !== id &&
                this.servers.store(p.id).get<{ channelId: string } | null>('panel', null)
                  ?.channelId === interaction.channelId,
            )
        )
          throw new HostError('Each Rust server needs a different Discord panel channel.');
        const session = this.sessions.get(id);
        if (!session) throw new HostError('Server is paused. Use /server resume.');
        session.bot.dispatch(interaction);
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const principal = await this.principal(interaction);
      const sub = interaction.options.getSubcommand();
      if (interaction.commandName === 'pair' && sub === 'unlink') {
        // Guild members can always revoke their own credentials after losing roles.
      } else if (interaction.commandName === 'pair' || sub === 'list') {
        const authorized = this.servers.list().some((p) => {
          try {
            this.permissions(p.id, principal);
            return true;
          } catch {
            return false;
          }
        });
        if (!authorized) throw new HostError('An allowed operator role is required.');
      } else if (sub !== 'use') this.permissions(id, principal);
      if (interaction.commandName === 'server') {
        if (sub === 'list') {
          await this.reply(
            interaction,
            'Rust servers',
            this.servers
              .list()
              .map(
                (p) =>
                  `**${escapeMarkdown(p.name)}** • \`${p.id}\` • ${this.sessions.get(p.id)?.rust.state || 'paused'}`,
              )
              .join('\n') +
              '\n\nUse `/server use id:…` to select a default for your commands, or the optional `server` argument. Existing panels always control their own server. Add servers via `/pair start`.',
          );
        } else if (sub === 'use') {
          const target = interaction.options.getString('id', true);
          this.permissions(target, principal);
          this.servers.select(principal.id, target);
          await this.reply(
            interaction,
            'Server selected',
            `**${escapeMarkdown(this.servers.get(target).name)}**\nThis is now your default outside server-specific channels. Other servers keep running.`,
          );
        } else {
          this.permissions(id, principal, true);
          await this.serialize(async () => {
            this.servers.enable(id, sub === 'resume');
            await this.restart(id);
          });
          await this.reply(
            interaction,
            'Server updated',
            `**${escapeMarkdown(this.servers.get(id).name)}**: ${sub === 'resume' ? 'connecting' : 'paused'}.`,
          );
        }
        return;
      }
      if (sub === 'start') {
        const code = this.pairing.challenge(principal.id);
        await this.reply(
          interaction,
          'Link Rust+ from your PC',
          'On your own PC, in this project folder, install dependencies (`npm ci`) and run:\n' +
            `\`\`\`\nnpm run pair -- --code ${code}\n\`\`\`\n` +
            'Chrome opens for Steam sign-in if needed. Paste the encrypted `/pair import` command it prints here. This code expires in 15 minutes. Then pair the server/devices in-game and use `/pair inbox`. Never paste a Steam password or a raw pairing file into Discord.',
        );
      } else if (sub === 'import') {
        try {
          this.pairing.import(principal.id, interaction.options.getString('data', true));
        } catch (error) {
          throw new HostError(error instanceof Error ? error.message : 'Pairing import failed.');
        }
        await this.reply(
          interaction,
          'Pairing listener configured',
          'The VPS pairing listener is starting. Close any local fcm-listen process using the same registration. Wait for /pair status to show listening, then pair in-game and run /pair inbox.',
        );
      } else if (sub === 'inbox') {
        const rows = this.pairing.inbox(principal.id).slice(-15);
        await this.reply(
          interaction,
          'Your pairing inbox',
          rows.length
            ? rows
                .map(({ id, pairing }) =>
                  pairing.type === 'server'
                    ? `**${escapeMarkdown(pairing.name)}** • Server • \`${id}\``
                    : `**${escapeMarkdown(pairing.entityName || (pairing.entityType === 1 ? 'Smart Switch' : 'Smart Alarm'))}** • Entity \`${pairing.entityId}\` • \`${id}\``,
                )
                .join('\n') +
                '\n\n`/pair accept id:… name:…` saves the selected pairing. Devices and new monitoring servers require administrator access. Inbox entries expire after 24 hours.'
            : 'No pairings yet. Pair in-game while the VPS listener is running, then try again.',
        );
      } else if (sub === 'accept') {
        await this.serialize(async () => {
          const pendingId = interaction.options.getString('id', true);
          let pairing;
          try {
            pairing = this.pairing.take(principal.id, pendingId);
          } catch (error) {
            throw new HostError(error instanceof Error ? error.message : 'Pairing not found.');
          }
          let profile = this.servers.match(pairing.ip, pairing.port);
          if (pairing.type === 'server') {
            if (!profile) {
              this.permissions(id, principal, true);
              profile = this.servers.add(
                pairing,
                interaction.options.getString('name') || undefined,
              );
            } else this.permissions(profile.id, principal);
            this.servers.link(profile.id, principal.id, {
              playerId: pairing.playerId,
              playerToken: pairing.playerToken,
            });
            // Refresh monitoring credentials only for its existing Steam identity
            // and only when an administrator performs the pairing.
            if (
              this.servers.connectionConfig(profile.id).RUST_STEAM_ID === pairing.playerId &&
              (principal.id === this.config.ADMIN_USER_ID || principal.administrator)
            ) {
              this.servers.add(pairing, interaction.options.getString('name') || undefined);
              await this.restart(profile.id);
            }
            if (!this.sessions.has(profile.id) && profile.enabled)
              this.create(profile.id).bot.startServices();
            this.sessions.get(profile.id)?.identities.drop(principal.id);
            this.servers.select(principal.id, profile.id);
            this.pairing.acknowledge(principal.id, pendingId);
            await this.reply(
              interaction,
              'Server pairing saved',
              `**${escapeMarkdown(profile.name)}** • \`${profile.id}\`\nYour personal Steam identity is linked for this server. Chat verifies team membership before sending. For a new server, configure its own /settings alerts, /chat setup and /panel using the optional server argument.`,
            );
          } else {
            if (!profile)
              throw new HostError('Accept this server pairing first, then pair the device again.');
            this.permissions(profile.id, principal, true);
            const store = this.servers.store(profile.id);
            const existing = store.devices().find((d) => d.id === pairing.entityId);
            const type = pairing.entityType === 1 ? 'switch' : 'alarm';
            if (existing && existing.type !== type)
              throw new HostError(
                'Registered entity type differs. Verify the device and remove the stale registration first.',
              );
            if (!existing)
              store.add({
                id: pairing.entityId,
                type,
                name: (
                  interaction.options.getString('name') ||
                  pairing.entityName ||
                  (type === 'switch' ? 'Smart Switch' : 'Smart Alarm')
                ).slice(0, 60),
                sensitive: interaction.options.getBoolean('sensitive') ?? false,
              });
            const session = this.sessions.get(profile.id);
            let verified = false;
            if (session?.rust.online) {
              try {
                await session.rust.queryDevice(pairing.entityId);
                verified = true;
              } catch {
                /* recovery retries read-only subscription */
              }
            }
            session?.bot.panel.schedule();
            this.pairing.acknowledge(principal.id, pendingId);
            await this.reply(
              interaction,
              'Device paired',
              `**${escapeMarkdown(store.device(pairing.entityId).name)}** on **${escapeMarkdown(profile.name)}**\n${verified ? 'Saved and verified with Rust+.' : 'Saved; verification/subscription will retry when the server is connected.'} No device was activated.`,
            );
          }
        });
      } else if (sub === 'unlink') {
        await this.serialize(async () => {
          for (const session of this.sessions.values()) session.identities.drop(principal.id);
          this.pairing.unlink(principal.id);
          this.servers.unlink(principal.id);
        });
        await this.reply(
          interaction,
          'Personal account unlinked',
          'Your pairing listener and personal chat credentials have been removed. Shared server monitoring remains configured. You can link again with `/pair start`.',
        );
      } else {
        const identity = this.servers.identity(id, principal.id);
        await this.reply(
          interaction,
          'Your Rust+ pairing',
          `**Pairing listener:** ${this.pairing.status(principal.id)}\n**Server:** ${escapeMarkdown(this.servers.get(id).name)}\n**Personal chat identity:** ${identity ? `Steam ${identity.playerId}` : 'Not linked — use /pair start'}\nRust+ must be available and your Steam account must belong to the mirrored team.`,
        );
      }
    } catch (error) {
      log.warn({ code: errorCode(error) }, 'Server/pairing command failed');
      const safe =
        error instanceof HostError || error instanceof RustFailure
          ? error.message
          : 'The operation failed. Check configuration, permissions and logs.';
      if (interaction.deferred || interaction.replied)
        await interaction.editReply({ content: safe, allowedMentions: { parse: [] } });
      else
        await interaction.reply({
          content: safe,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.pairing.stop();
    for (const { identities } of this.sessions.values()) identities.stop();
    const stops = [...this.sessions.values()].map(({ bot }) => bot.stop());
    await Promise.allSettled([this.lifecycle, ...this.tasks, ...stops]);
    this.sessions.clear();
    await this.client.destroy();
  }
}
export class HostError extends UserError {}
