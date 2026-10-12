import {
  Client,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
  REST,
  Routes,
  escapeMarkdown,
  type Interaction,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { randomBytes } from 'node:crypto';
import type { Config } from '../config';
import { Permissions, type Principal } from '../permissions';
import { Bot, UserError, type CommandInput } from './bot';
import { commands } from './commands';
import { Servers } from '../servers';
import { Connection, RustFailure } from '../rust/connection';
import { ChatIdentities } from '../chat-identities';
import { PairingService } from '../pairing/service';
import { log, errorCode } from '../log';
import { PairingWeb } from '../pairing/web';
import {
  button,
  card,
  inboxView,
  pairingModal,
  pairingStatus,
  serversView,
  commandServerPicker,
} from './ui';
import type { DeathPush } from '../pairing/schema';
import { Cameras } from '../cameras/service';
import { CameraWeb } from '../cameras/web';
import { CameraError } from '../cameras/registry';
import { CameraPanel } from './camera-panel';
import { deleteServerPanels } from './server-panels';
import type { Store } from '../database';

type HostComponent = ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction;

interface ServerSession {
  bot: Bot;
  rust: Connection;
  identities: ChatIdentities;
}
interface PendingCommand {
  input: CommandInput;
  owner: string;
  guildId: string;
  serverIds: string[];
  expires: number;
}
export class DiscordHost {
  readonly client: Client = Bot.createClient();
  readonly pairing: PairingService;
  readonly cameras: Cameras;
  private web?: PairingWeb;
  private sessions = new Map<string, ServerSession>();
  private cameraPanels = new Map<string, CameraPanel>();
  private tasks = new Set<Promise<unknown>>();
  private lifecycle: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private queued = 0;
  private pendingCommands = new Map<string, PendingCommand>();
  private removing = new Set<string>();
  private pendingRemovals = new Map<
    string,
    {
      owner: string;
      guildId: string;
      server: string;
      expires: number;
      store: Store;
    }
  >();
  constructor(
    private config: Config,
    readonly servers: Servers,
  ) {
    this.pairing = new PairingService(servers.root, servers.vault, (owner, event) =>
      this.death(owner, event),
    );
    this.cameras = new Cameras(
      servers,
      (id) => this.sessions.get(id)?.rust,
      async (id, user) => {
        const guild = await this.client.guilds.fetch(this.config.DISCORD_GUILD_ID);
        const member = await guild.members.fetch({ user, force: true });
        this.permissions(id, {
          id: member.id,
          guildId: guild.id,
          administrator: member.permissions.has('Administrator'),
          roles: [...member.roles.cache.keys()],
        });
      },
    );
    if (config.PAIRING_WEB_URL) {
      const cameraWeb = new CameraWeb(config.PAIRING_WEB_URL, this.cameras);
      this.web = new PairingWeb(
        config.PAIRING_WEB_URL,
        (code) => this.pairing.isChallengeActive(code),
        undefined,
        (request, response) => cameraWeb.handle(request, response),
      );
    }
    for (const profile of servers.list()) {
      this.cameraPanel(profile.id);
      if (profile.enabled) this.create(profile.id);
    }
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
      for (const panel of this.cameraPanels.values()) panel.schedule();
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
    this.cameraPanel(id);
    rust.on('status', () => this.cameraPanels.get(id)?.schedule());
    const identities = new ChatIdentities(this.servers, id, rust);
    const bot = new Bot(config, store, rust, {
      client: this.client,
      id,
      sender: identities,
      label: this.servers.get(id).name,
      configureChatChannel: (channel) => this.configureChatChannel(id, channel),
    });
    const session = { bot, rust, identities };
    this.sessions.set(id, session);
    return session;
  }
  private cameraPanel(id: string): CameraPanel {
    if (this.removing.has(id)) throw new HostError('This server is being removed.');
    let panel = this.cameraPanels.get(id);
    if (!panel) {
      panel = new CameraPanel(
        this.client,
        this.servers.store(id),
        id,
        () => this.cameras.registry(id).list(),
        () => ({
          name: this.servers.get(id).name,
          state: this.sessions.get(id)?.rust.state || 'paused',
          online: this.sessions.get(id)?.rust.online || false,
        }),
      );
      this.cameraPanels.set(id, panel);
    }
    return panel;
  }
  private configureChatChannel(id: string, channel: string): Promise<void> {
    return this.serialize(async () => {
      this.servers.get(id);
      const affected = [id];
      for (const profile of this.servers.list()) {
        if (profile.id === id) continue;
        const store = this.servers.store(profile.id);
        if (store.get('chatChannel', '') !== channel) continue;
        store.set('chatEnabled', false);
        store.set('chatChannel', '');
        affected.push(profile.id);
      }
      this.servers.store(id).set('chatChannel', channel);
      this.servers.store(id).set('chatEnabled', true);
      // reset() invalidates queued sends immediately, before its first await.
      await Promise.all(affected.map((server) => this.sessions.get(server)?.bot.chat.reset()));
    });
  }
  private death(owner: string, event: DeathPush): void {
    if (this.stopping) return;
    const profile = this.servers.match(event.ip, event.port);
    if (!profile?.enabled) return;
    const identity = this.servers.identity(profile.id, owner);
    if (!identity) return; // Only accepted personal pairings may report to this server.
    this.sessions.get(profile.id)?.bot.activity.death(owner, identity.playerId, event);
  }
  private async restart(id: string): Promise<void> {
    this.cameras.pause(id);
    const previous = this.sessions.get(id);
    this.sessions.delete(id);
    if (previous) {
      previous.identities.stop();
      await previous.bot.stop(true);
    }
    if (!this.stopping && this.servers.get(id).enabled) this.create(id).bot.startServices();
    this.cameraPanels.get(id)?.schedule();
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.queued >= 50)
      return Promise.reject(new HostError('Too many pending changes. Try again shortly.'));
    this.queued++;
    const task = this.lifecycle
      .catch(() => {})
      .then(() => {
        if (this.stopping) throw new HostError('Bot is shutting down.');
        return work();
      })
      .finally(() => {
        this.queued--;
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
      this.cameras.start();
      for (const { bot } of this.sessions.values()) bot.startServices();
    });
    await this.client.login(this.config.DISCORD_TOKEN);
    if (this.web) {
      await this.web.start(this.config.PAIRING_WEB_PORT, this.config.PAIRING_WEB_HOST);
      log.info({ port: this.web.port }, 'Pairing website listening behind reverse proxy');
    }
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
  private async principal(
    interaction: ChatInputCommandInteraction | HostComponent,
  ): Promise<Principal> {
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
    if (this.removing.has(id)) throw new HostError('This server is being removed.');
    if (id && !this.servers.list().some((p) => p.id === id))
      throw new HostError('This server was removed. Run /server list.');
    const permissions = new Permissions(
      this.config.DISCORD_GUILD_ID,
      this.config.ADMIN_USER_ID,
      () =>
        id
          ? this.servers.store(id).get<string[]>('allowedRoles', this.config.ALLOWED_ROLE_IDS)
          : this.config.ALLOWED_ROLE_IDS,
    );
    if (!(admin ? permissions.admin(principal) : permissions.operate(principal)))
      throw new HostError(
        admin ? 'Administrator access is required.' : 'An allowed operator role is required.',
      );
  }
  private commandAccess(input: CommandInput): 'admin' | 'operator' | 'member' {
    const name = input.commandName;
    if (['panel', 'device', 'alarm', 'settings'].includes(name)) return 'admin';
    if (name === 'camera') {
      const sub = input.options.getSubcommand();
      if (sub === 'share' && input.options.getBoolean('enabled') === false) return 'member';
      return ['add', 'remove', 'panel'].includes(sub) ? 'admin' : 'operator';
    }
    if (name === 'chat' && input.options.getSubcommand() !== 'status') return 'admin';
    if (name === 'server') return input.options.getSubcommand() === 'use' ? 'operator' : 'admin';
    return name === 'pair' ? 'operator' : 'member';
  }
  private checkCommandAccess(input: CommandInput, id: string, principal: Principal): void {
    const access = this.commandAccess(input);
    if (access !== 'member') this.permissions(id, principal, access === 'admin');
  }
  private needsServerPicker(interaction: ChatInputCommandInteraction): boolean {
    if (interaction.options.getString('server') || this.servers.list().length < 2) return false;
    const name = interaction.commandName;
    if (name === 'server')
      return (
        ['use', 'pause', 'resume', 'rename', 'remove'].includes(
          interaction.options.getSubcommand(),
        ) && !interaction.options.getString('id')
      );
    if (name === 'pair') return interaction.options.getSubcommand() === 'status';
    return ['panel', 'device', 'alarm', 'chat', 'settings', 'status', 'ping', 'camera'].includes(
      name,
    );
  }
  private async showServerPicker(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const principal = await this.principal(interaction);
    const input: CommandInput = {
      commandName: interaction.commandName,
      options: interaction.options,
      channelId: interaction.channelId,
    };
    const profiles = this.servers.list().filter((profile) => {
      try {
        this.checkCommandAccess(input, profile.id, principal);
        return true;
      } catch {
        return false;
      }
    });
    if (!profiles.length)
      throw new HostError(
        this.commandAccess(input) === 'admin'
          ? 'Administrator access is required.'
          : 'An allowed operator role is required.',
      );
    for (const [key, pending] of this.pendingCommands)
      if (pending.expires <= Date.now()) this.pendingCommands.delete(key);
    if (this.pendingCommands.size >= 200)
      throw new HostError('Too many pending server selections. Try again in a few minutes.');
    if ([...this.pendingCommands.values()].filter((p) => p.owner === principal.id).length >= 5)
      throw new HostError(
        'Finish or cancel your previous server selections first. They expire after five minutes.',
      );
    const token = randomBytes(12).toString('hex');
    this.pendingCommands.set(token, {
      input,
      owner: principal.id,
      guildId: this.config.DISCORD_GUILD_ID,
      serverIds: profiles.map((p) => p.id),
      expires: Date.now() + 5 * 60000,
    });
    try {
      const sub = interaction.options.getSubcommand(false);
      await interaction.editReply(
        commandServerPicker(token, profiles, `/${input.commandName}${sub ? ` ${sub}` : ''}`),
      );
    } catch (error) {
      this.pendingCommands.delete(token);
      throw error;
    }
  }
  private sessionForCommand(id: string): ServerSession {
    const session = this.sessions.get(id);
    if (!session) throw new HostError('Server is paused. Use /server resume.');
    return session;
  }
  private async selectCommandServer(
    interaction: StringSelectMenuInteraction | ButtonInteraction,
  ): Promise<void> {
    try {
      const [prefix, token] = interaction.customId.split(':');
      const pending = this.pendingCommands.get(token);
      if (!pending || pending.expires <= Date.now()) {
        this.pendingCommands.delete(token);
        throw new HostError(
          'This selection expired or was already used. Run the slash command again.',
        );
      }
      if (pending.owner !== interaction.user.id || pending.guildId !== interaction.guildId)
        throw new HostError(
          'This private selection belongs to another Discord member. Run your own command.',
        );
      const id =
        interaction.isStringSelectMenu() && interaction.values.length === 1
          ? interaction.values[0]
          : '';
      if (prefix !== 'command-cancel' && !pending.serverIds.includes(id))
        throw new HostError('Choose one of the servers in this menu.');
      this.pendingCommands.delete(token); // Consume before any await: double submissions cannot execute twice.
      await interaction.deferUpdate();
      await interaction.editReply({
        embeds: [
          card('Running command…', 'Checking access and applying your saved command options.'),
        ],
        components: [],
      });
      if (prefix === 'command-cancel') {
        await interaction.editReply({
          embeds: [card('Command cancelled', 'No changes were made.')],
          components: [],
        });
        return;
      }
      const principal = await this.principal(interaction);
      this.checkCommandAccess(pending.input, id, principal);
      if (pending.input.commandName === 'server')
        await this.serverAction(pending.input, interaction, id, principal);
      else if (pending.input.commandName === 'pair')
        await interaction.editReply(pairingStatus(this.pairing, this.servers, id, principal.id));
      else if (pending.input.commandName === 'camera')
        await this.cameraAction(pending.input, interaction, id, principal);
      else if (interaction.isStringSelectMenu())
        await this.sessionForCommand(id).bot.executeSelectedCommand(pending.input, interaction);
    } catch (error) {
      log.warn({ code: errorCode(error) }, 'Server selection failed');
      const content =
        error instanceof UserError || error instanceof RustFailure || error instanceof CameraError
          ? error.message
          : 'The command failed. Run it again and check permissions and logs.';
      if (interaction.deferred || interaction.replied)
        await interaction.editReply({
          embeds: [card('Request failed', content)],
          components: [],
          allowedMentions: { parse: [] },
        });
      else
        await interaction.reply({
          content,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
    }
  }
  private async serverAction(
    input: CommandInput,
    response: Pick<ChatInputCommandInteraction, 'editReply'>,
    id: string,
    principal: Principal,
  ): Promise<void> {
    const sub = input.options.getSubcommand();
    this.permissions(id, principal, sub !== 'use');
    if (sub === 'use') {
      this.servers.select(principal.id, id);
      await response.editReply({
        embeds: [
          card(
            'Server selected',
            `**${escapeMarkdown(this.servers.get(id).name)}**\nDefault saved. Server-specific slash commands still let you choose before running. Other servers keep running.`,
          ),
        ],
        components: [],
        allowedMentions: { parse: [] },
      });
    } else if (sub === 'remove') {
      await this.confirmRemoval(response, id, principal);
    } else if (sub === 'rename') {
      const profile = await this.serialize(async () => {
        let renamed;
        try {
          renamed = this.servers.rename(id, input.options.getString('name', true));
        } catch (error) {
          throw new HostError(error instanceof Error ? error.message : 'Invalid server name.');
        }
        this.sessions.get(id)?.bot.setServerName(renamed.name);
        this.cameraPanels.get(id)?.schedule();
        return renamed;
      });
      await response.editReply({
        embeds: [
          card(
            'Server renamed',
            `**${escapeMarkdown(profile.name)}**\nSaved. Panels and future alerts use this name.`,
            profile.name,
          ),
        ],
        components: [],
        allowedMentions: { parse: [] },
      });
    } else {
      await this.serialize(async () => {
        this.servers.enable(id, sub === 'resume');
        await this.restart(id);
      });
      await response.editReply({
        embeds: [
          card(
            'Server updated',
            `**${escapeMarkdown(this.servers.get(id).name)}**: ${sub === 'resume' ? 'connecting' : 'paused'}.`,
          ),
        ],
        components: [],
        allowedMentions: { parse: [] },
      });
    }
  }
  private async confirmRemoval(
    response: Pick<ChatInputCommandInteraction, 'editReply'>,
    id: string,
    principal: Principal,
  ): Promise<void> {
    this.permissions(id, principal, true);
    const profile = this.servers.get(id);
    for (const [key, pending] of this.pendingRemovals)
      if (pending.expires <= Date.now()) this.pendingRemovals.delete(key);
    if (this.pendingRemovals.size >= 200)
      throw new HostError('Too many pending confirmations. Try again in a few minutes.');
    const token = randomBytes(12).toString('hex');
    this.pendingRemovals.set(token, {
      owner: principal.id,
      guildId: this.config.DISCORD_GUILD_ID,
      server: id,
      expires: Date.now() + 5 * 60000,
      store: this.servers.store(id),
    });
    try {
      await response.editReply({
        embeds: [
          card(
            'Remove this server?',
            `**${escapeMarkdown(profile.name)}**\n\nThis permanently removes its bot configuration, devices, cameras and personal server links. Monitoring and camera viewers will stop, and its base and camera panels will be deleted.\n\nExisting Discord chat and alert messages stay. Other servers and your pairing listener stay configured. You can add the server again by pairing.\n\nConfirm within **5 minutes**.`,
            profile.name,
          ),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            button(
              `remove-server:${token}:confirm`,
              'Permanently remove server',
              ButtonStyle.Danger,
            ),
            button(`remove-server:${token}:cancel`, 'Cancel'),
          ),
        ],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      this.pendingRemovals.delete(token);
      throw error;
    }
  }
  private async removalControl(interaction: ButtonInteraction): Promise<void> {
    try {
      const [, token, action] = interaction.customId.split(':');
      const pending = this.pendingRemovals.get(token);
      if (!pending || pending.expires <= Date.now()) {
        this.pendingRemovals.delete(token);
        throw new HostError(
          'This confirmation expired or was already used. Run /server remove again.',
        );
      }
      if (pending.owner !== interaction.user.id || pending.guildId !== interaction.guildId)
        throw new HostError('This private confirmation belongs to another Discord member.');
      if (!['confirm', 'cancel'].includes(action)) throw new HostError('Invalid confirmation.');
      this.pendingRemovals.delete(token); // One use, even if two clicks arrive together.
      await interaction.deferUpdate();
      if (action === 'cancel') {
        await interaction.editReply({
          embeds: [card('Removal cancelled', 'The server was kept.')],
          components: [],
        });
        return;
      }
      const principal = await this.principal(interaction);
      this.permissions(pending.server, principal, true);
      await interaction.editReply({
        embeds: [card('Removing server…', 'Stopping its connections and deleting its panels.')],
        components: [],
      });
      const name = await this.serialize(async () => {
        const id = pending.server;
        const profile = this.servers.get(id);
        if (this.servers.store(id) !== pending.store)
          throw new HostError(
            'This server has been removed and paired again. Run /server remove again.',
          );
        this.removing.add(id);
        try {
          this.servers.enable(id, false); // Persist first: a restart cannot resurrect monitoring.
          this.cameras.pause(id);
          const session = this.sessions.get(id);
          this.sessions.delete(id);
          const cameraPanel = this.cameraPanels.get(id);
          cameraPanel?.stop();
          this.cameraPanels.delete(id);
          session?.identities.stop();
          await Promise.all([session?.bot.stop(), cameraPanel?.drain()]);
          try {
            await deleteServerPanels(this.client, this.servers.store(id));
          } catch (error) {
            log.warn({ server: id, code: errorCode(error) }, 'Server panel deletion failed');
            throw new HostError(
              'Panel deletion failed. The server is paused and its configuration is kept. Restore the bot’s View Channel and Read Message History permissions in its panel channels, check Discord connectivity, then retry /server remove. Already deleted panels stay deleted.',
            );
          }
          this.servers.remove(id);
          for (const [key, removal] of this.pendingRemovals)
            if (removal.server === id) this.pendingRemovals.delete(key);
          for (const [key, command] of this.pendingCommands) {
            command.serverIds = command.serverIds.filter((server) => server !== id);
            if (!command.serverIds.length) this.pendingCommands.delete(key);
          }
          return profile.name;
        } finally {
          this.removing.delete(id);
        }
      });
      await interaction.editReply({
        embeds: [
          card(
            'Server removed',
            `**${escapeMarkdown(name)}** and its saved panels were removed. Existing Discord chat and alert messages were kept. Pair again to add it back.`,
          ),
        ],
        components: [],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      log.warn({ code: errorCode(error) }, 'Server removal failed');
      const content =
        error instanceof HostError
          ? error.message
          : 'Server removal failed. Check logs and retry /server remove.';
      if (interaction.deferred || interaction.replied)
        await interaction.editReply({
          embeds: [card('Request failed', content)],
          components: [],
          allowedMentions: { parse: [] },
        });
      else
        await interaction.reply({
          content,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
    }
  }
  private async reply(
    interaction: ChatInputCommandInteraction,
    title: string,
    description: string,
    downloadUrl?: string,
  ): Promise<void> {
    await interaction.editReply({
      embeds: [card(title, description)],
      allowedMentions: { parse: [] },
      components: downloadUrl
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setLabel('Download Windows pairing helper')
                .setStyle(ButtonStyle.Link)
                .setURL(downloadUrl),
            ),
          ]
        : [],
    });
  }
  private async interaction(interaction: Interaction): Promise<void> {
    if (interaction.isButton() && interaction.customId.startsWith('remove-server:')) {
      await this.removalControl(interaction);
      return;
    }
    if (
      (interaction.isStringSelectMenu?.() || interaction.isButton()) &&
      interaction.customId.startsWith('campanel:')
    ) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const [, server, action] = interaction.customId.split(':');
        const principal = await this.principal(interaction);
        this.permissions(server, principal);
        const panel = this.cameraPanel(server);
        if (!panel.isPanel(interaction.message.id, interaction.channelId))
          throw new CameraError(
            'This camera panel is inactive. Use the current panel or /camera panel.',
          );
        if (
          action === 'watch' &&
          interaction.isStringSelectMenu() &&
          interaction.values.length === 1
        ) {
          await this.cameraLink(interaction, server, principal.id, interaction.values[0]);
        } else if (action === 'refresh' && interaction.isButton()) {
          await panel.refresh();
          await interaction.editReply({
            content: 'Camera panel refreshed.',
            allowedMentions: { parse: [] },
          });
        } else if (action === 'stop' && interaction.isButton()) {
          this.cameras.stopFor(server, principal.id, false);
          await interaction.editReply({
            content: 'Your viewer and sessions borrowing your account were stopped.',
            allowedMentions: { parse: [] },
          });
        } else throw new CameraError('Choose a camera or button from the current panel.');
      } catch (error) {
        await interaction.editReply({
          content:
            error instanceof CameraError || error instanceof UserError
              ? error.message
              : 'Camera request failed. Check permissions and try again.',
          allowedMentions: { parse: [] },
        });
      }
      return;
    }
    if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith('camera-watch:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const [, server, owner] = interaction.customId.split(':');
        if (owner !== interaction.user.id || interaction.values.length !== 1)
          throw new CameraError('Open your own /camera list menu.');
        const principal = await this.principal(interaction);
        this.permissions(server, principal);
        await this.cameraLink(interaction, server, principal.id, interaction.values[0]);
      } catch (error) {
        await interaction.editReply({
          content:
            error instanceof CameraError || error instanceof UserError
              ? error.message
              : 'Camera request failed. Check permissions and try again.',
          allowedMentions: { parse: [] },
        });
      }
      return;
    }
    if (
      (interaction.isStringSelectMenu?.() || interaction.isButton()) &&
      (interaction.customId.startsWith('command-server:') ||
        interaction.customId.startsWith('command-cancel:'))
    ) {
      await this.selectCommandServer(interaction);
      return;
    }
    if (
      (interaction.isButton() ||
        interaction.isModalSubmit?.() ||
        interaction.isStringSelectMenu?.()) &&
      (interaction.customId.startsWith('pairui:') || interaction.customId.startsWith('servers:'))
    ) {
      await this.component(interaction);
      return;
    }
    if (
      (interaction.isButton() ||
        interaction.isModalSubmit?.() ||
        interaction.isStringSelectMenu?.()) &&
      interaction.customId.startsWith('view:')
    ) {
      const session = this.sessions.get(interaction.customId.split(':')[1]);
      if (session?.bot.management.owns(interaction.customId)) session.bot.dispatch(interaction);
      else
        await interaction.reply({
          content: 'This server is paused. Use /server resume.',
          flags: MessageFlags.Ephemeral,
        });
      return;
    }
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
      if (this.needsServerPicker(interaction)) {
        await this.showServerPicker(interaction);
        return;
      }
      const id = this.selected(interaction);
      if (!id && !['server', 'pair'].includes(interaction.commandName)) {
        await interaction.reply({
          embeds: [
            card(
              'No saved Rust servers',
              'Use `/pair start`, pair the server in-game, then accept it in `/pair inbox`.',
            ),
          ],
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (interaction.commandName === 'camera') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.cameraAction(interaction, interaction, id, await this.principal(interaction));
        return;
      }
      if (!['server', 'pair'].includes(interaction.commandName)) {
        this.sessionForCommand(id).bot.dispatch(interaction);
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const principal = await this.principal(interaction);
      const sub = interaction.options.getSubcommand();
      if (interaction.commandName === 'pair' && sub === 'unlink') {
        // Guild members can always revoke their own credentials after losing roles.
      } else if (interaction.commandName === 'pair' || sub === 'list') {
        this.operatorSomewhere(principal);
      } else if (sub !== 'use') this.permissions(id, principal);
      if (interaction.commandName === 'server') {
        if (sub === 'list') {
          await interaction.editReply(this.serverView(principal.id));
        } else {
          if (!id) throw new HostError('No saved servers. Use /pair start to add one.');
          await this.serverAction(
            interaction,
            interaction,
            sub === 'use' ? interaction.options.getString('id') || id : id,
            principal,
          );
        }
        return;
      }
      if (sub === 'start') {
        const code = this.pairing.challenge(principal.id);
        if (this.config.PAIRING_WEB_URL) {
          await interaction.editReply({
            embeds: [
              card(
                '🔗 Link your Rust+ account',
                '1. Open the pairing website below.\n2. Install its small **Chrome / Edge extension** once, then refresh the page. No desktop app or terminal is needed.\n3. Start Steam sign-in **from the website**. Read and approve Facepunch’s official warning yourself. The extension returns the login to the same website tab.\n4. Click **Create Discord command**, then copy and paste the encrypted command here.\n\nYour link expires in **15 minutes**. After importing, wait for `/pair status` to show **listening**, pair in-game and open `/pair inbox`. Never paste a raw Rust+ token into Discord.',
              ),
            ],
            components: [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setLabel('Open pairing website')
                  .setStyle(ButtonStyle.Link)
                  .setURL(
                    `${new URL(this.config.PAIRING_WEB_URL).origin}/#code=${encodeURIComponent(code)}`,
                  ),
              ),
            ],
            allowedMentions: { parse: [] },
          });
          return;
        }
        await this.reply(
          interaction,
          'Link Rust+ from your PC',
          (this.config.PAIRING_HELPER_URL
            ? '1. Download the Windows helper using the button below. **Extract all** files from the ZIP.\n'
            : '1. Ask the server owner for the **Windows pairing helper ZIP** and extract all files. The owner has not configured a download link yet.\n') +
            '2. Double-click **RustPlus Pairing.cmd**. No Node.js installation or project download is needed. Google Chrome must be installed.\n' +
            '3. Paste this code into the helper and click **Link account**:\n' +
            `\`\`\`\n${code}\n\`\`\`\n` +
            '4. Sign in through Steam in the Chrome window. Click **Copy Discord command** in the helper, then paste it here.\n\n' +
            'This code expires in **15 minutes**. Wait for `/pair status` to show **listening**, pair your server/devices in-game, then use `/pair inbox`. You can close the helper afterward. Never paste a Steam password or raw pairing file into Discord.',
          this.config.PAIRING_HELPER_URL,
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
        await interaction.editReply(inboxView(this.pairing, principal.id));
      } else if (sub === 'accept') {
        const result = await this.acceptPairing(
          principal,
          id,
          interaction.options.getString('id', true),
          interaction.options.getString('name') || undefined,
          interaction.options.getBoolean('sensitive') ?? false,
        );
        await this.reply(interaction, result.title, result.description);
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
        await interaction.editReply(pairingStatus(this.pairing, this.servers, id, principal.id));
      }
    } catch (error) {
      log.warn({ code: errorCode(error) }, 'Server/pairing command failed');
      const safe =
        error instanceof HostError || error instanceof RustFailure || error instanceof CameraError
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
  private serverView(user: string) {
    return serversView(this.servers, user, (id) => this.sessions.get(id)?.rust.state || 'paused');
  }
  private async cameraLink(
    response: Pick<ChatInputCommandInteraction, 'editReply'>,
    server: string,
    viewer: string,
    camera: string,
  ): Promise<void> {
    if (!this.config.PAIRING_WEB_URL)
      throw new CameraError(
        'The bot owner must configure the existing HTTPS pairing website (PAIRING_WEB_URL) to use cameras.',
      );
    const token = this.cameras.issue(server, viewer, camera);
    await response.editReply({
      embeds: [
        card(
          '📷 Camera viewer',
          'Open this private link within **2 minutes**. Viewing lasts up to **10 minutes**. Your own offline account is preferred; another teammate’s account is used only with their explicit sharing consent.\n\nManual movement only. No firing, autopilot or player tracking. Rust enforces camera access and range restrictions. Keep this link private.',
          this.servers.get(server).name,
        ),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setLabel('Open camera viewer')
            .setStyle(ButtonStyle.Link)
            .setURL(`${new URL(this.config.PAIRING_WEB_URL).origin}/camera#ticket=${token}`),
        ),
      ],
      allowedMentions: { parse: [] },
    });
  }
  private async cameraAction(
    input: CommandInput,
    response: Pick<ChatInputCommandInteraction, 'editReply'>,
    server: string,
    principal: Principal,
  ): Promise<void> {
    this.checkCommandAccess(input, server, principal);
    const sub = input.options.getSubcommand(),
      registry = this.cameras.registry(server);
    if (sub === 'watch' && input.options.getString('id')) {
      await this.cameraLink(response, server, principal.id, input.options.getString('id', true));
      return;
    }
    let description: string;
    if (sub === 'panel') {
      if (!input.channelId) throw new CameraError('Run /camera panel in a guild text channel.');
      await this.cameraPanel(server).create(input.channelId);
      description =
        'Camera panel created or refreshed in this channel. Select a camera there to receive your private viewer link.';
    } else if (sub === 'add') {
      registry.add({
        id: input.options.getString('id', true),
        name: input.options.getString('name', true),
      });
      description =
        'Camera registered. Use /camera watch to view it. Camera identifiers are configured in-game; Smart Device pairing/entity IDs are separate.';
      this.cameraPanel(server).schedule();
    } else if (sub === 'remove') {
      registry.remove(input.options.getString('id', true));
      this.cameras.pause(server);
      description = 'Camera removed. Any viewer on this server was closed.';
      this.cameraPanel(server).schedule();
    } else if (sub === 'share') {
      const enabled = input.options.getBoolean('enabled', true);
      this.cameras.share(server, principal.id, enabled);
      description = enabled
        ? 'You consented to operators on this Discord server viewing and manually moving registered cameras through **your** paired Rust account, only while it is offline and alive. This is limited to this Rust server. Revoke with /camera share enabled:false or /pair unlink.'
        : 'Your camera sharing consent was revoked. Related viewers were closed immediately.';
    } else if (sub === 'stop') {
      const admin = new Permissions(
        this.config.DISCORD_GUILD_ID,
        this.config.ADMIN_USER_ID,
        () => [],
      ).admin(principal);
      this.cameras.stopFor(server, principal.id, admin);
      description = admin
        ? 'Camera viewing stopped for this server.'
        : 'Your camera viewing and sessions borrowing your account were stopped.';
    } else {
      const cameras = registry.list();
      await response.editReply({
        embeds: [
          card(
            '📷 Rust+ Cameras',
            cameras.length
              ? cameras
                  .map((c) => `**${escapeMarkdown(c.name)}** · ${escapeMarkdown(c.id)}`)
                  .join('\n')
              : 'No cameras registered. An administrator can use /camera add with the identifier configured in-game.',
            this.servers.get(server).name,
          ),
        ],
        components: cameras.length
          ? [
              new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                  .setCustomId(`camera-watch:${server}:${principal.id}`)
                  .setPlaceholder('Choose a camera to watch')
                  .addOptions(cameras.map((c) => ({ label: c.name, value: c.id }))),
              ),
            ]
          : [],
        allowedMentions: { parse: [] },
      });
      return;
    }
    await response.editReply({
      embeds: [card('📷 Cameras', description, this.servers.get(server).name)],
      components: [],
      allowedMentions: { parse: [] },
    });
  }
  private operatorSomewhere(principal: Principal): void {
    if (!this.servers.list().length) {
      this.permissions('', principal);
      return;
    }
    for (const profile of this.servers.list()) {
      try {
        this.permissions(profile.id, principal);
        return;
      } catch {
        /* check next profile */
      }
    }
    throw new HostError('An allowed operator role is required.');
  }
  private async unlink(principal: Principal): Promise<void> {
    await this.serialize(async () => {
      this.cameras.revoke(principal.id);
      for (const profile of this.servers.list())
        this.servers.store(profile.id).set(`cameraShare:${principal.id}`, false);
      for (const session of this.sessions.values()) session.identities.drop(principal.id);
      this.pairing.unlink(principal.id);
      this.servers.unlink(principal.id);
    });
  }
  private async component(interaction: HostComponent): Promise<void> {
    try {
      const [prefix, action, owner, target, rawPage] = interaction.customId.split(':');
      if (owner !== interaction.user.id || interaction.guildId !== this.config.DISCORD_GUILD_ID)
        throw new HostError(
          'This private control belongs to another Discord member. Open your own slash command.',
        );
      if (!['accept', 'unlink'].includes(action) || !interaction.isButton()) {
        if (interaction.isModalSubmit() && !interaction.isFromMessage())
          throw new HostError('Reopen /pair inbox to accept this pairing.');
        await interaction.deferUpdate();
      }
      const principal = await this.principal(interaction);
      if (!['unlink', 'unlink-confirm', 'unlink-cancel'].includes(action))
        this.operatorSomewhere(principal);
      if (prefix === 'servers') {
        if (action === 'select' && interaction.isStringSelectMenu()) {
          const id = interaction.values[0];
          this.permissions(id, principal);
          this.servers.select(principal.id, id);
        } else if (action === 'remove' && interaction.isButton()) {
          await this.confirmRemoval(interaction, target, principal);
          return;
        } else if (['pause', 'resume'].includes(action) && interaction.isButton()) {
          this.permissions(target, principal, true);
          await this.serialize(async () => {
            this.servers.enable(target, action === 'resume');
            await this.restart(target);
          });
        } else if (action !== 'refresh') throw new HostError('Unknown server control.');
        await interaction.editReply(this.serverView(owner));
        return;
      }
      const page = Number(rawPage);
      if (!Number.isInteger(page) || page < -1 || page > 13)
        throw new HostError('Invalid inbox page.');
      if (action === 'accept' && interaction.isButton()) {
        const pairing = this.pairing.take(owner, target);
        const profile = this.servers.match(pairing.ip, pairing.port);
        if (pairing.type === 'entity' || !profile)
          this.permissions(profile?.id || this.servers.selected(owner), principal, true);
        else this.permissions(profile.id, principal);
        await interaction.showModal(pairingModal(owner, target, page, pairing));
        return;
      }
      if (action === 'save' && interaction.isModalSubmit()) {
        const name = interaction.fields.getTextInputValue('name').trim();
        if (!name || name.length > 60) throw new HostError('Name must contain 1–60 characters.');
        const pairing = this.pairing.take(owner, target);
        let sensitive = false;
        if (pairing.type === 'entity' && pairing.entityType === 1) {
          const value = interaction.fields.getTextInputValue('sensitive').trim().toLowerCase();
          if (!['yes', 'no'].includes(value))
            throw new HostError('Enter yes or no for destructive equipment.');
          sensitive = value === 'yes';
        }
        const result = await this.acceptPairing(
          principal,
          this.servers.selected(owner),
          target,
          name,
          sensitive,
        );
        await interaction.editReply(
          inboxView(this.pairing, owner, page, `✅ **${result.title}**\n${result.description}`),
        );
      } else if (action === 'decline' && interaction.isButton()) {
        this.pairing.take(owner, target);
        this.pairing.acknowledge(owner, target);
        await interaction.editReply(
          inboxView(
            this.pairing,
            owner,
            page,
            'Pairing declined. You can pair again in-game at any time.',
          ),
        );
      } else if (action === 'inbox') {
        await interaction.editReply(inboxView(this.pairing, owner, page));
      } else if (action === 'unlink' && interaction.isButton()) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [
            card(
              'Unlink your personal account?',
              'This removes your pairing listener and personal chat credentials for all servers. Shared monitoring stays configured.',
            ),
          ],
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              button(
                `pairui:unlink-confirm:${owner}:none:0`,
                'Unlink my account',
                ButtonStyle.Danger,
              ),
              button(`pairui:unlink-cancel:${owner}:none:0`, 'Cancel'),
            ),
          ],
          allowedMentions: { parse: [] },
        });
      } else if (action === 'unlink-confirm') {
        await this.unlink(principal);
        await interaction.editReply({
          embeds: [
            card(
              'Personal account unlinked',
              'Your pairing listener and personal chat credentials were removed. Link again with `/pair start`.',
            ),
          ],
          components: [],
        });
      } else if (action === 'unlink-cancel') {
        await interaction.editReply({
          embeds: [card('Unlink cancelled', 'Your personal account is still linked.')],
          components: [],
        });
      } else throw new HostError('Unknown pairing control.');
    } catch (error) {
      log.warn({ code: errorCode(error) }, 'Pairing/server control failed');
      const safe =
        error instanceof UserError || error instanceof RustFailure
          ? error.message
          : 'This pairing could not be processed. Reopen /pair inbox and check permissions.';
      if (interaction.deferred || interaction.replied)
        await interaction.followUp({
          content: safe,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      else
        await interaction.reply({
          content: safe,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
    }
  }
  private acceptPairing(
    principal: Principal,
    selected: string,
    pendingId: string,
    name?: string,
    sensitive = false,
  ): Promise<{ title: string; description: string }> {
    return this.serialize(async () => {
      let pairing;
      try {
        pairing = this.pairing.take(principal.id, pendingId);
      } catch (error) {
        throw new HostError(error instanceof Error ? error.message : 'Pairing not found.');
      }
      let profile = this.servers.match(pairing.ip, pairing.port);
      if (pairing.type === 'server') {
        if (!profile) {
          this.permissions(selected, principal, true);
          profile = this.servers.add(pairing, name || undefined);
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
          this.servers.add(pairing, name || undefined);
          await this.restart(profile.id);
        }
        if (!this.sessions.has(profile.id) && profile.enabled)
          this.create(profile.id).bot.startServices();
        this.sessions.get(profile.id)?.identities.drop(principal.id);
        this.servers.select(principal.id, profile.id);
        this.pairing.acknowledge(principal.id, pendingId);
        return {
          title: 'Server pairing saved',
          description: `**${escapeMarkdown(profile.name)}** • \`${profile.id}\`\nYour personal Steam identity is linked for this server. Chat verifies team membership before sending. For a new server, run /settings alerts, /chat setup and /panel, then choose its name in the server menu.`,
        };
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
              name ||
              pairing.entityName ||
              (type === 'switch' ? 'Smart Switch' : 'Smart Alarm')
            ).slice(0, 60),
            sensitive: sensitive,
          });
        else {
          if (name) store.rename(pairing.entityId, name);
          // Re-pairing must never silently remove a safety confirmation.
          if (sensitive && type === 'switch') store.markSensitive(pairing.entityId);
        }
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
        return {
          title: 'Device paired',
          description: `**${escapeMarkdown(store.device(pairing.entityId).name)}** on **${escapeMarkdown(profile.name)}**\n${verified ? 'Saved and verified with Rust+.' : 'Saved; verification/subscription will retry when the server is connected.'} No device was activated.`,
        };
      }
    });
  }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const panel of this.cameraPanels.values()) panel.stop();
    this.pendingCommands.clear();
    this.pendingRemovals.clear();
    this.cameras.stop();
    await this.web?.stop();
    this.pairing.stop();
    for (const { identities } of this.sessions.values()) identities.stop();
    const stops = [...this.sessions.values()].map(({ bot }) => bot.stop());
    await Promise.allSettled([this.lifecycle, ...this.tasks, ...stops]);
    await Promise.all([...this.cameraPanels.values()].map((panel) => panel.drain()));
    this.cameraPanels.clear();
    this.sessions.clear();
    await this.client.destroy();
  }
}
export class HostError extends UserError {}
