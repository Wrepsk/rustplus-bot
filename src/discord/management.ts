import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { Store } from '../database';
import type { Connection } from '../rust/connection';
import type { Devices } from '../devices';
import type { ChatBridge } from '../chat';
import type { Alerts } from './alerts';
import type { Permissions, Principal } from '../permissions';
import type { Panel } from './panel';
import { button, card } from './ui';

type Component = ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction;
export class ManagementError extends Error {}

export class Management {
  private tests = new Set<string>();
  constructor(
    readonly id: string,
    private label: string | undefined,
    private store: Store,
    private rust: Connection,
    private devices: Devices,
    private chat: ChatBridge,
    private alerts: Alerts,
    private panel: Panel,
    private permissions: Permissions,
    private lastConnected: () => number | undefined,
  ) {}
  owns(customId: string): boolean {
    return customId.startsWith(`view:${this.id}:`);
  }
  private key(user: string, section: string, action: string, value = '0'): string {
    return `view:${this.id}:${user}:${section}:${action}:${value}`;
  }
  view(section: string, user: string, page = 0) {
    const components: (
      ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>
    )[] = [];
    const embed = card(
      section === 'status'
        ? '📡 Rust+ bot status'
        : section === 'chat'
          ? '💬 Team chat bridge'
          : section === 'alarm'
            ? '🚨 Smart Alarms'
            : '🔌 Registered devices',
      undefined,
      this.label,
    );
    if (section === 'status') {
      const last = this.lastConnected();
      embed.addFields(
        { name: 'Rust+ connection', value: this.rust.state, inline: true },
        {
          name: 'Monitoring',
          value: this.rust.online
            ? this.rust.unavailableDevices.length
              ? `Degraded — ${this.rust.unavailableDevices.length} required device(s) unavailable`
              : 'Operational'
            : 'Unavailable',
          inline: true,
        },
        {
          name: 'Last successful connection',
          value: last ? `<t:${Math.floor(last / 1000)}:F>` : 'Not yet connected',
        },
        {
          name: 'Server',
          value: this.rust.info ? escapeMarkdown(this.rust.info.name).slice(0, 200) : 'Unavailable',
          inline: true,
        },
        {
          name: 'Players',
          value: this.rust.info
            ? `${this.rust.info.players}/${this.rust.info.maxPlayers}`
            : 'Unavailable',
          inline: true,
        },
        { name: 'Registered devices', value: String(this.store.devices().length), inline: true },
        { name: 'Team chat', value: this.chat.status().slice(0, 1024) },
      );
    } else if (section === 'chat') {
      embed.setDescription(this.chat.status()).addFields(
        {
          name: 'Discord channel',
          value: this.chat.channelId
            ? `<#${this.chat.channelId}>`
            : 'Choose one with `/chat setup`',
          inline: true,
        },
        {
          name: 'Sending to Rust',
          value:
            'Operator role + personal Rust+ linking required. Messages use each linked player’s Steam identity.',
        },
      );
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button(
            this.key(user, section, this.store.get('chatEnabled', false) ? 'disable' : 'enable'),
            this.store.get('chatEnabled', false) ? 'Disable bridge' : 'Enable bridge',
            ButtonStyle.Secondary,
          ),
        ),
      );
    } else {
      const devices = this.store.devices().filter((d) => section !== 'alarm' || d.type === 'alarm');
      const pages = Math.max(1, Math.ceil(devices.length / 10));
      page = Math.max(0, Math.min(pages - 1, page));
      const shown = devices.slice(page * 10, (page + 1) * 10);
      embed.setDescription(
        devices.length
          ? 'Select a device to view its state, rename it, or manage its registration.'
          : 'No devices registered. Pair one in-game and accept it with `/pair inbox`, or use `/device add`.',
      );
      for (const device of shown)
        embed.addFields({
          name: device.name,
          value: `${device.type === 'alarm' ? '🚨 Smart Alarm' : '🔌 Smart Switch'} • \`${device.id}\` • ${this.state(device.id)}${device.type === 'alarm' ? `\nNotifications: **${device.enabled ? 'Enabled' : 'Disabled'}**` : ''}`,
        });
      embed.setFooter({
        text: `${devices.length} devices • Page ${page + 1}/${pages} • Select a device below`,
      });
      if (shown.length)
        components.push(
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(this.key(user, section, 'select'))
              .setPlaceholder('Choose a device')
              .addOptions(
                shown.map((d) => ({
                  label: d.name.slice(0, 100),
                  value: d.id,
                  description: `${d.type === 'alarm' ? 'Smart Alarm' : 'Smart Switch'} • ${d.id}`,
                })),
              ),
          ),
        );
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button(
            this.key(user, section, 'page', String(page - 1)),
            'Previous',
            ButtonStyle.Secondary,
            page === 0,
          ),
          button(this.key(user, section, 'page', String(page)), 'Refresh', ButtonStyle.Primary),
          button(
            this.key(user, section, 'page', String(page + 1)),
            'Next',
            ButtonStyle.Secondary,
            page === pages - 1,
          ),
        ),
      );
    }
    if (['status', 'chat'].includes(section))
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button(this.key(user, section, 'refresh'), 'Refresh', ButtonStyle.Primary),
        ),
      );
    return { embeds: [embed], components, allowedMentions: { parse: [] as [] } };
  }
  private state(id: string): string {
    const device = this.store.device(id),
      state = this.devices.states.get(id);
    if (!this.rust.online) return 'Disconnected';
    if (state === undefined) return 'Unknown — press Refresh to query Rust+';
    return device.type === 'alarm'
      ? state
        ? '🟠 ACTIVE'
        : '⚫ INACTIVE'
      : state
        ? '🟢 ON'
        : '⚫ OFF';
  }
  private detail(user: string, section: string, id: string, notice?: string, confirm = false) {
    const device = this.store.device(id);
    const embed = card(
      `${device.type === 'alarm' ? '🚨' : '🔌'} ${device.name}`,
      notice,
      this.label,
    ).addFields(
      { name: 'Reported state', value: this.state(id), inline: true },
      { name: 'Entity ID', value: `\`${id}\``, inline: true },
    );
    if (device.type === 'switch')
      embed.setFooter({
        text: 'ON/OFF describes switch power, not physical door position. Use /panel to operate.',
      });
    else
      embed.addFields({
        name: 'Notifications',
        value: device.enabled ? 'Enabled' : 'Disabled',
        inline: true,
      });
    const components = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(
          this.key(user, section, 'read', id),
          'Refresh state',
          ButtonStyle.Primary,
          !this.rust.online,
        ),
        button(this.key(user, section, 'rename', id), 'Rename'),
        button(this.key(user, section, 'remove', id), 'Remove', ButtonStyle.Danger),
        button(this.key(user, section, 'page'), 'Back'),
      ),
    ];
    if (device.type === 'alarm')
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button(
            this.key(user, section, device.enabled ? 'disable' : 'enable', id),
            device.enabled ? 'Disable alerts' : 'Enable alerts',
          ),
          button(this.key(user, section, 'test', id), 'Send simulated alert'),
        ),
      );
    if (confirm)
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button(
            this.key(user, section, 'remove-confirm', id),
            'Confirm removal',
            ButtonStyle.Danger,
          ),
          button(this.key(user, section, 'detail', id), 'Cancel'),
        ),
      );
    return { embeds: [embed], components, allowedMentions: { parse: [] as [] } };
  }
  async handle(interaction: Component, principal: Principal): Promise<void> {
    const [prefix, server, owner, section, action, value] = interaction.customId.split(':');
    if (prefix !== 'view' || server !== this.id || owner !== principal.id)
      throw new ManagementError('Open your own slash command to use this control.');
    if (!['status', 'chat', 'device', 'alarm'].includes(section))
      throw new ManagementError('Unknown panel.');
    if (
      (['device', 'alarm'].includes(section) || !['refresh', 'page'].includes(action)) &&
      !this.permissions.admin(principal)
    )
      throw new ManagementError('Administrator access is required.');
    if (['status', 'chat'].includes(section)) {
      if (action === 'enable' || action === 'disable') {
        if (section !== 'chat') throw new ManagementError('Unknown control.');
        if (action === 'enable' && !this.chat.channelId)
          throw new ManagementError('Run /chat setup first.');
        this.store.set('chatEnabled', action === 'enable');
        await this.chat.reset();
      } else if (action !== 'refresh') throw new ManagementError('Unknown control.');
      await interaction.editReply(this.view(section, owner));
      return;
    }
    if (action === 'page') {
      if (!/^-?\d{1,2}$/.test(value)) throw new ManagementError('Invalid page.');
      await interaction.editReply(this.view(section, owner, Number(value)));
      return;
    }
    const id =
      action === 'select' && interaction.isStringSelectMenu() ? interaction.values[0] : value;
    const device = this.store.device(id);
    if (section === 'alarm' && device.type !== 'alarm')
      throw new ManagementError('Select a Smart Alarm.');
    if (
      this.devices.busy.has(id) &&
      ['rename', 'rename-save', 'remove', 'remove-confirm'].includes(action)
    )
      throw new ManagementError(
        'A request for this device is running. Wait for it to finish before changing its registration.',
      );
    if (action === 'rename' && interaction.isButton()) {
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(this.key(owner, section, 'rename-save', id))
          .setTitle('Rename device')
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId('name')
                .setLabel('Friendly name')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMinLength(1)
                .setMaxLength(60)
                .setValue(device.name),
            ),
          ),
      );
      return;
    }
    let notice: string | undefined;
    if (action === 'rename-save' && interaction.isModalSubmit()) {
      this.store.rename(id, interaction.fields.getTextInputValue('name').trim());
      this.panel.schedule();
    } else if (action === 'remove-confirm' && interaction.isButton()) {
      this.store.remove(id);
      this.devices.forget(id);
      this.panel.schedule();
      await interaction.editReply(this.view(section, owner));
      return;
    } else if (action === 'remove')
      notice =
        'Remove this registration? This stops monitoring and removes it from Discord controls. It does not change the physical device in Rust.';
    else if (action === 'read') await this.rust.queryDevice(id);
    else if (['enable', 'disable', 'test'].includes(action)) {
      if (device.type !== 'alarm') throw new ManagementError('Select a Smart Alarm.');
      if (action === 'test') {
        if (this.tests.has(id))
          throw new ManagementError('A simulated alert is already being sent.');
        this.tests.add(id);
        try {
          await this.alerts.send(device, true);
        } finally {
          this.tests.delete(id);
        }
        notice = '✅ Simulated notification sent. No Rust device was triggered.';
      } else {
        this.store.enable(id, action === 'enable');
        this.rust.refreshHealth();
      }
    } else if (!['select', 'detail', 'rename-save'].includes(action))
      throw new ManagementError('Unknown control.');
    await interaction.editReply(this.detail(owner, section, id, notice, action === 'remove'));
  }
}
