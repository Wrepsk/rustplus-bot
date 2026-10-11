import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { deviceSchema, type Device } from './domain';

export interface Notification {
  id: string;
  family: string;
  kind: 'connection-lost' | 'connection-restored' | 'alarm-recovery';
  title: string;
  description: string;
  alarmId?: string;
  at: number;
}

export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('switch','alarm')), sensitive INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS alarm_alerts (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_echo (text TEXT PRIMARY KEY, expires INTEGER NOT NULL); PRAGMA user_version=1;`);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS alarm_outbox (id TEXT PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0)',
    );
    // Additive migration: retain every existing registration, setting and pending raid alert.
    this.db.exec(`CREATE TABLE IF NOT EXISTS notification_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, family TEXT NOT NULL,
      payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS notification_family ON notification_outbox(family,seq);
      CREATE TABLE IF NOT EXISTS alarm_recovery (id TEXT PRIMARY KEY, warned INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_seen_at ON chat_seen(at);`);
    if (
      !this.db
        .prepare('PRAGMA table_info(alarm_outbox)')
        .all()
        .some((r) => r.name === 'nonce')
    ) {
      this.db.exec("ALTER TABLE alarm_outbox ADD COLUMN nonce TEXT NOT NULL DEFAULT ''");
    }
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? (JSON.parse(String(row.value)) as T) : fallback;
  }
  set(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  devices(): Device[] {
    return this.db
      .prepare('SELECT * FROM devices ORDER BY rowid')
      .all()
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        type: r.type as Device['type'],
        sensitive: !!r.sensitive,
        enabled: !!r.enabled,
      }));
  }
  device(id: string): Device {
    const d = this.devices().find((d) => d.id === id);
    if (!d) throw new Error('Device is not registered.');
    return d;
  }
  add(input: unknown): Device {
    const parsed = deviceSchema.safeParse(input);
    if (!parsed.success) throw new Error('Invalid entity ID, name or device type.');
    const d = parsed.data;
    if (this.devices().length >= 100) throw new Error('Maximum 100 devices per server.');
    if (this.devices().some((x) => x.id === d.id))
      throw new Error('Entity ID is already registered.');
    this.db
      .prepare('INSERT INTO devices (id,name,type,sensitive) VALUES (?,?,?,?)')
      .run(d.id, d.name, d.type, Number(d.sensitive));
    return this.device(d.id);
  }
  remove(id: string): void {
    this.device(id);
    this.db.prepare('DELETE FROM devices WHERE id=?').run(id);
    this.acknowledgeAlarm(id);
    this.clearRecoveryWarning(id);
    this.removeRecoveryNotification(id);
  }
  rename(id: string, name: string): void {
    const d = this.device(id);
    const parsed = deviceSchema.safeParse({ ...d, name });
    if (!parsed.success) throw new Error('Invalid device name.');
    this.db.prepare('UPDATE devices SET name=? WHERE id=?').run(parsed.data.name, id);
  }
  enable(id: string, enabled: boolean): void {
    if (this.device(id).type !== 'alarm') throw new Error('Select a Smart Alarm.');
    this.db.prepare('UPDATE devices SET enabled=? WHERE id=?').run(Number(enabled), id);
    if (!enabled) {
      this.acknowledgeAlarm(id);
      this.removeRecoveryNotification(id);
      this.clearRecoveryWarning(id);
    }
  }
  lastAlert(id: string): number {
    return Number(this.db.prepare('SELECT at FROM alarm_alerts WHERE id=?').get(id)?.at ?? 0);
  }
  saveAlert(id: string, at: number): void {
    this.db
      .prepare('INSERT INTO alarm_alerts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at')
      .run(id, at);
  }
  enqueueAlarm(id: string, name: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO alarm_outbox (id,name,at,nonce) VALUES (?,?,?,?)')
      .run(id, name, Date.now(), randomUUID());
  }
  recordAlarmActivation(id: string, at: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.saveAlert(id, at);
      this.enqueueAlarm(id, this.device(id).name);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  alarmJobs(): { id: string; name: string; at: number; attempts: number; nonce: string }[] {
    return this.db
      .prepare('SELECT * FROM alarm_outbox WHERE next_at<=? ORDER BY at')
      .all(Date.now())
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        at: Number(r.at),
        attempts: Number(r.attempts),
        nonce: String(r.nonce),
      }));
  }
  acknowledgeAlarm(id: string, nonce?: string): void {
    if (nonce === undefined) this.db.prepare('DELETE FROM alarm_outbox WHERE id=?').run(id);
    else this.db.prepare('DELETE FROM alarm_outbox WHERE id=? AND nonce=?').run(id, nonce);
  }
  retryAlarm(id: string, attempts: number, nonce?: string): void {
    this.db
      .prepare(
        'UPDATE alarm_outbox SET attempts=?, next_at=? WHERE id=? AND (? IS NULL OR nonce=?)',
      )
      .run(
        attempts,
        Date.now() + Math.min(300000, 5000 * 2 ** Math.min(attempts, 6)),
        id,
        nonce ?? null,
        nonce ?? null,
      );
  }
  enqueueNotification(notification: Notification): void {
    if (this.db.prepare('SELECT 1 FROM notification_outbox WHERE id=?').get(notification.id))
      return;
    if (Number(this.db.prepare('SELECT count(*) AS n FROM notification_outbox').get()!.n) >= 1000)
      throw new Error('Notification queue is full');
    this.db
      .prepare('INSERT INTO notification_outbox (id,family,payload) VALUES (?,?,?)')
      .run(notification.id, notification.family, JSON.stringify(notification));
  }
  notificationJobs(): (Notification & { attempts: number })[] {
    // Preserve lost -> restored order even when the lost notification is backing off.
    return this.db
      .prepare(
        `SELECT payload,attempts FROM notification_outbox n WHERE next_at<=?
      AND NOT EXISTS (SELECT 1 FROM notification_outbox older WHERE older.family=n.family AND older.seq<n.seq)
      ORDER BY seq LIMIT 100`,
      )
      .all(Date.now())
      .map((r) => ({
        ...(JSON.parse(String(r.payload)) as Notification),
        attempts: Number(r.attempts),
      }));
  }
  acknowledgeNotification(id: string): void {
    this.db.prepare('DELETE FROM notification_outbox WHERE id=?').run(id);
  }
  retryNotification(id: string, attempts: number): void {
    this.db
      .prepare('UPDATE notification_outbox SET attempts=?,next_at=? WHERE id=?')
      .run(attempts, Date.now() + Math.min(300000, 5000 * 2 ** Math.min(attempts, 6)), id);
  }
  queueRecoveryWarning(device: Device, description: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT warned FROM alarm_recovery WHERE id=?').get(device.id)?.warned) {
        this.db.exec('COMMIT');
        return false;
      }
      this.enqueueNotification({
        id: `alarm-recovery:${device.id}`,
        family: `alarm:${device.id}`,
        kind: 'alarm-recovery',
        alarmId: device.id,
        title: '⚠️ Alarm Active After Reconnection',
        description,
        at: Date.now(),
      });
      this.db
        .prepare('INSERT INTO alarm_recovery VALUES (?,1) ON CONFLICT(id) DO UPDATE SET warned=1')
        .run(device.id);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  clearRecoveryWarning(id: string): void {
    this.db.prepare('DELETE FROM alarm_recovery WHERE id=?').run(id);
  }
  private removeRecoveryNotification(id: string): void {
    this.acknowledgeNotification(`alarm-recovery:${id}`);
  }
  seen(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM chat_seen WHERE key=?').get(key);
  }
  markSeen(key: string): void {
    this.db
      .prepare('INSERT INTO chat_seen VALUES (?,?) ON CONFLICT(key) DO UPDATE SET at=excluded.at')
      .run(key, Date.now());
    this.db.prepare('DELETE FROM chat_seen WHERE at < ?').run(Date.now() - 7 * 86400000);
    this.db
      .prepare(
        'DELETE FROM chat_seen WHERE key IN (SELECT key FROM chat_seen ORDER BY at DESC LIMIT -1 OFFSET 20000)',
      )
      .run();
  }
  echo(text: string): boolean {
    return (
      Number(
        this.db.prepare('SELECT expires FROM chat_echo WHERE text=?').get(text)?.expires ?? 0,
      ) > Date.now()
    );
  }
  saveEcho(text: string): void {
    this.db.prepare('DELETE FROM chat_echo WHERE expires<=?').run(Date.now());
    this.db
      .prepare(
        'INSERT INTO chat_echo VALUES (?,?) ON CONFLICT(text) DO UPDATE SET expires=excluded.expires',
      )
      .run(text, Date.now() + 300000);
    this.db
      .prepare(
        'DELETE FROM chat_echo WHERE text IN (SELECT text FROM chat_echo ORDER BY expires DESC LIMIT -1 OFFSET 20000)',
      )
      .run();
  }
  close(): void {
    this.db.close();
  }
}
