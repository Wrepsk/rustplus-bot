import { describe, expect, it } from 'vitest';
import {
  AlarmTransitions,
  ExpiringSet,
  chatChunks,
  deviceSchema,
  isEcho,
  messageKey,
  needsConfirmation,
  plainText,
} from '../src/domain';
import { Permissions } from '../src/permissions';
import { Store } from '../src/database';

describe('Discord permissions', () => {
  const permissions = new Permissions('guild', 'owner', () => ['operator']);
  const user = { id: 'friend', guildId: 'guild', administrator: false, roles: [] as string[] };
  it('denies unprivileged users and direct component attempts', () => {
    expect(permissions.operate(user)).toBe(false);
    expect(permissions.admin(user)).toBe(false);
  });
  it('allows configured roles to operate, but not administer', () => {
    expect(permissions.operate({ ...user, roles: ['operator'] })).toBe(true);
    expect(permissions.admin({ ...user, roles: ['operator'] })).toBe(false);
  });
  it('allows the initial administrator and guild admins', () => {
    expect(permissions.admin({ ...user, id: 'owner' })).toBe(true);
    expect(permissions.admin({ ...user, administrator: true })).toBe(true);
  });
  it('denies all roles and administrators in other guilds or DMs', () => {
    expect(
      permissions.operate({
        ...user,
        id: 'owner',
        guildId: 'elsewhere',
        administrator: true,
        roles: ['operator'],
      }),
    ).toBe(false);
    expect(permissions.admin({ ...user, id: 'owner', guildId: null })).toBe(false);
  });
  it('observes role configuration changes immediately', () => {
    let roles = ['operator'];
    const p = new Permissions('guild', 'owner', () => roles);
    expect(p.operate({ ...user, roles: ['operator'] })).toBe(true);
    roles = [];
    expect(p.operate({ ...user, roles: ['operator'] })).toBe(false);
  });
  it('never grants access through a legacy persisted @everyone allow-list entry', () => {
    const permissions = new Permissions('guild', 'owner', () => ['guild', 'operator']);
    expect(permissions.operate({ ...user, roles: ['guild'] })).toBe(false);
    expect(permissions.operate({ ...user, roles: ['guild', 'operator'] })).toBe(true);
    expect(permissions.operate({ ...user, id: 'owner', roles: ['guild'] })).toBe(true);
  });
});
describe('chat deduplication and loop prevention', () => {
  const message = { steamId: '123', name: 'Hakan', message: 'hello', time: 12345 };
  it('only suppresses a matching outgoing message from the connected player', () => {
    const sent = new ExpiringSet();
    sent.add('hello');
    expect(isEcho(message, '123', sent)).toBe(true);
    expect(isEcho({ ...message, steamId: 'other' }, '123', sent)).toBe(false);
    expect(isEcho({ ...message, message: 'a real reply' }, '123', sent)).toBe(false);
  });
  it('includes Steam identity, time and content in history keys', () => {
    expect(messageKey(message)).not.toBe(messageKey({ ...message, time: 12346 }));
    expect(messageKey(message)).not.toBe(messageKey({ ...message, steamId: '321' }));
  });
  it('expires fingerprints and bounds memory', () => {
    const set = new ExpiringSet(100, 2);
    set.add('one', 0);
    expect(set.has('one', 99)).toBe(true);
    expect(set.has('one', 100)).toBe(false);
    set.add('a', 100);
    set.add('b', 100);
    set.add('c', 100);
    expect(set.has('a', 100)).toBe(false);
  });
  it('strips mentions, markdown and control characters', () => {
    expect(plainText('**hi** <@123> <@&456> <#789> @everyone\n`test`')).toBe(
      'hi @user @role #channel everyone test',
    );
  });
  it('splits long Unicode messages and prefixes every part without breaking surrogate pairs', () => {
    const chunks = chatChunks('Alper', '😀'.repeat(200));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(128);
      expect(chunk.startsWith('[Discord] Alper: ')).toBe(true);
      expect(chunk).not.toMatch(/[\ud800-\udbff]$/);
    }
    expect(chunks.map((s) => s.slice('[Discord] Alper: '.length)).join('')).toBe('😀'.repeat(200));
  });
  it('does not relay empty messages', () => {
    expect(chatChunks('name', '\n   ')).toEqual([]);
  });
});
describe('alarm transitions', () => {
  function monitor() {
    const saved = new Map<string, number>();
    return {
      saved,
      alarm: new AlarmTransitions(
        60000,
        (id) => saved.get(id) ?? 0,
        (id, at) => saved.set(id, at),
      ),
    };
  }
  it('never alerts on an initial active state or reconnect baseline', () => {
    const { alarm } = monitor();
    expect(alarm.change('a', true, true, 100000)).toBe(false);
    alarm.reset();
    alarm.sync('a', true);
    expect(alarm.change('a', true, true, 200000)).toBe(false);
  });
  it('only alerts on a rising edge and applies persistent per-alarm cooldown', () => {
    const { alarm, saved } = monitor();
    alarm.sync('a', false);
    expect(alarm.change('a', true, true, 100000)).toBe(true);
    expect(saved.get('a')).toBe(100000);
    expect(alarm.change('a', true, true, 170000)).toBe(false);
    alarm.change('a', false, true, 110000);
    expect(alarm.change('a', true, true, 120000)).toBe(false);
    alarm.change('a', false, true, 160000);
    expect(alarm.change('a', true, true, 170000)).toBe(true);
  });
  it('tracks disabled alarms without sending notifications and keeps alarms independent', () => {
    const { alarm } = monitor();
    alarm.sync('a', false);
    alarm.sync('b', false);
    expect(alarm.change('a', true, false, 100000)).toBe(false);
    expect(alarm.change('a', true, true, 100001)).toBe(false);
    expect(alarm.change('b', true, true, 100001)).toBe(true);
  });
});
describe('device validation and persistence', () => {
  it('rejects invalid, overflow and zero IDs, unsupported types and blank names', () => {
    for (const id of ['0', '-1', '4294967296', '1; rm', '1.5'])
      expect(deviceSchema.safeParse({ id, name: 'Lights', type: 'switch' }).success).toBe(false);
    expect(deviceSchema.safeParse({ id: '12', name: ' ', type: 'switch' }).success).toBe(false);
    expect(deviceSchema.safeParse({ id: '12', name: 'Lights', type: 'turret' }).success).toBe(
      false,
    );
  });
  it('recognizes hazardous labels and explicit sensitive flags', () => {
    expect(needsConfirmation({ name: 'Explosives', sensitive: false })).toBe(true);
    expect(needsConfirmation({ name: 'Lights', sensitive: true })).toBe(true);
    expect(needsConfirmation({ name: 'Lights', sensitive: false })).toBe(false);
  });
  it('uses registered entities only and preserves configuration, alarm times and dedup records', () => {
    const store = new Store(':memory:');
    try {
      store.add({ id: '42', name: 'Outer wall', type: 'alarm' });
      expect(() => store.device('999')).toThrow();
      expect(() => store.add({ id: '42', name: 'duplicate', type: 'switch' })).toThrow();
      store.enable('42', false);
      expect(store.device('42').enabled).toBe(false);
      store.rename('42', 'West wall');
      expect(store.device('42').name).toBe('West wall');
      store.set('chatEnabled', true);
      expect(store.get('chatEnabled', false)).toBe(true);
      store.saveAlert('42', 123);
      expect(store.lastAlert('42')).toBe(123);
      store.markSeen('key');
      expect(store.seen('key')).toBe(true);
      store.saveEcho('hello');
      expect(store.echo('hello')).toBe(true);
      expect(store.echo('other')).toBe(false);
      store.remove('42');
      expect(store.devices()).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
