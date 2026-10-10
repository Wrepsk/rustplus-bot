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
import { Alerts } from './alerts';
import { commands } from './commands';
import { ConnectionNotifications } from '../connection-notifications';

interface Confirmation {
  user: string;
  id: string;
  action: 'on' | 'off';
  expires: number;
  name: string;
}
export class Bot {
  readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    allowedMentions: { parse: [], repliedUser: false },
    rest: { timeout: 10000, retries: 2 },
  });
  readonly devices: Devices;
  readonly permissions: Permissions;
  readonly panel: Panel;
  readonly chat: ChatBridge;
  readonly alerts: Alerts;
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
  ) {
    this.permissions = new Permissions(config.DISCORD_GUILD_ID, config.ADMIN_USER_ID, () =>
      store.get('allowedRoles', config.ALLOWED_ROLE_IDS),
    );
    this.devices = new Devices(store, rust, config.ALARM_COOLDOWN_SECONDS);
    this.panel = new Panel(this.client, store, this.devices);
    this.alerts = new Alerts(this.client, store, config);
    this.connectionNotifications = new ConnectionNotifications(rust, store, this.alerts);
    this.chat = new ChatBridge(this.client, rust, store, config, this.permissions);
    this.devices.on('alarm', (device) => this.alerts.enqueue(device));
    this.devices.on('alarmActive', (device) => {
      try {
        this.alerts.recoveredAlarm(device);
      } catch (error) {
        this.alerts.reportFailure(error);
      }
    });
    rust.on('health', () => this.panel.schedule());
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
      this.alerts.start();
      this.rust.start();
      this.panel.schedule();
      this.rust.refreshHealth();
    });
    await this.client.login(this.config.DISCORD_TOKEN);
  }
  private async principal(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
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
    return new EmbedBuilder()
      .setTitle(title)
      .setDescription(description.slice(0, 4096))
      .setColor(0xce6f3e);
  }
  private async interaction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (this.stopping) throw new Error('Bot is shutting down.');
      const principal = await this.principal(interaction);
      if (interaction.isButton()) {
        await this.button(interaction, principal);
        return;
      }
      await this.command(interaction, principal);
    } catch (error) {
      const safe =
        error instanceof RustFailure || error instanceof UserError
          ? error.message
          : 'The request failed. Check configuration, channel permissions and logs, then retry.';
      log.warn(
        {
          code: errorCode(error),
          operation: interaction.isButton() ? 'button' : interaction.commandName,
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
    interaction: ChatInputCommandInteraction,
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
        await reply('Registered devices', this.deviceList(false, options.getInteger('page') ?? 1));
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
        await reply('Smart Alarms', this.deviceList(true, options.getInteger('page') ?? 1));
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
        this.store.set('chatChannel', options.getChannel('channel', true).id);
        this.store.set('chatEnabled', true);
      }
      if (sub === 'enable') {
        if (!this.chat.channelId) throw new UserError('Run /chat setup first.');
        this.store.set('chatEnabled', true);
      }
      if (sub === 'disable') this.store.set('chatEnabled', false);
      if (sub !== 'status') void this.chat.reset();
      await reply('Team chat bridge', this.chat.status());
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
      await reply(
        'Rust+ bot status',
        `**Connection:** ${this.rust.state}\n**Last successful connection:** ${this.connectionNotifications.lastSuccessfulAt ? `<t:${Math.floor(this.connectionNotifications.lastSuccessfulAt / 1000)}:F>` : 'Not yet connected'}\n**Monitoring:** ${this.rust.online ? (this.rust.unavailableDevices.length ? `Degraded — ${this.rust.unavailableDevices.length} required device(s) unavailable` : 'Operational') : 'Unavailable'}\n**Server:** ${this.rust.info ? escapeMarkdown(this.rust.info.name).slice(0, 200) : 'Unavailable'}\n**Players:** ${this.rust.info ? `${this.rust.info.players}/${this.rust.info.maxPlayers}` : 'Unavailable'}\n**Devices:** ${this.store.devices().length}\n**Chat:** ${this.chat.status()}`,
      );
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
      '`/panel` — Create or refresh base controls (admin)\n`/device add|remove|rename|list|status` — Manage paired devices (admin)\n`/alarm list|enable|disable|test` — Smart Alarm notifications (admin)\n`/chat setup|enable|disable|status` — Team chat synchronization\n`/settings role-add|role-remove|roles|alerts` — Configure access and alerts (admin)\n`/status` — Connection, server and device information\n`/ping` — Latency\n`/help` — This guide\n\nSwitch buttons and Discord-to-Rust chat require an operator role or administrator access. Switch power does not indicate physical door position.',
    );
  }
  private deviceList(alarmsOnly = false, page = 1): string {
    const devices = this.store.devices().filter((d) => !alarmsOnly || d.type === 'alarm');
    if (!devices.length) return 'No devices registered.';
    const pages = Math.ceil(devices.length / 10);
    page = Math.min(page, pages);
    return (
      devices
        .slice((page - 1) * 10, page * 10)
        .map(
          (d) =>
            `**${escapeMarkdown(d.name)}** • \`${d.id}\` • ${d.type}${d.type === 'alarm' ? ` • ${d.enabled ? 'enabled' : 'disabled'}` : ''}`,
        )
        .join('\n') + `\n\nPage ${page}/${pages} • Use the page option to see more.`
    );
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.connectionNotifications.stop();
    this.chat.stop();
    this.rust.stop();
    this.panel.stop();
    await Promise.allSettled([
      this.chat.drain(),
      this.panel.drain(),
      this.alerts.stop(),
      ...this.tasks,
    ]);
    await this.client.destroy();
  }
}
class UserError extends Error {}
