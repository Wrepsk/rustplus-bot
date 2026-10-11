import { Client, EmbedBuilder, escapeMarkdown } from 'discord.js';
import type { Config } from '../config';
import type { Notification, Store } from '../database';
import type { Device } from '../domain';
import { log, errorCode } from '../log';

export class AlertDeliveryError extends Error {
  constructor(
    readonly code:
      | 'ALERT_CHANNEL_MISSING'
      | 'ALERT_CHANNEL_UNAVAILABLE'
      | 'ALERT_MISSING_ACCESS'
      | 'ALERT_MISSING_PERMISSIONS',
  ) {
    super(
      {
        ALERT_CHANNEL_MISSING:
          'No alert channel is configured. Run /settings alerts channel:#raid-alerts, then retry /alarm test.',
        ALERT_CHANNEL_UNAVAILABLE:
          'The alert channel is unavailable or is not a supported text channel. Select an existing text channel with /settings alerts.',
        ALERT_MISSING_ACCESS:
          'Discord denied access to the alert channel. Allow the bot to View Channel, then run /settings alerts with that channel.',
        ALERT_MISSING_PERMISSIONS:
          'The bot is missing permissions in the alert channel. Allow View Channel, Send Messages and Embed Links, then retry /alarm test.',
      }[code],
    );
  }
}

export class Alerts {
  private tail: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  private stopped = false;
  private queued = 0;
  constructor(
    private client: Client,
    private store: Store,
    private config: Config,
  ) {}
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.flush();
    this.timer = setInterval(() => {
      void this.flush();
    }, 10000);
  }
  enqueue(device: Device): void {
    if (this.stopped) return;
    this.store.enqueueAlarm(device.id, device.name);
    void this.flush()
      .then(() => {
        if (!this.stopped && this.store.alarmJobs().length) void this.flush();
      })
      .catch((error) => this.reportFailure(error));
  }
  notify(notification: Notification): void {
    if (this.stopped) return;
    this.store.enqueueNotification(notification);
    this.wake();
  }
  recoveredAlarm(device: Device): void {
    if (this.stopped || !device.enabled) return;
    this.store.queueRecoveryWarning(
      device,
      `**Smart Alarm:** ${escapeMarkdown(device.name)}\n\nThis alarm was already active when monitoring resumed. The bot cannot determine when it activated or whether an actual raid occurred.`,
    );
    this.wake();
  }
  wake(): void {
    if (!this.stopped) void this.flush();
  }
  private flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      if (!this.client.isReady() || this.stopped) return;
      for (const job of this.store.alarmJobs()) {
        if (this.stopped) break;
        if (!this.store.devices().some((d) => d.id === job.id && d.type === 'alarm' && d.enabled)) {
          this.store.acknowledgeAlarm(job.id, job.nonce);
          continue;
        }
        try {
          await this.send(
            { id: job.id, name: job.name, type: 'alarm', enabled: true, sensitive: false },
            false,
            job.at,
            () =>
              this.store
                .alarmJobs()
                .some((current) => current.id === job.id && current.nonce === job.nonce) &&
              this.store.devices().some((d) => d.id === job.id && d.enabled),
          );
          this.store.acknowledgeAlarm(job.id, job.nonce);
        } catch (error) {
          this.reportFailure(error);
          this.store.retryAlarm(job.id, job.attempts + 1, job.nonce);
        }
      }
      for (const job of this.store.notificationJobs()) {
        if (this.stopped) break;
        if (
          job.alarmId &&
          !this.store.devices().some((d) => d.id === job.alarmId && d.type === 'alarm' && d.enabled)
        ) {
          this.store.acknowledgeNotification(job.id);
          continue;
        }
        try {
          await this.sendNotification(job);
          this.store.acknowledgeNotification(job.id);
        } catch (error) {
          this.reportFailure(error);
          this.store.retryNotification(job.id, job.attempts + 1);
        }
      }
    })()
      .catch((error) => this.reportFailure(error))
      .finally(() => {
        this.flushing = undefined;
      });
    return this.flushing;
  }
  private serialize(work: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Alerts are stopping'));
    if (this.queued >= 50) return Promise.reject(new Error('Alert delivery queue is full'));
    ++this.queued;
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        if (this.stopped) throw new Error('Alerts are stopping');
        await work();
      })
      .catch((error: unknown) => {
        // Discord's documented numeric codes are safe to translate; never expose raw API errors.
        if (typeof error === 'object' && error !== null && 'code' in error) {
          if (error.code === 10003) throw new AlertDeliveryError('ALERT_CHANNEL_UNAVAILABLE');
          if (error.code === 50001) throw new AlertDeliveryError('ALERT_MISSING_ACCESS');
          if (error.code === 50013) throw new AlertDeliveryError('ALERT_MISSING_PERMISSIONS');
        }
        throw error;
      })
      .finally(() => {
        --this.queued;
      });
    this.tail = task;
    return task;
  }
  private async sendNotification(notification: Notification): Promise<void> {
    return this.serialize(async () => {
      if (
        notification.alarmId &&
        !this.store.devices().some((d) => d.id === notification.alarmId && d.enabled)
      )
        return;
      const channelId = this.store.get('alertChannel', this.config.ALERT_CHANNEL_ID || '');
      if (!channelId) throw new AlertDeliveryError('ALERT_CHANNEL_MISSING');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel))
        throw new AlertDeliveryError('ALERT_CHANNEL_UNAVAILABLE');
      if (this.stopped) throw new Error('Alerts are stopping');
      if (
        notification.alarmId &&
        !this.store.devices().some((d) => d.id === notification.alarmId && d.enabled)
      )
        return;
      // Operational/recovery warnings never masquerade as raid alerts or ping the raid role.
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(notification.title)
            .setFooter({ text: this.config.BASE_NAME })
            .setDescription(notification.description)
            .setColor(notification.title.startsWith('✅') ? 0x42b883 : 0xe5a742)
            .setTimestamp(notification.at),
        ],
        allowedMentions: { parse: [] },
      });
    });
  }
  send(device: Device, simulated = false, at = Date.now(), guard?: () => boolean): Promise<void> {
    return this.serialize(async () => {
      if (guard && !guard()) return;
      const channelId = this.store.get('alertChannel', this.config.ALERT_CHANNEL_ID || '');
      const role = this.store.get('alertRole', this.config.ALERT_ROLE_ID || '');
      if (!channelId) throw new AlertDeliveryError('ALERT_CHANNEL_MISSING');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel))
        throw new AlertDeliveryError('ALERT_CHANNEL_UNAVAILABLE');
      if (this.stopped) throw new Error('Alerts are stopping');
      if (guard && !guard()) return;
      await channel.send({
        content: role ? `<@&${role}>` : undefined,
        embeds: [
          new EmbedBuilder()
            .setTitle(simulated ? '🧪 SIMULATED RAID ALERT' : '🚨 RAID ALERT!')
            .setColor(simulated ? 0xe5a742 : 0xed4245)
            .addFields(
              { name: 'Base', value: escapeMarkdown(this.config.BASE_NAME) },
              { name: 'Sensor', value: escapeMarkdown(device.name) },
              {
                name: 'Event',
                value: simulated
                  ? 'Test notification — no in-game device was triggered.'
                  : `Smart Alarm Activated\nObserved <t:${Math.floor(at / 1000)}:R>`,
              },
            )
            .setTimestamp(at),
        ],
        allowedMentions: { parse: [], roles: role ? [role] : [] },
      });
    });
  }
  reportFailure(error: unknown): void {
    log.error(
      { code: errorCode(error) },
      'Alarm notification delivery failed; check alert channel and Discord permissions',
    );
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([this.flushing, this.tail]);
  }
}
