import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { deviceSchema, type Device } from './domain';

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
    if (this.devices().length >= 100) throw new Error('Maximum 100 devices per bot.');
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
    if (!enabled) this.acknowledgeAlarm(id);
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
      .prepare('INSERT OR IGNORE INTO alarm_outbox (id,name,at) VALUES (?,?,?)')
      .run(id, name, Date.now());
  }
  alarmJobs(): { id: string; name: string; at: number; attempts: number }[] {
    return this.db
      .prepare('SELECT * FROM alarm_outbox WHERE next_at<=? ORDER BY at')
      .all(Date.now())
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        at: Number(r.at),
        attempts: Number(r.attempts),
      }));
  }
  acknowledgeAlarm(id: string): void {
    this.db.prepare('DELETE FROM alarm_outbox WHERE id=?').run(id);
  }
  retryAlarm(id: string, attempts: number): void {
    this.db
      .prepare('UPDATE alarm_outbox SET attempts=?, next_at=? WHERE id=?')
      .run(attempts, Date.now() + Math.min(300000, 5000 * 2 ** Math.min(attempts, 6)), id);
  }
  seen(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM chat_seen WHERE key=?').get(key);
  }
  markSeen(key: string): void {
    this.db.prepare('INSERT OR IGNORE INTO chat_seen VALUES (?,?)').run(key, Date.now());
    this.db.prepare('DELETE FROM chat_seen WHERE at < ?').run(Date.now() - 7 * 86400000);
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
  }
  close(): void {
    this.db.close();
  }
}
