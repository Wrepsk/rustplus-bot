import { randomUUID } from 'node:crypto';
import { escapeMarkdown } from 'discord.js';
import type { Store } from './database';
import type { Connection, ConnectionState } from './rust/connection';
import type { Alerts } from './discord/alerts';
import { log, errorCode } from './log';

interface Outage {
  id: string;
  startedAt: number;
  notified: boolean;
}
export class ConnectionNotifications {
  private armed = false;
  private outage: Outage | null;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  constructor(
    private rust: Connection,
    private store: Store,
    private alerts: Alerts,
  ) {
    // Resume a known outage across a process restart; a fresh startup never invents one.
    this.outage = store.get<Outage | null>('connectionOutage', null);
    rust.on('status', this.onStatus);
    rust.on('ready', this.onReady);
    if (this.outage) this.schedule();
  }
  get lastSuccessfulAt(): number | null {
    return this.store.get<number | null>('lastSuccessfulConnection', null);
  }
  private safely(work: () => void): void {
    if (this.stopped) return;
    try {
      work();
    } catch (error) {
      log.warn(
        { code: errorCode(error) },
        'Connection notification tracking failed; Rust+ recovery continues',
      );
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(
        () =>
          this.safely(() => {
            if (this.rust.online) this.onReady();
            else this.lost();
          }),
        10000,
      );
    }
  }
  private onStatus = (state: ConnectionState): void =>
    this.safely(() => {
      if (state === 'stopped' || state === 'connected') return;
      if (!this.armed && !this.outage) return;
      if (!this.outage) {
        this.outage = { id: randomUUID(), startedAt: Date.now(), notified: false };
        this.store.set('connectionOutage', this.outage);
      }
      this.schedule();
    });
  private onReady = (): void =>
    this.safely(() => {
      this.armed = true;
      this.store.set('lastSuccessfulConnection', Date.now());
      if (this.timer) clearTimeout(this.timer);
      if (this.outage) {
        // A slow initialization can finish after the threshold but before a delayed timer runs.
        if (!this.outage.notified && Date.now() - this.outage.startedAt >= 60000) this.lost();
        if (this.outage.notified) {
          const missing = this.rust.unavailableDevices;
          this.alerts.notify({
            id: `${this.outage.id}:restored`,
            family: this.outage.id,
            kind: 'connection-restored',
            title: missing.length
              ? '⚠️ Rust+ Connection Restored — Degraded Monitoring'
              : '✅ Rust+ Connection Restored',
            description: `The Rust+ connection has been restored.\n${
              missing.length
                ? `Monitoring is degraded. These required devices could not be initialized: ${missing
                    .map((d) => escapeMarkdown(d.name))
                    .join(', ')
                    .slice(0, 2000)}. Subscriptions will be retried automatically.`
                : 'Smart devices and raid monitoring are operational again.'
            }\n\nApproximate downtime: **${Math.max(1, Math.round((Date.now() - this.outage.startedAt) / 1000))} seconds**.`,
            at: Date.now(),
          });
        }
        this.outage = null;
        this.store.set('connectionOutage', null);
      }
    });
  private schedule(delay?: number): void {
    if (this.stopped || !this.outage || this.outage.notified) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () =>
        this.safely(() => {
          this.lost();
        }),
      delay ?? Math.max(0, this.outage.startedAt + 60000 - Date.now()),
    );
  }
  private lost(): void {
    if (!this.outage || this.outage.notified) return;
    if (Date.now() - this.outage.startedAt < 60000) {
      this.schedule();
      return;
    }
    this.alerts.notify({
      id: `${this.outage.id}:lost`,
      family: this.outage.id,
      kind: 'connection-lost',
      title: '⚠️ Rust+ Connection Lost',
      description: `The bot has lost its connection to the Rust server.\nSmart-device controls and raid monitoring are currently unavailable.\n${this.rust.state === 'invalid-credentials' ? 'Credentials were rejected. Re-pair the server, update the environment and restart the bot; automatic retries are paused.' : 'Automatic reconnection is in progress.'}`,
      at: this.outage.startedAt,
    });
    this.outage.notified = true;
    this.store.set('connectionOutage', this.outage);
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.rust.off('status', this.onStatus);
    this.rust.off('ready', this.onReady);
  }
}
