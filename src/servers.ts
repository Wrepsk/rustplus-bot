import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { Config } from './config';
import { Store } from './database';
import { CredentialVault } from './pairing/crypto';
import { serverPairingSchema } from './pairing/schema';

export interface ServerProfile {
  id: string;
  name: string;
  ip: string;
  port: number;
  enabled: boolean;
}
const credentialsSchema = serverPairingSchema.pick({ playerId: true, playerToken: true });
export type PlayerCredentials = z.infer<typeof credentialsSchema>;

export class Servers {
  readonly vault: CredentialVault;
  private stores = new Map<string, Store>();
  constructor(
    readonly config: Config,
    readonly root: Store,
  ) {
    const keyPath = join(dirname(config.DATABASE_PATH), 'credentials.key');
    if (root.get<ServerProfile[]>('serverProfiles', []).length && !existsSync(keyPath))
      throw Object.assign(
        new Error('Restore the original credentials.key from the data-volume backup.'),
        { code: 'CREDENTIALS_KEY_MISSING' },
      );
    this.vault = new CredentialVault(keyPath);
    if (!root.get<ServerProfile[]>('serverProfiles', []).length) {
      root.set('serverProfiles', [
        {
          id: 'default',
          name: config.BASE_NAME,
          ip: config.RUST_SERVER_IP,
          port: config.RUST_APP_PORT,
          enabled: true,
        },
      ]);
    }
    this.stores.set('default', root);
    // The administrator's existing server pairing is already an authenticated identity.
    if (!root.get('initialIdentityImported', false)) {
      this.link('default', config.ADMIN_USER_ID, {
        playerId: config.RUST_STEAM_ID,
        playerToken: config.RUST_PLAYER_TOKEN,
      });
      root.set('initialIdentityImported', true);
    }
  }
  list(): ServerProfile[] {
    return this.root.get('serverProfiles', []);
  }
  get(id: string): ServerProfile {
    const profile = this.list().find((p) => p.id === id);
    if (!profile) throw new Error('Unknown server. Run /server list.');
    return profile;
  }
  match(ip: string, port: number): ServerProfile | undefined {
    return this.list().find((p) => p.ip.toLowerCase() === ip.toLowerCase() && p.port === port);
  }
  store(id: string): Store {
    this.get(id);
    let store = this.stores.get(id);
    if (!store) {
      store = new Store(join(dirname(this.config.DATABASE_PATH), 'servers', `${id}.sqlite`));
      this.stores.set(id, store);
    }
    return store;
  }
  connectionConfig(id: string): Config {
    const profile = this.get(id);
    const data = this.root.get(`serverCredentials:${id}`, '');
    const credentials = data
      ? credentialsSchema.parse(this.vault.decrypt(data, `server:${id}`))
      : { playerId: this.config.RUST_STEAM_ID, playerToken: this.config.RUST_PLAYER_TOKEN };
    return {
      ...this.config,
      BASE_NAME: profile.name,
      RUST_SERVER_IP: profile.ip,
      RUST_APP_PORT: profile.port,
      RUST_STEAM_ID: credentials.playerId,
      RUST_PLAYER_TOKEN: credentials.playerToken,
      // Additional servers must explicitly configure their own channels.
      ...(id === 'default' ? {} : { ALERT_CHANNEL_ID: undefined, ALERT_ROLE_ID: undefined }),
    };
  }
  add(input: unknown, name?: string): ServerProfile {
    const data = serverPairingSchema.parse(input);
    const existing = this.match(data.ip, data.port);
    const id =
      existing?.id ||
      createHash('sha256')
        .update(`${data.ip.toLowerCase()}:${data.port}`)
        .digest('hex')
        .slice(0, 12);
    if (!existing && this.list().length >= 10) throw new Error('Maximum 10 saved servers.');
    const profile: ServerProfile = {
      id,
      name: (name || data.name).trim().slice(0, 80),
      ip: data.ip,
      port: data.port,
      enabled: existing?.enabled ?? true,
    };
    if (!profile.name) throw new Error('Choose a server name.');
    if (existing) {
      // Re-pairing the same server must not silently put existing devices under
      // another Steam account. Personal pairings use link() instead.
      if (this.connectionConfig(id).RUST_STEAM_ID !== data.playerId)
        throw new Error(
          'This server already has a monitoring account. This pairing can only link your personal chat identity.',
        );
    }
    this.root.set(
      `serverCredentials:${id}`,
      this.vault.encrypt(
        {
          playerId: data.playerId,
          playerToken: data.playerToken,
        },
        `server:${id}`,
      ),
    );
    this.root.set('serverProfiles', [...this.list().filter((p) => p.id !== id), profile]);
    return profile;
  }
  enable(id: string, enabled: boolean): void {
    this.get(id);
    this.root.set(
      'serverProfiles',
      this.list().map((p) => (p.id === id ? { ...p, enabled } : p)),
    );
  }
  select(user: string, id: string): void {
    this.get(id);
    this.root.set(`selectedServer:${user}`, id);
  }
  selected(user: string): string {
    const id = this.root.get(`selectedServer:${user}`, 'default');
    return this.list().some((p) => p.id === id) ? id : 'default';
  }
  link(id: string, user: string, input: unknown): void {
    this.get(id);
    const credentials = credentialsSchema.parse(input);
    const users = this.root.get<string[]>(`identityUsers:${id}`, []);
    if (!users.includes(user) && users.length >= 50)
      throw new Error('Maximum 50 identities per server.');
    this.root.set(
      `identity:${id}:${user}`,
      this.vault.encrypt(credentials, `identity:${id}:${user}`),
    );
    this.root.set(`identityInvalid:${id}:${user}`, false);
    this.root.set(`identityUsers:${id}`, [...new Set([...users, user])]);
    this.root.set(
      `chatOwnSteamIds:${id}`,
      [
        ...new Set([...this.root.get<string[]>(`chatOwnSteamIds:${id}`, []), credentials.playerId]),
      ].slice(-100),
    );
  }
  identity(id: string, user: string): PlayerCredentials | undefined {
    const data = this.root.get(`identity:${id}:${user}`, '');
    return data
      ? credentialsSchema.parse(this.vault.decrypt(data, `identity:${id}:${user}`))
      : undefined;
  }
  identities(id: string): PlayerCredentials[] {
    return this.root.get<string[]>(`identityUsers:${id}`, []).flatMap((user) => {
      const identity = this.identity(id, user);
      return identity ? [identity] : [];
    });
  }
  unlink(user: string): void {
    for (const profile of this.list()) {
      this.root.set(`identity:${profile.id}:${user}`, '');
      this.root.set(
        `identityUsers:${profile.id}`,
        this.root.get<string[]>(`identityUsers:${profile.id}`, []).filter((u) => u !== user),
      );
      this.root.set(`identityInvalid:${profile.id}:${user}`, false);
    }
  }
  close(): void {
    for (const [id, store] of this.stores) if (id !== 'default') store.close();
    this.stores.clear();
  }
}
