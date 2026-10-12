import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { Store } from '../database';
import type { RegisteredCamera } from '../cameras/registry';
import { card } from './ui';
import { errorCode, log } from '../log';
import { rememberPanel } from './server-panels';

interface Reference {
  channelId: string;
  messageId: string;
}

// One independently persisted message per Rust server, separate from its switch panel.
export class CameraPanel {
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private pending = false;
  private dirty = false;
  constructor(
    private client: Client,
    private store: Store,
    private server: string,
    private cameras: () => RegisteredCamera[],
    private status: () => { name: string; state: string; online: boolean },
  ) {}
  private payload() {
    const cameras = this.cameras(),
      status = this.status();
    const embed = card(
      '📷 RUST CAMERA CONTROL',
      `**${status.online ? '🟢' : '🟠'} Connection:** ${status.state} • **${cameras.length} cameras**\n\n${cameras.length ? 'Choose a camera below to open your private viewer with movement controls.' : 'Register cameras with `/camera add` using their in-game camera identifiers.'}\nYour offline account is preferred. Borrowing a teammate’s account requires their explicit consent.`,
      status.name,
    )
      .setColor(status.online ? 0x42b883 : 0xe5a742)
      .setFooter({
        text: 'One viewer per Rust server • Viewer links are private • No firing controls',
      })
      .setTimestamp();
    const components: (
      ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>
    )[] = [];
    if (cameras.length)
      components.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`campanel:${this.server}:watch`)
            .setPlaceholder('Choose a camera to watch')
            .setDisabled(!status.online)
            .addOptions(cameras.map((c) => ({ label: c.name, value: c.id }))),
        ),
      );
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`campanel:${this.server}:refresh`)
          .setLabel('Refresh')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`campanel:${this.server}:stop`)
          .setLabel('Stop my viewer')
          .setStyle(ButtonStyle.Danger),
      ),
    );
    return { embeds: [embed], components, allowedMentions: { parse: [] as [] } };
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Camera panel is stopping.'));
    if (this.queued >= 20) return Promise.reject(new Error('Camera panel request queue is full.'));
    this.queued++;
    const task = this.tail
      .catch(() => {})
      .then(work)
      .finally(() => {
        this.queued--;
      });
    this.tail = task;
    return task;
  }
  create(channelId: string): Promise<void> {
    return this.serialize(async () => {
      const existing = this.store.get<Reference | null>('cameraPanel', null);
      if (existing) rememberPanel(this.store, existing);
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !('send' in channel))
        throw new Error('Use a guild text channel.');
      if (existing?.channelId === channelId) {
        try {
          await (await channel.messages.fetch(existing.messageId)).edit(this.payload());
          return;
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 10008))
            throw error;
        }
      }
      const message = await channel.send(this.payload());
      rememberPanel(this.store, { channelId, messageId: message.id });
      this.store.set('cameraPanel', { channelId, messageId: message.id });
      if (existing && existing.channelId !== channelId) {
        try {
          const previous = await this.client.channels.fetch(existing.channelId);
          if (previous?.isTextBased())
            await (
              await previous.messages.fetch(existing.messageId)
            ).edit({
              embeds: [
                card(
                  'Camera panel moved',
                  `Use the current panel in <#${channelId}>.`,
                  this.status().name,
                ),
              ],
              components: [],
              allowedMentions: { parse: [] },
            });
        } catch (error) {
          log.warn(
            { code: errorCode(error) },
            'Previous camera panel cleanup failed; its controls are inactive',
          );
        }
      }
    });
  }
  refresh(): Promise<void> {
    return this.serialize(async () => {
      const ref = this.store.get<Reference | null>('cameraPanel', null);
      if (!ref || !this.client.isReady()) return;
      const channel = await this.client.channels.fetch(ref.channelId);
      if (channel?.isTextBased())
        await (await channel.messages.fetch(ref.messageId)).edit(this.payload());
    });
  }
  isPanel(message: string, channel: string): boolean {
    const ref = this.store.get<Reference | null>('cameraPanel', null);
    return ref?.messageId === message && ref.channelId === channel;
  }
  schedule(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.timer || this.pending) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.dirty = false;
      this.pending = true;
      void this.refresh()
        .catch((error) =>
          log.warn(
            { code: errorCode(error) },
            'Camera panel refresh failed; check channel permissions',
          ),
        )
        .finally(() => {
          this.pending = false;
          if (this.dirty) this.schedule();
        });
    }, 1200);
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
  async drain(): Promise<void> {
    await Promise.allSettled([this.tail]);
  }
}
