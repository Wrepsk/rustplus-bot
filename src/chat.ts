import { Client, EmbedBuilder, escapeMarkdown, type Message } from 'discord.js';
import { ExpiringSet, chatChunks, isEcho, messageKey, type TeamMessage } from './domain';
import type { Config } from './config';
import type { Store } from './database';
import { RustFailure, type Connection } from './rust/connection';
import type { RustResponse } from './rust/protocol';
import type { Permissions } from './permissions';
import { log, errorCode } from './log';

export class ChatBridge {
  private sent = new ExpiringSet(300000);
  private fingerprints = new ExpiringSet(3000);
  private discordSeen = new ExpiringSet(300000);
  private outbound: Promise<unknown> = Promise.resolve();
  private inbound: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private epoch = 0;
  private active = false;
  private stopped = false;
  private pending = 0;
  private inboundPending = 0;
  private lastError = '';
  private lastSync = 0;
  private polling = false;
  private teamSignature = '';
  private teamGeneration = 0;
  private historyFloor = 0;
  private syncWork = new Set<Promise<void>>();
  private busyNotices = new ExpiringSet(10000, 100);
  constructor(
    private client: Client,
    private rust: Connection,
    private store: Store,
    private config: Config,
    private permissions: Permissions,
  ) {
    rust.on('ready', () => {
      void this.reset();
    });
    rust.on('status', () => {
      if (!rust.online) {
        this.active = false;
        ++this.epoch;
      }
    });
    rust.on('teamChanged', (team: RustResponse['teamInfo']) => {
      if (this.observeTeam(team)) void this.reset();
    });
    rust.on('chat', (message: TeamMessage) => {
      if (this.active && this.enabled) this.enqueue(message);
    });
  }
  get enabled(): boolean {
    return this.store.get('chatEnabled', false);
  }
  private observeTeam(team: RustResponse['teamInfo']): boolean {
    if (!team) return false;
    const signature = `${team.leaderSteamId.toString()}:${team.members
      .map((m) => m.steamId.toString())
      .sort()
      .join(',')}`;
    const changed = !!this.teamSignature && signature !== this.teamSignature;
    this.teamSignature = signature;
    if (changed) {
      this.active = false;
      ++this.teamGeneration;
    }
    return changed;
  }
  get channelId(): string {
    return this.store.get('chatChannel', '');
  }
  status(): string {
    return `${this.enabled ? 'Enabled' : 'Disabled'} • ${this.channelId ? `<#${this.channelId}>` : 'No channel'}\n${this.active ? 'Live' : 'Waiting for synchronization'}${this.lastError ? ` • ${this.lastError}` : ''}${this.lastSync ? `\nLast sync: <t:${Math.floor(this.lastSync / 1000)}:R>` : ''}`;
  }
  async reset(): Promise<void> {
    const epoch = ++this.epoch;
    this.active = false;
    this.lastError = '';
    if (this.timer) clearInterval(this.timer);
    if (this.polling) await Promise.allSettled([...this.syncWork]);
    if (epoch !== this.epoch) return;
    if (this.stopped || !this.enabled || !this.channelId || !this.rust.online) return;
    const runSync = async () => {
      if (
        !this.rust.online ||
        this.stopped ||
        epoch !== this.epoch ||
        !this.enabled ||
        this.polling
      )
        return;
      this.polling = true;
      try {
        this.observeTeam((await this.rust.request({ getTeamInfo: {} })).teamInfo);
        if (epoch !== this.epoch || this.stopped || !this.enabled) return;
        const response = await this.rust.request({ getTeamChat: {} });
        if (epoch !== this.epoch || this.stopped || !this.enabled) return;
        if (!response.teamChat) throw new Error('No team chat response');
        const messages = [...response.teamChat.messages].sort((a, b) => a.time - b.time);
        // First snapshot per session is baseline-only; broadcasts during this phase are intentionally ignored.
        if (!this.active) {
          for (const message of messages) this.store.markSeen(messageKey(message));
          this.historyFloor = Math.max(0, ...messages.map((m) => m.time));
          this.active = true;
        } else {
          for (const message of messages) this.enqueue(message, true);
        }
        this.lastError = '';
        this.lastSync = Date.now();
      } catch (error) {
        if (epoch !== this.epoch || this.stopped) return;
        if (!(error instanceof RustFailure) || error.kind === 'device') this.active = false;
        this.lastError = 'Team chat unavailable; check team membership';
        log.warn({ code: errorCode(error) }, 'Team chat synchronization failed');
      } finally {
        this.polling = false;
      }
    };
    const sync = (): Promise<void> => {
      const work = runSync();
      this.syncWork.add(work);
      return work.finally(() => this.syncWork.delete(work));
    };
    await sync();
    if (!this.stopped && epoch === this.epoch)
      this.timer = setInterval(() => {
        void sync();
      }, this.config.CHAT_POLL_SECONDS * 1000);
  }
  private enqueue(message: TeamMessage, historical = false): void {
    if (historical && message.time < this.historyFloor) return;
    if (this.inboundPending >= 100) {
      log.warn('Inbound chat queue full; dropping message');
      return;
    }
    const epoch = this.epoch,
      teamGeneration = this.teamGeneration;
    ++this.inboundPending;
    this.inbound = this.inbound
      .catch(() => {})
      .then(async () => {
        if (
          epoch !== this.epoch ||
          teamGeneration !== this.teamGeneration ||
          !this.enabled ||
          this.stopped
        )
          return;
        const key = messageKey(message),
          fingerprint = `${message.steamId}:${message.message}`;
        if (this.store.seen(key)) {
          this.store.markSeen(key);
          return;
        }
        if (
          isEcho(message, this.config.RUST_STEAM_ID, this.sent) ||
          (message.steamId.toString() === this.config.RUST_STEAM_ID &&
            (this.store.echo(message.message) || message.message.startsWith('[Discord] '))) ||
          (!historical && this.fingerprints.has(fingerprint))
        ) {
          this.store.markSeen(key);
          return;
        }
        const channel = await this.client.channels.fetch(this.channelId);
        if (
          this.stopped ||
          epoch !== this.epoch ||
          teamGeneration !== this.teamGeneration ||
          !this.enabled
        )
          return;
        if (!channel || !channel.isTextBased() || !('send' in channel))
          throw new Error('Chat channel unavailable');
        // Bot embeds avoid storing webhook tokens and work with ordinary channel permissions.
        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setAuthor({ name: `${message.name.slice(0, 240)} [Rust]` })
              .setDescription(escapeMarkdown(message.message).slice(0, 4000) || '(empty message)')
              .setColor(0xce6f3e),
          ],
          allowedMentions: { parse: [] },
        });
        this.store.markSeen(key);
        this.fingerprints.add(fingerprint);
      })
      .catch((error) => {
        log.warn(
          { code: errorCode(error) },
          'Rust-to-Discord delivery failed; next history poll will retry',
        );
      })
      .finally(() => {
        --this.inboundPending;
      });
  }
  async fromDiscord(message: Message): Promise<void> {
    if (
      this.stopped ||
      !this.enabled ||
      message.channelId !== this.channelId ||
      message.guildId !== this.config.DISCORD_GUILD_ID ||
      message.author.bot ||
      message.webhookId ||
      !message.content.trim()
    )
      return;
    if (this.discordSeen.has(message.id)) return;
    this.discordSeen.add(message.id);
    if (this.pending >= 20) {
      if (!this.busyNotices.has(message.author.id)) {
        this.busyNotices.add(message.author.id);
        await message.reply({
          content: 'Chat queue full. Your message was not relayed; try again shortly.',
          allowedMentions: { repliedUser: false, parse: [] },
        });
      }
      return;
    }
    const epoch = this.epoch,
      teamGeneration = this.teamGeneration;
    const availableAtArrival = this.rust.online && this.active;
    ++this.pending;
    const task = this.outbound
      .catch(() => {})
      .then(async () => {
        if (this.stopped) return;
        // Authorization is part of the ordered queue: a slow member fetch cannot reorder messages.
        const member = await message.guild!.members.fetch({ user: message.author.id, force: true });
        const principal = {
          id: member.id,
          guildId: message.guildId,
          administrator: member.permissions.has('Administrator'),
          roles: [...member.roles.cache.keys()],
        };
        if (!this.permissions.operate(principal)) return;
        if (!availableAtArrival || !this.rust.online || !this.active) {
          await message.reply({
            content:
              'Rust+ chat is unavailable. Your message was not relayed; resend after reconnection.',
            allowedMentions: { repliedUser: false, parse: [] },
          });
          return;
        }
        const chunks = chatChunks(
          member.displayName,
          message.content,
          this.config.RUST_CHAT_MAX_LENGTH,
        );
        if (chunks.length > 8) {
          await message.reply({
            content: 'Message too long. Shorten it and try again.',
            allowedMentions: { repliedUser: false, parse: [] },
          });
          return;
        }
        const beforeSend = () => {
          if (
            this.stopped ||
            epoch !== this.epoch ||
            teamGeneration !== this.teamGeneration ||
            !this.enabled ||
            !this.active ||
            !this.permissions.operate(principal)
          )
            throw new Error('Chat session changed');
        };
        for (const chunk of chunks) {
          if (
            this.stopped ||
            epoch !== this.epoch ||
            teamGeneration !== this.teamGeneration ||
            !this.enabled ||
            !this.active
          )
            throw new Error('Chat session changed');
          const response = await this.rust.request(
            { sendTeamMessage: { message: chunk } },
            false,
            () => {
              beforeSend();
              // Record at actual dispatch, rather than before a potentially slow Rust+ queue.
              this.sent.add(chunk);
              this.store.saveEcho(chunk);
            },
          );
          if (!response.success) throw new Error('No chat acknowledgement');
        }
      })
      .catch(async (error) => {
        log.warn(
          { code: errorCode(error) },
          'Discord-to-Rust relay failed; not retrying an uncertain send',
        );
        if (this.stopped) return;
        await message
          .reply({
            content:
              'Rust+ could not confirm delivery. Some parts may have arrived. Check in-game chat before resending.',
            allowedMentions: { repliedUser: false, parse: [] },
          })
          .catch((replyError) =>
            log.warn({ code: errorCode(replyError) }, 'Could not deliver chat failure indication'),
          );
      })
      .finally(() => {
        --this.pending;
      });
    this.outbound = task;
    await task;
  }
  stop(): void {
    this.stopped = true;
    this.active = false;
    ++this.epoch;
    if (this.timer) clearInterval(this.timer);
  }
  async drain(): Promise<void> {
    await Promise.allSettled([this.inbound, this.outbound, ...this.syncWork]);
  }
}
