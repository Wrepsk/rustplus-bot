import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Servers } from '../src/servers';
import { Store } from '../src/database';
import type { Config } from '../src/config';

let directory: string, root: Store, servers: Servers, config: Config, second: string;
const pairing = {
  type: 'server',
  name: 'Second',
  ip: 'second.example.org',
  port: 28083,
  playerId: '76561198000000001',
  playerToken: '456',
} as const;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'rust-server-removal-'));
  config = {
    DATABASE_PATH: join(directory, 'bot.sqlite'),
    BASE_NAME: 'Main',
    RUST_SERVER_IP: 'rust.example.org',
    RUST_APP_PORT: 28082,
    RUST_STEAM_ID: '76561198000000000',
    RUST_PLAYER_TOKEN: '123',
    ADMIN_USER_ID: 'owner',
  } as Config;
  root = new Store(config.DATABASE_PATH);
  servers = new Servers(config, root);
  second = servers.add(pairing).id;
});
afterEach(() => {
  vi.restoreAllMocks();
  servers.close();
  root.close();
  if (!directory.startsWith(join(tmpdir(), 'rust-server-removal-')))
    throw new Error('Unsafe cleanup path');
  rmSync(directory, { recursive: true, force: true });
});
function restart() {
  servers.close();
  root.close();
  root = new Store(config.DATABASE_PATH);
  servers = new Servers(config, root);
}
function seed(store: Store) {
  const alarm = store.add({ id: '42', name: 'Outer Wall', type: 'alarm' });
  store.recordAlarmActivation('42', Date.now());
  store.queueRecoveryWarning(alarm, 'Already active');
  store.markSeen('chat-id');
  store.saveEcho('echo');
  store.set('chatChannel', 'chat');
  store.set('chatEnabled', true);
  store.set('panel', { channelId: 'panels', messageId: 'panel' });
  store.set('cameraPanel', { channelId: 'panels', messageId: 'camera' });
  store.set('serverPanelMessages', [{ channelId: 'old', messageId: 'old-panel' }]);
  store.set('cameras', [{ id: 'ROOF', name: 'Roof' }]);
  store.set('cameraShare:owner', true);
  store.set('allowedRoles', ['operator']);
  store.set('alertChannel', 'alerts');
  store.set('alertRole', 'raid');
  store.set('connectionOutage', { since: Date.now() });
  store.set('lastSuccessfulConnection', Date.now());
}
function expectCleared(store: Store) {
  expect(store.devices()).toEqual([]);
  expect(store.alarmJobs()).toEqual([]);
  expect(store.notificationJobs()).toEqual([]);
  expect(store.lastAlert('42')).toBe(0);
  expect(store.seen('chat-id')).toBe(false);
  expect(store.echo('echo')).toBe(false);
  for (const key of [
    'chatChannel',
    'chatEnabled',
    'panel',
    'cameraPanel',
    'serverPanelMessages',
    'cameras',
    'cameraShare:owner',
    'allowedRoles',
    'alertChannel',
    'alertRole',
    'connectionOutage',
    'lastSuccessfulConnection',
  ])
    expect(store.get(key, null)).toBeNull();
}
describe('persistent server deletion', () => {
  it('removes the original server without deleting global pairing data or another server', () => {
    seed(root);
    seed(servers.store(second));
    root.set('pairingUsers', ['owner']);
    root.set('pairingCredentials:owner', 'saved-encrypted-data');
    root.set('discordGuild', 'guild');
    root.set('rustScope', 'original-scope');
    servers.link(second, 'friend', {
      playerId: pairing.playerId,
      playerToken: pairing.playerToken,
    });
    servers.select('owner', 'default');
    servers.remove('default');
    expectCleared(root);
    expect(servers.identity('default', 'owner')).toBeUndefined();
    expect(servers.identity(second, 'friend')).toBeDefined();
    expect(servers.selected('owner')).toBe(second);
    expect(root.get('selectedServer:owner', null)).toBeNull();
    restart();
    expect(servers.list().map((p) => p.id)).toEqual([second]);
    expect(root.get('pairingUsers', [])).toEqual(['owner']);
    expect(root.get('pairingCredentials:owner', '')).toBe('saved-encrypted-data');
    expect(root.get('discordGuild', '')).toBe('guild');
    expect(root.get('rustScope', '')).toBe('original-scope');
    expect(servers.store(second).device('42').name).toBe('Outer Wall');
    expect(servers.connectionConfig(second).RUST_PLAYER_TOKEN).toBe(pairing.playerToken);
  });
  it('removes secondary configuration and credentials across restarts and starts a re-paired server cleanly', () => {
    seed(servers.store(second));
    seed(root);
    servers.link(second, 'friend', {
      playerId: pairing.playerId,
      playerToken: pairing.playerToken,
    });
    root.set(`identityInvalid:${second}:friend`, true);
    servers.remove(second);
    restart();
    expect(servers.list().map((p) => p.id)).toEqual(['default']);
    for (const key of [
      `serverCredentials:${second}`,
      `identity:${second}:friend`,
      `identityUsers:${second}`,
      `identityInvalid:${second}:friend`,
      `chatOwnSteamIds:${second}`,
    ])
      expect(root.get(key, null)).toBeNull();
    expect(servers.add(pairing).id).toBe(second);
    expectCleared(servers.store(second));
    expect(root.device('42').name).toBe('Outer Wall');
    expect(servers.identities(second)).toEqual([]);
  });
  it('keeps an intentionally empty server list across restarts and retains the original credential vault', () => {
    const encrypted = servers.vault.encrypt({ androidId: 'mock' }, 'test');
    root.set('pairingCredentials:owner', encrypted);
    servers.remove(second);
    servers.remove('default');
    restart();
    expect(servers.list()).toEqual([]);
    expect(servers.selected('owner')).toBe('');
    expect(servers.identity('default', 'owner')).toBeUndefined();
    expect(servers.vault.decrypt(root.get('pairingCredentials:owner', ''), 'test')).toEqual({
      androidId: 'mock',
    });
    servers.add(pairing);
    restart();
    expect(servers.list().map((p) => p.id)).toEqual([second]);
    expect(servers.store(second).devices()).toEqual([]);
  });
  it('rolls back original-server deletion if saving the profile list fails', () => {
    seed(root);
    const set = root.set.bind(root);
    vi.spyOn(root, 'set').mockImplementation((key, value) => {
      if (key === 'serverProfiles') throw new Error('Synthetic database failure');
      set(key, value);
    });
    expect(() => servers.remove('default')).toThrow('database failure');
    expect(root.device('42').name).toBe('Outer Wall');
    expect(servers.identity('default', 'owner')).toBeDefined();
    expect(servers.get('default')).toBeDefined();
    expect(root.notificationJobs()).toHaveLength(1);
  });
});
