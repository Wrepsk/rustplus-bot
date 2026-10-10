import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/database';

describe('SQLite restart and additive migration', () => {
  it('preserves existing registrations, settings, cooldowns and pending alerts across restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rust-bot-persistence-'));
    const path = join(directory, 'bot.sqlite');
    let store: Store | undefined;
    try {
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE alarm_outbox (id TEXT PRIMARY KEY,name TEXT NOT NULL,at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0);
        INSERT INTO alarm_outbox(id,name,at) VALUES ('42','Old pending alarm',1);`);
      old.close();
      store = new Store(path);
      const alarm = store.add({ id: '42', name: 'Outer Wall', type: 'alarm' });
      store.set('panel', { channelId: 'channel', messageId: 'persistent-panel', page: 0 });
      store.set('allowedRoles', ['operators']);
      store.recordAlarmActivation('42', 123456);
      store.queueRecoveryWarning(alarm, 'Already active');
      store.markSeen('chat-id');
      store.saveEcho('[Discord] Author: hi');
      store.close();
      store = new Store(path);
      expect(store.device('42')).toEqual(alarm);
      expect(store.get('panel', null)).toMatchObject({ messageId: 'persistent-panel' });
      expect(store.get('allowedRoles', [])).toEqual(['operators']);
      expect(store.lastAlert('42')).toBe(123456);
      expect(store.alarmJobs()).toMatchObject([{ id: '42', name: 'Old pending alarm', nonce: '' }]);
      expect(store.notificationJobs()).toHaveLength(1);
      expect(store.queueRecoveryWarning(alarm, 'duplicate')).toBe(false);
      expect(store.seen('chat-id')).toBe(true);
      expect(store.echo('[Discord] Author: hi')).toBe(true);
      store.acknowledgeNotification('alarm-recovery:42');
      store.close();
      store = new Store(path);
      expect(store.queueRecoveryWarning(alarm, 'still active')).toBe(false);
      store.clearRecoveryWarning('42');
      expect(store.queueRecoveryWarning(alarm, 'new monitoring gap')).toBe(true);
    } finally {
      store?.close();
      // The resolved deletion target must remain the temporary directory created by this test.
      if (resolve(directory).startsWith(resolve(tmpdir()) + sep))
        rmSync(directory, { recursive: true, force: true });
    }
  });
});
