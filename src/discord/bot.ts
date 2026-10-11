import { randomBytes } from 'node:crypto';
import {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  escapeMarkdown,
  type Interaction,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { Config } from '../config';
import type { Store } from '../database';
import type { Connection } from '../rust/connection';
import { RustFailure } from '../rust/connection';
import { Devices } from '../devices';
import { Permissions, type Principal } from '../permissions';
import { ChatBridge } from '../chat';
import { needsConfirmation, deviceSchema } from '../domain';
import { log, errorCode } from '../log';
import { Panel } from './panel';
import { Alerts, AlertDeliveryError } from './alerts';
import { commands } from './commands';
import { ConnectionNotifications } from '../connection-notifications';
import type { ChatSender } from '../chat-identities';
import { card } from './ui';
import { Management, ManagementError } from './management';
import { PlayerActivity } from '../activity';

interface BotRuntime {
  id?: string;
  client: Client;
  sender: ChatSender;
  label: string;
  configureChatChannel: (id: string) => Promise<void>;
}

interface Confirmation {
  user: string;
  id: string;
  action: 'on' | 'off';
  expires: number;
  name: string;
}
export type CommandInput = Pick<
  ChatInputCommandInteraction,
  'commandName' | 'options' | 'channelId'
>;

export class Bot {
  readonly client: Client;
  static createClient(): Client {
    return new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      allowedMentions: { parse: [], repliedUser: false },
      rest: { timeout: 10000, retries: 2 },
    });
  }
  readonly devices: Devices;
  readonly permissions: Permissions;
  readonly panel: Panel;
  readonly chat: ChatBridge;
  readonly alerts: Alerts;
  readonly activity: PlayerActivity;
  readonly management: Management;
  readonly connectionNotifications: ConnectionNotifications;
  private confirmations = new Map<string, Confirmation>();
  private stopping = false;
  private tasks = new Set<Promise<unknown>>();
  private track(task: Promise<unknown>, operation: string): void {
    this.tasks.add(task);
    void task
      .catch((error) => log.warn({ code: errorCode(error), operation }, 'Discord event failed'))
      .finally(() => this.tasks.delete(task));
  }
  constructor(
    private config: Config,
    private store: Store,
    private rust: Connection,
    private runtime?: BotRuntime,
  ) {
    this.client = runtime?.client || Bot.createClient();
    this.permissions = new Permissions(config.DISCORD_GUILD_ID, config.ADMIN_USER_ID, () =>
      store.get('allowedRoles', config.ALLOWED_ROLE_IDS),
    );
    this.devices = new Devices(store, rust, config.ALARM_COOLDOWN_SECONDS);
    this.panel = new Panel(this.client, store, this.devices, runtime?.label);
    this.alerts = new Alerts(this.client, store, config);
    this.activity = new PlayerActivity(rust, store, this.alerts, config);
    this.connectionNotifications = new ConnectionNotifications(rust, store, this.alerts);
    this.chat = new ChatBridge(this.client, rust, store, config, this.permissions, runtime?.sender);
    this.management = new Management(
      runtime?.id || 'default',
      runtime?.label,
      store,
      rust,
      this.devices,
      this.chat,
      this.alerts,
      this.panel,
      this.permissions,
      () => this.connectionNotifications.lastSuccessfulAt ?? undefined,
    );
    this.devices.on('alarm', (device) => this.alerts.enqueue(device));
    this.devices.on('alarmActive', (device) => {
      try {
        this.alerts.recoveredAlarm(device);
      } catch (error) {
        this.alerts.reportFailure(error);
      }
    });
    rust.on('health', () => this.panel.schedule());
    // The multi-server host owns the single Discord event dispatcher/login.
    if (runtime) return;
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!this.stopping) this.track(this.interaction(interaction), 'interaction');
    });
    this.client.on(Events.MessageCreate, (message) => {
      if (!this.stopping) this.track(this.chat.fromDiscord(message), 'chat');
    });
    this.client.on(Events.Error, (error) =>
      log.error({ code: errorCode(error) }, 'Discord client error'),
    );
    this.client.on(Events.Warn, () => log.warn('Discord client warning'));
    this.client.on(Events.ShardDisconnect, () =>
      log.warn('Discord disconnected; gateway will reconnect'),
    );
    this.client.on(Events.ShardResume, () => {
      this.panel.schedule();
      this.alerts.wake();
    });
    this.client.on(Events.ShardReady, () => {
      this.panel.schedule();
      this.alerts.wake();
    });
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
      this.startServices();
    });
    await this.client.login(this.config.DISCORD_TOKEN);
  }
  startServices(): void {
    this.alerts.start();
    this.activity.start();
    this.rust.start();
    this.panel.schedule();
    this.rust.refreshHealth();
  }
  ownsButton(id: string, messageId: string): boolean {
    return (
      this.management.owns(id) ||
      this.panel.isPanel(messageId) ||
      (id.startsWith('confirm:') && this.confirmations.has(id.split(':')[1]))
    );
  }
  dispatch(interaction: Interaction): void {
    if (!this.stopping) this.track(this.interaction(interaction), 'interaction');
  }
  setServerName(name: string): void {
    this.config.BASE_NAME = name;
    if (this.runtime) this.runtime.label = name;
    this.management.setServerName(name);
    this.panel.setServerName(name);
  }
  async executeSelectedCommand(
    input: CommandInput,
    response: StringSelectMenuInteraction,
  ): Promise<void> {
    try {
      if (this.stopping) throw new UserError('Bot is shutting down.');
      await this.command(
        { ...input, editReply: (payload) => response.editReply(payload) },
        await this.principal(response),
      );
    } catch (error) {
      await this.fail(response, error);
    }
  }
  private async principal(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction
      | StringSelectMenuInteraction,
  ): Promise<Principal> {
    if (interaction.guildId !== this.config.DISCORD_GUILD_ID)
      throw new Error('This bot is configured for a different guild.');
    // Fetch fresh role membership, rather than trusting a stale interaction/member cache.
    const guild = await this.client.guilds.fetch(this.config.DISCORD_GUILD_ID);
    const member: GuildMember = await guild.members.fetch({
      user: interaction.user.id,
      force: true,
    });
    return {
      id: member.id,
      guildId: guild.id,
      administrator: member.permissions.has('Administrator'),
      roles: [...member.roles.cache.keys()],
    };
  }
  private embed(title: string, description: string): EmbedBuilder {
    return card(title, description, this.runtime?.label);
  }
  private async interaction(interaction: Interaction): Promise<void> {
    if (
      !interaction.isChatInputCommand() &&
      !interaction.isButton() &&
      !interaction.isModalSubmit?.() &&
      !interaction.isStringSelectMenu?.()
    )
      return;
    try {
      if (!interaction.isChatInputCommand() && this.management.owns(interaction.customId)) {
        if (
          interaction.guildId !== this.config.DISCORD_GUILD_ID ||
          interaction.customId.split(':')[2] !== interaction.user.id
        )
          throw new UserError('Open your own slash command to use this private control.');
        if (interaction.isModalSubmit() && !interaction.isFromMessage())
          throw new UserError('Reopen /device list to rename this device.');
        if (!(interaction.isButton() && interaction.customId.split(':')[4] === 'rename'))
          await interaction.deferUpdate();
        const principal = await this.principal(interaction);
        await this.management.handle(interaction, principal);
        return;
      }
      if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (this.stopping) throw new Error('Bot is shutting down.');
      const principal = await this.principal(interaction);
      if (interaction.isButton()) {
        await this.button(interaction, principal);
        return;
      }
      await this.command(interaction, principal);
    } catch (error) {
      await this.fail(interaction, error);
    }
  }
  private async fail(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ModalSubmitInteraction
      | StringSelectMenuInteraction,
    error: unknown,
  ): Promise<void> {
    const safe =
      error instanceof RustFailure ||
      error instanceof UserError ||
      error instanceof ManagementError ||
      error instanceof AlertDeliveryError
        ? error.message
        : 'The request failed. Check configuration, channel permissions and logs, then retry.';
    log.warn(
      {
        code: errorCode(error),
        operation: interaction.isChatInputCommand() ? interaction.commandName : 'component',
      },
      'Discord operation failed',
    );
    if (interaction.deferred || interaction.replied)
      await interaction.editReply({
        embeds: [this.embed('Request failed', safe)],
        components: [],
      });
    else await interaction.reply({ content: safe, flags: MessageFlags.Ephemeral });
  }
  private requireAdmin(principal: Principal): void {
    if (!this.permissions.admin(principal))
      throw new UserError(
        'Only the configured administrator or a Discord server administrator can do this.',
      );
  }
  private requireOperator(principal: Principal): void {
    if (!this.permissions.operate(principal))
      throw new UserError('You need an allowed operator role to use base controls or team chat.');
  }
  private async button(interaction: ButtonInteraction, principal: Principal): Promise<void> {
    this.requireOperator(principal);
    const [prefix, action, id] = interaction.customId.split(':');
    if (prefix === 'page') {
      if (!this.panel.isPanel(interaction.message.id) || !/^-?\d{1,2}$/.test(action))
        throw new UserError('This panel is no longer active. Use /panel.');
      await this.panel.refresh(Number(action));
      await interaction.editReply({ content: 'Panel updated.' });
      return;
    }
    let entityId = id,
      operation = action;
    for (const [key, confirmation] of this.confirmations)
      if (confirmation.expires < Date.now()) this.confirmations.delete(key);
    if (prefix === 'confirm') {
      const confirmation = this.confirmations.get(action);
      if (!confirmation || confirmation.user !== principal.id || confirmation.expires < Date.now())
        throw new UserError(
          'Confirmation expired or belongs to another user. Press the original control again.',
        );
      this.confirmations.delete(action);
      entityId = confirmation.id;
      operation = confirmation.action;
      if (this.store.device(entityId).name !== confirmation.name)
        throw new UserError('Device changed. Press its control again.');
    } else if (prefix !== 'switch' || !this.panel.isPanel(interaction.message.id))
      throw new UserError('This panel is no longer active. Use /panel.');
    if (
      !['on', 'off', 'refresh'].includes(operation) ||
      !deviceSchema.shape.id.safeParse(entityId).success
    )
      throw new UserError('Invalid control.');
    let device;
    try {
      device = this.store.device(entityId);
    } catch {
      throw new UserError('Device is no longer registered.');
    }
    if (device.type !== 'switch') throw new UserError('This device is not a Smart Switch.');
    if (!this.rust.online) throw new RustFailure('offline');
    if (prefix !== 'confirm' && operation !== 'refresh' && needsConfirmation(device)) {
      if (this.confirmations.size >= 100)
        throw new UserError('Too many pending confirmations. Wait a moment.');
      const nonce = randomBytes(12).toString('hex');
      this.confirmations.set(nonce, {
        user: principal.id,
        id: entityId,
        action: operation as 'on' | 'off',
        expires: Date.now() + 30000,
        name: device.name,
      });
      await interaction.editReply({
        embeds: [
          this.embed(
            '⚠ Confirm sensitive switch operation',
            `Set **${escapeMarkdown(device.name)}** to **${operation.toUpperCase()}**? This may operate destructive equipment. Confirmation expires in 30 seconds.`,
          ),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`confirm:${nonce}`)
              .setLabel(`Confirm ${operation.toUpperCase()}`)
              .setStyle(ButtonStyle.Danger),
          ),
        ],
      });
      return;
    }
    if (this.devices.busy.has(entityId))
      throw new UserError('A request for this switch is already running.');
    // Reserve the per-device lock before the first asynchronous Discord update.
    const work = this.devices.control(entityId, operation as 'on' | 'off' | 'refresh');
    void work.catch(() => {});
    await interaction
      .editReply({
        embeds: [
          this.embed('Updating switch…', `Reading **${escapeMarkdown(device.name)}** from Rust+.`),
        ],
        components: [],
      })
      .catch((error) => log.warn({ code: errorCode(error) }, 'Switch progress response failed'));
    const state = await work;
    await interaction.editReply({
      embeds: [
        this.embed(
          'Switch state confirmed',
          `**${escapeMarkdown(device.name)}** reports **${state ? 'ON' : 'OFF'}**.${operation !== 'refresh' && state !== (operation === 'on') ? '\nThe reported state differs from the requested state. Check the in-game wiring.' : ''}`,
        ),
      ],
    });
  }
  private async command(
    interaction: CommandInput & Pick<ChatInputCommandInteraction, 'editReply'>,
    principal: Principal,
  ): Promise<void> {
    const name = interaction.commandName,
      options = interaction.options;
    const reply = async (title: string, body: string) => {
      await interaction.editReply({ embeds: [this.embed(title, body)] });
    };
    const admin =
      ['panel', 'device', 'alarm', 'settings'].includes(name) ||
      (name === 'chat' && options.getSubcommand() !== 'status');
    if (admin) this.requireAdmin(principal);
    const sub = ['device', 'alarm', 'chat', 'settings'].includes(name)
      ? options.getSubcommand()
      : '';
    if (name === 'panel') {
      await this.panel.create(interaction.channelId);
      await reply(
        'Base control panel',
        'Panel created or refreshed. It will update as switch states change.',
      );
      return;
    }
    if (name === 'device') {
      if (sub === 'list') {
        await interaction.editReply(
          this.management.view('device', principal.id, (options.getInteger('page') ?? 1) - 1),
        );
        return;
      }
      const id = options.getString('id', true);
      if (sub === 'add') {
        let device;
        try {
          device = this.store.add({
            id,
            name: options.getString('name', true),
            type: options.getString('type', true),
            sensitive: options.getBoolean('sensitive') ?? false,
          });
        } catch (error) {
          throw new UserError(error instanceof Error ? error.message : 'Invalid device.');
        }
        let result = 'Saved; device will be verified and subscribed when Rust+ reconnects.';
        if (this.rust.online) {
          try {
            await this.rust.queryDevice(id);
            result = 'Saved and verified with Rust+.';
          } catch {
            result =
              'Saved, but verification failed. Check the server, entity ID, type and pairing. Subscription will retry.';
          }
        }
        this.panel.schedule();
        await reply('Device registered', `**${escapeMarkdown(device.name)}**\n${result}`);
        return;
      }
      let device;
      try {
        device = this.store.device(id);
      } catch {
        throw new UserError('Unknown registered entity ID.');
      }
      if (sub === 'status') {
        const state = await this.rust.queryDevice(id);
        await reply(
          'Device state',
          `**${escapeMarkdown(device.name)}**: **${state ? 'ON / ACTIVE' : 'OFF / INACTIVE'}**`,
        );
        return;
      }
      try {
        if (sub === 'remove') {
          this.store.remove(id);
          this.devices.forget(id);
        }
        if (sub === 'rename') this.store.rename(id, options.getString('name', true));
      } catch (error) {
        throw new UserError(error instanceof Error ? error.message : 'Invalid device.');
      }
      this.panel.schedule();
      await reply('Device updated', `Device ${sub === 'remove' ? 'removed' : 'renamed'}.`);
      return;
    }
    if (name === 'alarm') {
      if (sub === 'list') {
        await interaction.editReply(
          this.management.view('alarm', principal.id, (options.getInteger('page') ?? 1) - 1),
        );
        return;
      }
      const id = options.getString('id', true);
      let device;
      try {
        device = this.store.device(id);
      } catch {
        throw new UserError('Unknown registered entity ID.');
      }
      if (device.type !== 'alarm') throw new UserError('Select a Smart Alarm.');
      if (sub === 'test') {
        await this.alerts.send(device, true);
        await reply('Simulated notification sent', 'No Rust device was triggered.');
        return;
      }
      this.store.enable(id, sub === 'enable');
      this.rust.refreshHealth();
      await reply(
        'Alarm notifications',
        `**${escapeMarkdown(device.name)}**: ${sub === 'enable' ? 'enabled' : 'disabled'}.`,
      );
      return;
    }
    if (name === 'chat') {
      if (sub === 'setup') {
        const channel = options.getChannel('channel', true).id;
        if (this.runtime) await this.runtime.configureChatChannel(channel);
        else {
          this.store.set('chatChannel', channel);
          this.store.set('chatEnabled', true);
        }
      }
      if (sub === 'enable') {
        if (!this.chat.channelId) throw new UserError('Run /chat setup first.');
        this.store.set('chatEnabled', true);
      }
      if (sub === 'disable') this.store.set('chatEnabled', false);
      if (sub !== 'status' && !(sub === 'setup' && this.runtime)) await this.chat.reset();
      await interaction.editReply(this.management.view('chat', principal.id));
      return;
    }
    if (name === 'settings') {
      const roles = this.store.get<string[]>('allowedRoles', this.config.ALLOWED_ROLE_IDS);
      if (sub === 'alerts') {
        this.store.set('alertChannel', options.getChannel('channel', true).id);
        this.store.set('alertRole', options.getRole('role')?.id || '');
        this.alerts.wake();
        await reply('Alerts configured', 'Use /alarm test to check notification delivery.');
        return;
      }
      if (sub === 'role-add' || sub === 'role-remove') {
        const role = options.getRole('role', true);
        if (sub === 'role-add' && role.id === this.config.DISCORD_GUILD_ID)
          throw new UserError('Choose a specific role; @everyone cannot be an operator role.');
        this.store.set(
          'allowedRoles',
          sub === 'role-add'
            ? [...new Set([...roles, role.id])]
            : roles.filter((id) => id !== role.id),
        );
      }
      await reply(
        'Operator roles',
        this.store
          .get<string[]>('allowedRoles', this.config.ALLOWED_ROLE_IDS)
          .map((id) => `<@&${id}>`)
          .join('\n') || 'Only administrators have access.',
      );
      return;
    }
    if (name === 'status') {
      await interaction.editReply(this.management.view('status', principal.id));
      return;
    }
    if (name === 'ping') {
      await reply(
        'Pong',
        `Discord gateway: **${this.client.ws.ping} ms**\nRust+: **${this.rust.state}**`,
      );
      return;
    }
    await reply(
      'Rust+ bot commands',
      '`/panel` — Create or refresh base controls (admin)\n`/device add|remove|rename|list|status` — Manage paired devices (admin)\n`/alarm list|enable|disable|test` — Smart Alarm notifications (admin)\n`/chat setup|enable|disable|status` — Team chat synchronization\n`/settings role-add|role-remove|roles|alerts` — Configure access and alerts (admin)\n`/server list|use|pause|resume|rename` — Manage saved Rust servers\n`/pair start|import|inbox|accept|status|unlink` — Pair servers, devices and personal chat accounts\n`/status` — Connection, server and device information\n`/ping` — Latency\n`/help` — This guide\n\nWith multiple saved servers, omit the server argument to choose by name from a private menu. /server use also works without an ID. Switch buttons and Discord-to-Rust chat require an operator role or administrator access. Personal Rust+ linking is required for chat. Switch power does not indicate physical door position.',
    );
  }
  async stop(updatePanel = false): Promise<void> {
    this.stopping = true;
    this.connectionNotifications.stop();
    this.activity.stop();
    this.chat.stop();
    this.rust.stop();
    if (updatePanel)
      await this.panel
        .refresh()
        .catch((error) =>
          log.warn(
            { code: errorCode(error) },
            'Could not mark the paused server panel disconnected',
          ),
        );
    this.panel.stop();
    await Promise.allSettled([
      this.chat.drain(),
      this.activity.drain(),
      this.panel.drain(),
      this.alerts.stop(),
      ...this.tasks,
    ]);
    if (!this.runtime) await this.client.destroy();
  }
}
export class UserError extends Error {}
