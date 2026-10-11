import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, escapeMarkdown } from 'discord.js';
import type { Devices } from '../devices';
import type { Store } from '../database';
import { log, errorCode } from '../log';
import { card } from './ui';
import { needsConfirmation } from '../domain';

interface PanelReference {
  channelId: string;
  messageId: string;
  page: number;
}
export class Panel {
  private timer?: NodeJS.Timeout;
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private backgroundPending = false;
  private dirty = false;
  private queued = 0;
  private onUpdate = (): void => this.schedule();
  constructor(
    private client: Client,
    private store: Store,
    private devices: Devices,
    private label?: string,
  ) {
    devices.on('update', this.onUpdate);
  }
  schedule(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.timer || this.backgroundPending) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.backgroundPending = true;
      this.dirty = false;
      void this.refresh()
        .catch((error) =>
          log.warn({ code: errorCode(error) }, 'Panel refresh failed; check channel permissions'),
        )
        .finally(() => {
          this.backgroundPending = false;
          if (this.dirty && !this.stopped) this.schedule();
        });
    }, 1200);
  }
  setServerName(name: string): void {
    this.label = name;
    this.schedule();
  }
  private payload(page = 0) {
    const switches = this.store.devices().filter((d) => d.type === 'switch');
    // Four switches plus a navigation row fit Discord's five action-row limit.
    const pages = Math.max(1, Math.ceil(switches.length / 4));
    page = Math.max(0, Math.min(page, pages - 1));
    const shown = switches.slice(page * 4, page * 4 + 4);
    const embed = card('🦀 RUST BASE CONTROL')
      .setColor(this.devices.rust.online ? 0x42b883 : 0xe5a742)
      .setDescription(
        `**${this.devices.rust.online ? '🟢' : '🟠'} Connection:** ${this.devices.rust.state} • **${switches.length} switches**\n${switches.length ? 'Choose a switch below. States update directly from Rust+.' : 'Pair a switch in-game and open `/pair inbox`, or use `/device add`.'}`,
      )
      .setFooter({
        text: `Page ${page + 1}/${pages} • ON/OFF describes switch power, not physical door position`,
      })
      .setTimestamp();
    if (this.label) embed.setAuthor({ name: this.label.slice(0, 256) });
    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    for (const device of shown) {
      const state = this.devices.states.get(device.id),
        busy = this.devices.busy.has(device.id);
      embed.addFields({
        name: `${needsConfirmation(device) ? '⚠ ' : ''}${escapeMarkdown(device.name)}`,
        value: `Switch: **${!this.devices.rust.online ? 'DISCONNECTED' : state === undefined ? 'UNKNOWN' : state ? '🟢 ON' : '⚫ OFF'}**${busy ? ' • Updating…' : ''}`,
      });
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`switch:on:${device.id}`)
            .setLabel(`${device.name.slice(0, 35)} • On`)
            .setStyle(ButtonStyle.Success)
            .setDisabled(!this.devices.rust.online || busy || state === undefined),
          new ButtonBuilder()
            .setCustomId(`switch:off:${device.id}`)
            .setLabel('Off')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!this.devices.rust.online || busy || state === undefined),
          new ButtonBuilder()
            .setCustomId(`switch:refresh:${device.id}`)
            .setLabel('Refresh')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!this.devices.rust.online || busy),
        ),
      );
    }
    if (pages > 1)
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`page:${page - 1}`)
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
          new ButtonBuilder()
            .setCustomId(`page:${page + 1}`)
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === pages - 1),
        ),
      );
    return { embeds: [embed], components, allowedMentions: { parse: [] as [] } };
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Panel is stopping'));
    if (this.queued >= 20) return Promise.reject(new Error('Panel request queue is full'));
    ++this.queued;
    const task = this.tail
      .catch(() => {})
      .then(work)
      .finally(() => {
        --this.queued;
      });
    this.tail = task;
    return task;
  }
  create(channelId: string): Promise<void> {
    return this.serialize(async () => {
      const existing = this.store.get<PanelReference | null>('panel', null);
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel))
        throw new Error('Use a guild text channel.');
      if (existing?.channelId === channelId) {
        try {
          const message = await channel.messages.fetch(existing.messageId);
          await message.edit(this.payload(existing.page));
          return;
        } catch (error) {
          if (!(typeof error === 'object' && error && 'code' in error && error.code === 10008))
            throw error;
        }
      }
      const message = await channel.send(this.payload());
      this.store.set('panel', { channelId, messageId: message.id, page: 0 });
      if (existing && existing.channelId !== channelId) {
        // The persisted message ID is already switched, so old buttons are inactive
        // even if Discord denies the cosmetic cleanup below.
        try {
          const previous = await this.client.channels.fetch(existing.channelId);
          if (previous?.isTextBased())
            await (
              await previous.messages.fetch(existing.messageId)
            ).edit({
              embeds: [
                card(
                  'Base control panel moved',
                  `Use the current panel in <#${channelId}>.`,
                  this.label,
                ),
              ],
              components: [],
              allowedMentions: { parse: [] },
            });
        } catch (error) {
          log.warn(
            { code: errorCode(error) },
            'Previous panel cleanup failed; its controls are inactive',
          );
        }
      }
    });
  }
  refresh(page?: number): Promise<void> {
    return this.serialize(async () => {
      const panel = this.store.get<PanelReference | null>('panel', null);
      if (!panel || !this.client.isReady()) return;
      if (page !== undefined) {
        panel.page = Math.max(0, Math.min(24, page));
        this.store.set('panel', panel);
      }
      const channel = await this.client.channels.fetch(panel.channelId);
      if (!channel?.isTextBased()) return;
      await (await channel.messages.fetch(panel.messageId)).edit(this.payload(panel.page));
    });
  }
  isPanel(messageId: string): boolean {
    return this.store.get<PanelReference | null>('panel', null)?.messageId === messageId;
  }
  stop(): void {
    this.stopped = true;
    this.devices.off('update', this.onUpdate);
    if (this.timer) clearTimeout(this.timer);
  }
  async drain(): Promise<void> {
    await Promise.allSettled([this.tail]);
  }
}
