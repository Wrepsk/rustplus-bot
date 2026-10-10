import { Client, EmbedBuilder, escapeMarkdown } from 'discord.js';
import type { Config } from '../config';
import type { Store } from '../database';
import type { Device } from '../domain';
import { log, errorCode } from '../log';

export class Alerts {
  private tail: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  private stopped = false;
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
    this.store.enqueueAlarm(device.id, device.name);
    void this.flush().then(() => {
      if (!this.stopped && this.store.alarmJobs().length) void this.flush();
    });
  }
  private flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      if (!this.client.isReady() || this.stopped) return;
      for (const job of this.store.alarmJobs()) {
        if (this.stopped) break;
        if (!this.store.devices().some((d) => d.id === job.id && d.type === 'alarm' && d.enabled)) {
          this.store.acknowledgeAlarm(job.id);
          continue;
        }
        try {
          await this.send(
            { id: job.id, name: job.name, type: 'alarm', enabled: true, sensitive: false },
            false,
            job.at,
          );
          this.store.acknowledgeAlarm(job.id);
        } catch (error) {
          this.reportFailure(error);
          this.store.retryAlarm(job.id, job.attempts + 1);
        }
      }
    })()
      .catch((error) => this.reportFailure(error))
      .finally(() => {
        this.flushing = undefined;
      });
    return this.flushing;
  }
  send(device: Device, simulated = false, at = Date.now()): Promise<void> {
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        const channelId = this.store.get('alertChannel', this.config.ALERT_CHANNEL_ID || '');
        const role = this.store.get('alertRole', this.config.ALERT_ROLE_ID || '');
        if (!channelId) throw new Error('Configure an alert channel with /settings alerts.');
        const channel = await this.client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased() || !('send' in channel))
          throw new Error('Alert channel is unavailable.');
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
    this.tail = task;
    return task;
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
