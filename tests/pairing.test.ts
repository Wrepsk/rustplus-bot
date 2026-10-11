import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialVault,
  decryptPairing,
  encryptPairing,
  pairingChallenge,
} from '../src/pairing/crypto';
import { parsePairing } from '../src/pairing/schema';
import { PairingService } from '../src/pairing/service';
import { Store } from '../src/database';
import { Servers } from '../src/servers';
import type { Config } from '../src/config';

vi.mock('../src/pairing/listener', () => ({
  PairingListener: class {
    connect = vi.fn(async () => {});
    destroy = vi.fn();
  },
}));
const directories: string[] = [],
  stores: Store[] = [],
  services: PairingService[] = [],
  registries: Servers[] = [];
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'rust-pairing-test-'));
  directories.push(path);
  const store = new Store(join(path, 'bot.sqlite'));
  stores.push(store);
  const config = {
    DATABASE_PATH: join(path, 'bot.sqlite'),
    BASE_NAME: 'Main Base',
    RUST_SERVER_IP: 'rust.example.org',
    RUST_APP_PORT: 28082,
    RUST_STEAM_ID: '76561198000000000',
    RUST_PLAYER_TOKEN: '-123',
    ADMIN_USER_ID: 'owner',
  } as Config;
  const servers = new Servers(config, store);
  registries.push(servers);
  const service = new PairingService(store, servers.vault);
  services.push(service);
  return { path, store, config, servers, service };
}
afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const server of registries.splice(0)) server.close();
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) {
    if (!path.startsWith(join(tmpdir(), 'rust-pairing-test-')))
      throw new Error('Unsafe cleanup path');
    rmSync(path, { recursive: true, force: true });
  }
  vi.useRealTimers();
});
const listener = { androidId: '123456789', securityToken: '987654321' };
const pairing = {
  type: 'server' as const,
  ip: 'second.example.org',
  port: 28083,
  name: 'Second Server',
  playerId: '76561198000000001',
  playerToken: '-456',
};

describe('encrypted Discord pairing', () => {
  it.each([false, true])(
    'exports encrypted data from the actual helper (minimal config: %s)',
    async (minimal) => {
      const { path } = fixture();
      const challenge = pairingChallenge();
      const registration = join(path, 'test-pairing.json');
      writeFileSync(
        registration,
        JSON.stringify({
          fcm_credentials: { gcm: listener, fcm: { token: 'unused-test-fcm' } },
          rustplus_auth_token: 'unused-test-auth',
        }),
        { mode: 0o600 },
      );
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          join(process.cwd(), 'src', 'pairing', 'helper.ts'),
          '--code',
          challenge.code,
          '--config',
          registration,
          ...(minimal ? ['--minimal-config'] : []),
        ],
        { timeout: 10000 },
      );
      const data = /\/pair import data:([\w.-]+)/.exec(stdout)?.[1];
      expect(data).toBeTruthy();
      expect(decryptPairing(challenge.privateKey, data!)).toEqual(listener);
      expect(stdout).not.toContain(listener.securityToken);
      const stored = JSON.parse(readFileSync(registration, 'utf8'));
      expect(stored.fcm_credentials.gcm).toEqual(listener);
      if (minimal) expect(stored).toEqual({ fcm_credentials: { gcm: listener } });
      else expect(stored.rustplus_auth_token).toBe('unused-test-auth');
      expect(stdout).not.toContain('unused-test-auth');
    },
  );
  it('round trips without exposing plaintext credentials and rejects tampering/wrong keys', () => {
    const challenge = pairingChallenge(),
      other = pairingChallenge();
    const encrypted = encryptPairing(challenge.code, listener);
    expect(encrypted).not.toContain(listener.securityToken);
    expect(decryptPairing(challenge.privateKey, encrypted)).toEqual(listener);
    expect(() => decryptPairing(other.privateKey, encrypted)).toThrow();
    const pieces = encrypted.split('.');
    const body = Buffer.from(pieces[2], 'base64url');
    body[30] ^= 1;
    pieces[2] = body.toString('base64url');
    expect(() => decryptPairing(challenge.privateKey, pieces.join('.'))).toThrow();
  });
  it('binds imports to the Discord user and prevents replay', () => {
    const { service, store } = fixture();
    const code = service.challenge('alice'),
      data = encryptPairing(code, listener);
    expect(() => service.import('bob', data)).toThrow('another user');
    service.import('alice', data);
    expect(service.linked('alice')).toBe(true);
    expect(store.get('pairingCredentials:alice', '')).not.toContain(listener.securityToken);
    expect(() => service.import('alice', data)).toThrow();
    service.unlink('alice');
    expect(service.linked('alice')).toBe(false);
    expect(store.get('pairingCredentials:alice', '')).toBe('');
  });
  it('expires and replaces pairing challenges without consuming a valid challenge on bad input', () => {
    vi.useFakeTimers();
    const { service } = fixture();
    const old = encryptPairing(service.challenge('alice'), listener);
    const current = encryptPairing(service.challenge('alice'), listener);
    expect(() => service.import('alice', old)).toThrow();
    expect(() => service.import('alice', current + 'invalid')).toThrow();
    service.import('alice', current);
    const expired = encryptPairing(service.challenge('alice'), listener);
    vi.advanceTimersByTime(15 * 60000 + 1);
    expect(() => service.import('alice', expired)).toThrow('expired');
  });
  it('keeps inboxes private, encrypted, deduplicated and bounded', () => {
    const { service, store } = fixture();
    service.receive('alice', pairing);
    service.receive('alice', pairing);
    expect(service.inbox('alice')).toHaveLength(1);
    expect(service.inbox('bob')).toEqual([]);
    expect(JSON.stringify(store.get('pairingInbox', []))).not.toContain('playerToken');
    const id = service.inbox('alice')[0].id;
    expect(() => service.take('bob', id)).toThrow();
    for (let i = 0; i < 60; ++i) service.receive('alice', { ...pairing, port: 1000 + i });
    expect(service.inbox('alice')).toHaveLength(50);
  });
  it('parses the documented FCM body and rejects unrelated/invalid notifications', () => {
    const wire = (body: unknown, channel = 'pairing') => ({
      appData: [
        { key: 'channelId', value: channel },
        { key: 'body', value: JSON.stringify(body) },
      ],
    });
    expect(parsePairing(wire(pairing))).toEqual(pairing);
    expect(
      parsePairing(
        wire({
          type: 'entity',
          ip: pairing.ip,
          port: '28083',
          entityId: 1234,
          entityType: '1',
          entityName: 'Lights',
        }),
      ),
    ).toMatchObject({ entityId: '1234', entityType: 1 });
    expect(parsePairing(wire(pairing, 'alarm'))).toBeNull();
    expect(parsePairing(wire({ ...pairing, playerToken: 'secret-invalid-token' }))).toBeNull();
    expect(parsePairing(wire({ ...pairing, ip: '../wrong/path' }))).toBeNull();
    expect(
      parsePairing(
        wire({ type: 'entity', ip: pairing.ip, port: pairing.port, entityId: 0, entityType: 1 }),
      ),
    ).toBeNull();
  });
});
describe('server profiles and database upgrade', () => {
  it('preserves the current database and isolates identical device IDs on multiple servers', () => {
    const { servers, store } = fixture();
    store.add({ id: '42', name: 'Original lights', type: 'switch' });
    store.set('panel', { channelId: 'old-channel', messageId: 'old-panel' });
    store.set('chatChannel', 'old-chat');
    store.markSeen('original-message');
    const secondary = servers.add(pairing);
    servers.store(secondary.id).add({ id: '42', name: 'Other lights', type: 'switch' });
    expect(servers.store('default')).toBe(store);
    expect(store.device('42').name).toBe('Original lights');
    expect(servers.store(secondary.id).device('42').name).toBe('Other lights');
    expect(servers.store(secondary.id).seen('original-message')).toBe(false);
    expect(store.get('panel', null)).toMatchObject({ messageId: 'old-panel' });
    expect(servers.connectionConfig(secondary.id).RUST_PLAYER_TOKEN).toBe('-456');
    expect(servers.connectionConfig(secondary.id).ALERT_CHANNEL_ID).toBeUndefined();
    expect(() => servers.store('../outside')).toThrow();
  });
  it('persists profiles, per-user selections and encrypted credentials across restart', () => {
    const { servers, store, path, config } = fixture();
    const second = servers.add(pairing);
    servers.link(second.id, 'alice', {
      playerId: pairing.playerId,
      playerToken: pairing.playerToken,
    });
    servers.select('alice', second.id);
    servers.rename(second.id, '  Renamed Trio  ');
    servers.store(second.id).add({ id: '42', name: 'Lights', type: 'switch' });
    const secondVault = new CredentialVault(join(path, 'credentials.key'));
    const stored = store.get(`identity:${second.id}:alice`, '');
    expect(secondVault.decrypt(stored, `identity:${second.id}:alice`)).toMatchObject({
      playerToken: '-456',
    });
    expect(() => secondVault.decrypt(stored, `identity:${second.id}:bob`)).toThrow();
    expect(readFileSync(join(path, 'credentials.key')).length).toBe(32);
    servers.close();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new Store(config.DATABASE_PATH);
    stores.push(reopened);
    const recovered = new Servers(config, reopened);
    registries.push(recovered);
    expect(recovered.selected('alice')).toBe(second.id);
    expect(recovered.get(second.id).name).toBe('Renamed Trio');
    expect(recovered.connectionConfig(second.id).BASE_NAME).toBe('Renamed Trio');
    expect(recovered.identity(second.id, 'alice')?.playerToken).toBe('-456');
    expect(recovered.store(second.id).device('42').name).toBe('Lights');
  });
  it('does not relink an explicitly unlinked owner on restart or replace a monitoring identity', () => {
    const { servers, store, config } = fixture();
    servers.unlink('owner');
    const reloaded = new Servers(config, store);
    registries.push(reloaded);
    expect(reloaded.identity('default', 'owner')).toBeUndefined();
    expect(() =>
      servers.add({ ...pairing, ip: config.RUST_SERVER_IP, port: config.RUST_APP_PORT }),
    ).toThrow('monitoring account');
  });
  it('refuses to silently regenerate a missing credentials key for existing encrypted data', () => {
    const { servers, store, config, path } = fixture();
    servers.close();
    rmSync(join(path, 'credentials.key'));
    expect(() => new Servers(config, store)).toThrow('Restore the original credentials.key');
  });
});
