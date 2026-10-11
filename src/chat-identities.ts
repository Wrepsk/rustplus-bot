import type { TeamMessage } from './domain';
import { Connection } from './rust/connection';
import type { Config } from './config';
import type { Servers } from './servers';

export interface ChatSender {
  send(user: string, text: string, beforeSend: () => void): Promise<void>;
  isOwn(message: TeamMessage): boolean;
}
export class ChatIdentityError extends Error {}
interface Session {
  rust: Connection;
  ready: Promise<void>;
  lastUsed: number;
  credential: string;
  busy: number;
}
export class ChatIdentities implements ChatSender {
  private sessions = new Map<string, Session>();
  private timer: NodeJS.Timeout;
  private stopped = false;
  constructor(
    private servers: Servers,
    private server: string,
    private primary: Connection,
    private factory: (config: Config) => Connection = (config) =>
      new Connection(config, () => [], undefined, 800, server),
  ) {
    this.timer = setInterval(() => {
      for (const [user, session] of this.sessions)
        if (!session.busy && Date.now() - session.lastUsed > 60000) this.drop(user);
    }, 15000);
    this.timer.unref();
  }
  isOwn(message: TeamMessage): boolean {
    return (
      message.message.startsWith('[Discord] ') &&
      this.servers.root
        .get<string[]>(`chatOwnSteamIds:${this.server}`, [])
        .includes(message.steamId.toString())
    );
  }
  drop(user: string): void {
    const session = this.sessions.get(user);
    this.sessions.delete(user);
    session?.rust.stop();
  }
  private async connection(user: string): Promise<Connection> {
    if (this.stopped || !this.primary.online) throw new ChatIdentityError('Rust+ is disconnected.');
    const identity = this.servers.identity(this.server, user);
    if (!identity)
      throw new ChatIdentityError(
        'Link your personal Rust+ account with /pair start and pair this server first. Your message was not sent.',
      );
    if (this.servers.root.get(`identityInvalid:${this.server}:${user}`, false))
      throw new ChatIdentityError(
        'Your Rust+ pairing expired. Pair this server again in-game and accept it in /pair inbox.',
      );
    const config = this.servers.connectionConfig(this.server);
    if (
      identity.playerId === config.RUST_STEAM_ID &&
      identity.playerToken === config.RUST_PLAYER_TOKEN
    )
      return this.primary;
    const credential = `${identity.playerId}:${identity.playerToken}`;
    let session = this.sessions.get(user);
    if (session && session.credential !== credential) {
      this.drop(user);
      session = undefined;
    }
    if (!session) {
      // Rust defaults to five sockets per source IP per server. Keep one primary
      // plus at most three personal sockets, leaving a slot for other clients.
      if (this.sessions.size >= 3) {
        const idle = [...this.sessions]
          .filter(([, s]) => !s.busy)
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (!idle)
          throw new ChatIdentityError('Personal chat connections are busy. Retry shortly.');
        this.drop(idle[0]);
      }
      const rust = this.factory({
        ...config,
        RUST_STEAM_ID: identity.playerId,
        RUST_PLAYER_TOKEN: identity.playerToken,
      });
      const ready = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            finish(
              new ChatIdentityError('Your Rust+ connection timed out. Your message was not sent.'),
            ),
          15000,
        );
        const status = () => {
          if (rust.online) finish();
          else if (rust.state === 'invalid-credentials') {
            this.servers.root.set(`identityInvalid:${this.server}:${user}`, true);
            finish(new ChatIdentityError('Your Rust+ pairing was rejected. Re-pair this server.'));
          } else if (rust.state === 'stopped')
            finish(new ChatIdentityError('Your chat connection was closed.'));
        };
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          rust.off('status', status);
          if (error) reject(error);
          else resolve();
        };
        rust.on('status', status);
      });
      session = { rust, ready, lastUsed: Date.now(), credential, busy: 0 };
      this.sessions.set(user, session);
      rust.start();
    }
    const current = session;
    current.lastUsed = Date.now();
    ++current.busy;
    try {
      await current.ready;
    } catch (error) {
      if (this.sessions.get(user) === current) this.drop(user);
      throw error;
    } finally {
      --current.busy;
    }
    if (!current.rust.online) {
      if (current.rust.state === 'invalid-credentials') {
        this.servers.root.set(`identityInvalid:${this.server}:${user}`, true);
        this.drop(user);
      }
      throw new ChatIdentityError(
        'Your Rust+ connection is unavailable. Your message was not sent.',
      );
    }
    return current.rust;
  }
  async send(user: string, text: string, beforeSend: () => void): Promise<void> {
    const rust = await this.connection(user);
    const session = this.sessions.get(user);
    if (session) ++session.busy;
    try {
      // Paired to the same server is insufficient: require the monitoring team,
      // preventing one Discord channel from leaking messages into another team.
      const [reference, personal] = await Promise.all([
        this.primary.request({ getTeamInfo: {} }),
        rust === this.primary ? Promise.resolve(undefined) : rust.request({ getTeamInfo: {} }),
      ]);
      const team = reference.teamInfo,
        own = personal?.teamInfo || team;
      const identity = this.servers.identity(this.server, user);
      if (
        !identity ||
        !team ||
        !own ||
        !team.members.some((m) => m.steamId.toString() === identity.playerId) ||
        team.leaderSteamId.toString() !== own.leaderSteamId.toString()
      )
        throw new ChatIdentityError(
          'Your Steam account must belong to the Rust team mirrored by this channel. Your message was not sent.',
        );
      await rust
        .request({ sendTeamMessage: { message: text } }, false, () => {
          if (this.stopped || !this.primary.online)
            throw new ChatIdentityError('Chat stopped before dispatch.');
          const fresh = this.servers.identity(this.server, user);
          if (
            !fresh ||
            fresh.playerId !== identity.playerId ||
            fresh.playerToken !== identity.playerToken
          )
            throw new ChatIdentityError('Pairing changed before dispatch.');
          beforeSend();
        })
        .then((response) => {
          if (!response.success) throw new Error('No chat acknowledgement');
        });
    } catch (error) {
      if (rust.state === 'invalid-credentials') {
        this.servers.root.set(`identityInvalid:${this.server}:${user}`, true);
        this.drop(user);
      }
      throw error;
    } finally {
      if (session) {
        --session.busy;
        session.lastUsed = Date.now();
      }
    }
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    for (const user of [...this.sessions.keys()]) this.drop(user);
  }
}
