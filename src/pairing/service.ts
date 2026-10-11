import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../database';
import { CredentialVault, decryptPairing, pairingChallenge } from './crypto';
import { listenerSchema, pairingSchema, type Pairing } from './schema';
import { PairingListener } from './listener';

interface Session {
  user: string;
  expires: number;
  privateKey: string;
}
interface Pending {
  id: string;
  owner: string;
  data: string;
  expires: number;
}
export class PairingService {
  private sessions = new Map<string, Session>();
  private listeners = new Map<string, PairingListener>();
  constructor(
    private store: Store,
    private vault: CredentialVault,
  ) {}
  start(): void {
    for (const user of this.store.get<string[]>('pairingUsers', [])) this.listen(user);
  }
  challenge(user: string): string {
    for (const [id, session] of this.sessions)
      if (session.expires <= Date.now() || session.user === user) this.sessions.delete(id);
    if (this.sessions.size >= 50) throw new Error('Pairing is busy; retry shortly.');
    const challenge = pairingChallenge();
    this.sessions.set(challenge.code.split('.')[0], {
      user,
      expires: Date.now() + 15 * 60000,
      privateKey: challenge.privateKey,
    });
    return challenge.code;
  }
  import(user: string, data: string): void {
    const id = data.split('.')[0],
      session = this.sessions.get(id);
    if (!session || session.user !== user || session.expires <= Date.now())
      throw new Error('Pairing code expired or belongs to another user. Run /pair start again.');
    let credentials;
    try {
      credentials = listenerSchema.parse(decryptPairing(session.privateKey, data));
    } catch {
      throw new Error('Invalid encrypted pairing data. Run the local helper again.');
    }
    const users = this.store.get<string[]>('pairingUsers', []);
    if (!users.includes(user) && users.length >= 50) throw new Error('Maximum 50 paired users.');
    this.store.set(`pairingCredentials:${user}`, this.vault.encrypt(credentials, `fcm:${user}`));
    this.store.set('pairingUsers', [...new Set([...users, user])]);
    this.sessions.delete(id);
    this.listen(user);
  }
  private listen(user: string): void {
    const encrypted = this.store.get(`pairingCredentials:${user}`, '');
    if (!encrypted) return;
    const credentials = listenerSchema.parse(this.vault.decrypt(encrypted, `fcm:${user}`));
    this.listeners.get(user)?.destroy();
    const listener = new PairingListener(credentials, (pairing) => this.receive(user, pairing));
    this.listeners.set(user, listener);
    void listener.connect();
  }
  receive(owner: string, pairing: Pairing): void {
    const parsed = pairingSchema.parse(pairing);
    const id = createHash('sha256')
      .update(`${owner}:${JSON.stringify(parsed)}`)
      .digest('hex')
      .slice(0, 12);
    const rows = this.pending().filter((p) => p.id !== id);
    // Bound each user's inbox so one person cannot evict everybody else's pairings.
    const mine = rows.filter((p) => p.owner === owner).slice(-49);
    const others = rows.filter((p) => p.owner !== owner);
    this.store.set('pairingInbox', [
      ...others,
      ...mine,
      {
        id,
        owner,
        expires: Date.now() + 86400000,
        data: this.vault.encrypt(parsed, `pending:${id}:${owner}`),
      },
    ]);
  }
  pending(): Pending[] {
    return this.store.get<Pending[]>('pairingInbox', []).filter((p) => p.expires > Date.now());
  }
  inbox(user: string): { id: string; pairing: Pairing }[] {
    return this.pending()
      .filter((p) => p.owner === user)
      .map((p) => ({
        id: p.id,
        pairing: pairingSchema.parse(this.vault.decrypt(p.data, `pending:${p.id}:${user}`)),
      }));
  }
  take(user: string, id: string): Pairing {
    if (
      !z
        .string()
        .regex(/^[a-f0-9]{12}$/)
        .safeParse(id).success
    )
      throw new Error('Invalid pairing ID.');
    const pending = this.inbox(user).find((p) => p.id === id);
    if (!pending) throw new Error('Pairing not found. Pair again in-game and run /pair inbox.');
    return pending.pairing;
  }
  acknowledge(user: string, id: string): void {
    this.store.set(
      'pairingInbox',
      this.pending().filter((p) => !(p.owner === user && p.id === id)),
    );
  }
  linked(user: string): boolean {
    return this.listeners.has(user);
  }
  status(user: string): string {
    return this.listeners.get(user)?.state || 'not configured';
  }
  unlink(user: string): void {
    this.listeners.get(user)?.destroy();
    this.listeners.delete(user);
    this.store.set(`pairingCredentials:${user}`, '');
    this.store.set(
      'pairingUsers',
      this.store.get<string[]>('pairingUsers', []).filter((u) => u !== user),
    );
    this.store.set(
      'pairingInbox',
      this.pending().filter((p) => p.owner !== user),
    );
    for (const [id, session] of this.sessions) if (session.user === user) this.sessions.delete(id);
  }
  stop(): void {
    for (const listener of this.listeners.values()) listener.destroy();
    this.listeners.clear();
    this.sessions.clear();
  }
}
