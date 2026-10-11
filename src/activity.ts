import { createHash, randomUUID } from 'node:crypto';
import { escapeMarkdown } from 'discord.js';
import type { Config } from './config';
import type { Store } from './database';
import type { Alerts } from './discord/alerts';
import type { Connection } from './rust/connection';
import type { RustResponse } from './rust/protocol';
import type { DeathPush } from './pairing/schema';
import { errorCode, log } from './log';

type Member = { name: string; online: boolean };
type Team = RustResponse['teamInfo'];

export class PlayerActivity {
  private started = false;
  private members?: Map<string, Member>;
  private timer?: NodeJS.Timeout;
  private work?: Promise<void>;
  private epoch = 0;
  private revision = 0;
  private onReady = () => this.reset();
  private onStatus = () => {
    if (!this.rust.online) this.reset();
  };
  private onTeam = (team: Team) => {
    if (!this.started || !this.rust.online || !this.members) return;
    try {
      this.observe(team);
    } catch (error) {
      this.report(error);
    }
  };
  constructor(
    private rust: Connection,
    private store: Store,
    private alerts: Pick<Alerts, 'notify' | 'wake'>,
    private config: Config,
  ) {}
  start(): void {
    if (this.started) return;
    this.started = true;
    this.rust.on('ready', this.onReady);
    this.rust.on('status', this.onStatus);
    this.rust.on('teamChanged', this.onTeam);
    if (this.rust.online) this.reset();
  }
  private reset(): void {
    ++this.epoch;
    this.members = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.started || !this.rust.online) return;
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, 30000);
  }
  private poll(): Promise<void> {
    if (!this.started || !this.rust.online || this.work) return Promise.resolve();
    const epoch = this.epoch,
      revision = this.revision;
    this.work = this.rust
      .request({ getTeamInfo: {} })
      .then((response) => {
        // A newer broadcast wins over an in-flight snapshot.
        if (this.started && this.rust.online && epoch === this.epoch && revision === this.revision)
          this.observe(response.teamInfo);
      })
      .catch((error) => {
        if (this.started && epoch === this.epoch) {
          this.members = undefined;
          this.report(error);
        }
      })
      .finally(() => {
        this.work = undefined;
      });
    return this.work;
  }
  private configured(): boolean {
    return !!this.store.get('alertChannel', this.config.ALERT_CHANNEL_ID || '');
  }
  private observe(team: Team): void {
    ++this.revision;
    if (!team || !Array.isArray(team.members) || team.members.length > 100) {
      this.members = undefined;
      return;
    }
    const next = new Map<string, Member>();
    for (const member of team.members) {
      const id = member.steamId.toString();
      if (
        !/^\d{17}$/.test(id) ||
        typeof member.isOnline !== 'boolean' ||
        typeof member.name !== 'string'
      )
        continue;
      next.set(id, { name: member.name.slice(0, 200), online: member.isOnline });
    }
    const previous = this.members;
    this.members = next;
    if (!previous || !this.configured()) return; // Startup/reconnect is baseline-only.
    for (const [id, member] of next) {
      const before = previous.get(id);
      if (!before || before.online === member.online) continue; // New members are baselines too.
      this.alerts.notify({
        id: `presence:${randomUUID()}`,
        family: `player:${id}`,
        kind: member.online ? 'player-online' : 'player-offline',
        title: member.online ? '🟢 Player Online' : '⚫ Player Offline',
        description: `**${escapeMarkdown(member.name)}** is now **${member.online ? 'online' : 'offline'}**.\nReported by Rust+ team information.`,
        at: Date.now(),
      });
    }
  }
  death(owner: string, steamId: string, event: DeathPush): boolean {
    if (!this.started || !this.configured()) return false;
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const name = this.members?.get(steamId)?.name || `Steam player ${steamId}`;
    const saved = this.store.queuePlayerNotification(
      {
        id: `death:${randomUUID()}`,
        family: `player:${steamId}`,
        kind: 'player-death',
        title: '☠️ Rust+ Death Notification',
        description: `**Player:** ${escapeMarkdown(name)}\n${escapeMarkdown(event.title)}\n${escapeMarkdown(event.message)}\n\nReported by Rust+ push notifications; delivery may have been delayed.`,
        at: Date.now(),
      },
      event.persistentId ? `death-wire:${hash(owner + ':' + event.persistentId)}` : undefined,
      `death-fingerprint:${hash(JSON.stringify([steamId, event.title, event.message]))}`,
    );
    if (saved) this.alerts.wake();
    return saved;
  }
  private report(error: unknown): void {
    log.warn({ code: errorCode(error) }, 'Rust+ player activity unavailable');
  }
  stop(): void {
    this.started = false;
    ++this.epoch;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.members = undefined;
    this.rust.off('ready', this.onReady);
    this.rust.off('status', this.onStatus);
    this.rust.off('teamChanged', this.onTeam);
  }
  async drain(): Promise<void> {
    await this.work;
  }
}
