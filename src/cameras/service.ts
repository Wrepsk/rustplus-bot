import { randomBytes } from 'node:crypto';
import type { Config } from '../config';
import type { Servers, PlayerCredentials } from '../servers';
import { Connection, RustFailure } from '../rust/connection';
import type { CameraInfo, CameraRays, RustResponse } from '../rust/protocol';
import { CameraRegistry, CameraError, movement } from './registry';
import { CameraRenderer } from './renderer';
import { log, errorCode } from '../log';

type Team = NonNullable<RustResponse['teamInfo']>;
interface Ticket {
  server: string;
  viewer: string;
  camera: string;
  expires: number;
}
interface Session extends Ticket {
  owner?: string;
  credential?: PlayerCredentials;
  rust?: Connection;
  renderer?: CameraRenderer;
  info?: CameraInfo;
  png?: Buffer;
  frameAt: number;
  opened: number;
  seen: number;
  verified: number;
  renewing: boolean;
  controlling: boolean;
  closing?: boolean;
  cleanupTimer?: NodeJS.Timeout;
  reason?: string;
  onRays?: (rays: CameraRays) => void;
  onStatus?: (state: string) => void;
}
export function offlineMember(team: Team | undefined, steamId: string): boolean {
  const member = team?.members.find((m) => m.steamId.toString() === steamId);
  return member?.isOnline === false && member.isAlive === true;
}

export class Cameras {
  private tickets = new Map<string, Ticket>();
  private sessions = new Map<string, Session>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  constructor(
    private servers: Servers,
    private monitor: (server: string) => Connection | undefined,
    private authorize: (server: string, user: string) => Promise<void>,
    private factory: (config: Config, server: string) => Connection = (config, server) =>
      new Connection(config, () => [], undefined, 800, server),
  ) {}
  start(): void {
    this.timer ??= setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }
  registry(server: string): CameraRegistry {
    return new CameraRegistry(this.servers.store(server));
  }
  share(server: string, user: string, enabled: boolean): void {
    if (enabled && !this.servers.identity(server, user))
      throw new CameraError('Link your own account to this server with /pair first.');
    this.servers.store(server).set(`cameraShare:${user}`, enabled);
    if (!enabled) this.revoke(user, server);
  }
  revoke(user: string, server?: string): void {
    for (const [id, s] of this.sessions)
      if ((!server || s.server === server) && (s.owner === user || s.viewer === user))
        this.close(id, 'Account sharing or pairing was revoked.');
    for (const [id, t] of this.tickets)
      if (t.viewer === user && (!server || t.server === server)) this.tickets.delete(id);
  }
  pause(server: string): void {
    for (const [id, s] of this.sessions)
      if (s.server === server) this.close(id, 'Server monitoring was restarted or paused.');
    for (const [id, t] of this.tickets) if (t.server === server) this.tickets.delete(id);
  }
  stopFor(server: string, user: string, admin = false): void {
    for (const [id, s] of this.sessions)
      if (s.server === server && (admin || s.viewer === user || s.owner === user))
        this.close(id, 'Stopped from Discord.');
    for (const [id, t] of this.tickets)
      if (t.server === server && (admin || t.viewer === user)) this.tickets.delete(id);
  }
  issue(server: string, viewer: string, camera: string): string {
    this.prune();
    if (this.stopped) throw new CameraError('Camera service is stopping.');
    this.registry(server).get(camera);
    if (!this.monitor(server)?.online)
      throw new CameraError('Wait for Rust+ monitoring to reconnect first.');
    if (this.tickets.size >= 50) throw new CameraError('Too many camera links. Wait two minutes.');
    for (const [id, t] of this.tickets) if (t.viewer === viewer) this.tickets.delete(id);
    const token = randomBytes(32).toString('hex');
    this.tickets.set(token, { server, viewer, camera, expires: Date.now() + 120000 });
    return token;
  }
  private guard(s: Session): void {
    if (this.stopped || s.reason || Date.now() >= s.expires)
      throw new CameraError(s.reason || 'Camera session expired. Run /camera watch again.');
    if (s.info && s.verified < Date.now() - 25000)
      throw new CameraError('Offline account verification expired. Open a fresh viewer.');
    this.registry(s.server).get(s.camera);
    if (!this.servers.get(s.server).enabled || !this.monitor(s.server)?.online)
      throw new CameraError('Rust+ monitoring is unavailable. Open a new viewer after recovery.');
    if (s.owner && s.credential) {
      const current = this.servers.identity(s.server, s.owner);
      if (
        !current ||
        current.playerId !== s.credential.playerId ||
        current.playerToken !== s.credential.playerToken ||
        this.servers.root.get(`identityInvalid:${s.server}:${s.owner}`, false)
      )
        throw new CameraError('The camera account was unlinked or changed.');
      if (
        s.owner !== s.viewer &&
        !this.servers.store(s.server).get(`cameraShare:${s.owner}`, false)
      )
        throw new CameraError('The account owner disabled camera sharing.');
    }
  }
  private async team(server: string): Promise<Team> {
    const monitor = this.monitor(server);
    if (!monitor?.online) throw new CameraError('Rust+ monitoring is unavailable.');
    const team = (await monitor.request({ getTeamInfo: {} })).teamInfo;
    if (!team?.members.length) throw new CameraError('Rust+ did not return a current team.');
    return team;
  }
  async redeem(token: string): Promise<string> {
    const ticket = this.tickets.get(token);
    this.tickets.delete(token); // Single-use, including failed attempts.
    if (!ticket || ticket.expires <= Date.now() || this.stopped)
      throw new CameraError('Link expired or already used. Run /camera watch again.');
    if (
      [...this.sessions.values()].some(
        (s) => (!s.reason || s.closing) && s.server === ticket.server,
      )
    )
      throw new CameraError(
        'This server already has an open camera. Use /camera stop or wait for it to close.',
      );
    if ([...this.sessions.values()].filter((s) => !s.reason || s.closing).length >= 4)
      throw new CameraError('Four camera viewers are already open. Try again later.');
    const id = randomBytes(32).toString('hex');
    const s: Session = {
      ...ticket,
      expires: Date.now() + 10 * 60000,
      opened: Date.now(),
      seen: Date.now(),
      verified: 0,
      frameAt: 0,
      renewing: false,
      controlling: false,
    };
    this.sessions.set(id, s); // Reserve before any await; simultaneous opens cannot add sockets.
    try {
      this.guard(s);
      await this.authorize(s.server, s.viewer);
      const team = await this.team(s.server);
      const users = [
        s.viewer,
        ...this.servers.root
          .get<string[]>(`identityUsers:${s.server}`, [])
          .filter((u) => u !== s.viewer),
      ];
      for (const owner of users) {
        const credential = this.servers.identity(s.server, owner);
        if (
          !credential ||
          this.servers.root.get(`identityInvalid:${s.server}:${owner}`, false) ||
          !offlineMember(team, credential.playerId)
        )
          continue;
        if (owner !== s.viewer && !this.servers.store(s.server).get(`cameraShare:${owner}`, false))
          continue;
        try {
          await this.authorize(s.server, owner);
        } catch {
          continue;
        }
        s.owner = owner;
        s.credential = credential;
        break;
      }
      if (!s.credential)
        throw new CameraError(
          'No eligible offline, living paired teammate. Log out of Rust, or ask an offline teammate to enable /camera share. Unknown presence is not accepted.',
        );
      this.guard(s);
      const config = {
        ...this.servers.connectionConfig(s.server),
        RUST_STEAM_ID: s.credential.playerId,
        RUST_PLAYER_TOKEN: s.credential.playerToken,
      };
      const rust = (s.rust = this.factory(config, s.server));
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          cleanup();
          resolve();
        };
        const status = (state: string) => {
          if (state === 'invalid-credentials' || state === 'stopped') {
            cleanup();
            reject(
              new CameraError('Camera account connection failed. Re-pair if credentials expired.'),
            );
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new CameraError('Camera connection timed out.'));
        }, 15000);
        const cleanup = () => {
          clearTimeout(timer);
          rust.off('ready', ready);
          rust.off('status', status);
        };
        rust.on('ready', ready);
        rust.on('status', status);
        rust.start();
      });
      this.guard(s);
      await this.verify(s);
      s.onStatus = (state) => {
        if (state === 'invalid-credentials' && s.owner)
          this.servers.root.set(`identityInvalid:${s.server}:${s.owner}`, true);
        if (state !== 'connected')
          this.close(id, 'Camera connection lost. Run /camera watch after recovery.');
      };
      rust.on('status', s.onStatus);
      const info = (
        await rust.request({ cameraSubscribe: { cameraId: s.camera } }, false, () => this.guard(s))
      ).cameraSubscribeInfo;
      if (!info || !Number.isInteger(info.controlFlags))
        throw new CameraError('Rust+ did not provide camera capabilities.');
      this.guard(s);
      s.info = info;
      s.renderer = new CameraRenderer(
        info,
        (png) => {
          if (!s.reason) {
            s.png = png;
            s.frameAt = Date.now();
          }
        },
        () => this.close(id, 'Camera rendering failed or the server sent unsupported data.'),
      );
      s.onRays = (rays) => s.renderer?.push(rays);
      rust.on('cameraRays', s.onRays);
      s.seen = Date.now();
      return id;
    } catch (error) {
      if (s.rust?.state === 'invalid-credentials' && s.owner)
        this.servers.root.set(`identityInvalid:${s.server}:${s.owner}`, true);
      this.close(
        id,
        error instanceof CameraError
          ? error.message
          : 'Rust+ camera access failed. Check the identifier, power, range, offline account and server camera settings.',
      );
      log.warn({ server: s.server, code: errorCode(error) }, 'Camera session could not start');
      throw new CameraError(s.reason!);
    }
  }
  private async verify(s: Session): Promise<void> {
    this.guard(s);
    await this.authorize(s.server, s.viewer);
    if (s.owner !== s.viewer) await this.authorize(s.server, s.owner!);
    const team = await this.team(s.server);
    const personal = (await s.rust!.request({ getTeamInfo: {} })).teamInfo;
    const referenceId = this.servers.connectionConfig(s.server).RUST_STEAM_ID;
    if (
      !offlineMember(team, s.credential!.playerId) ||
      !offlineMember(personal, s.credential!.playerId) ||
      !personal?.members.some((m) => m.steamId.toString() === referenceId)
    )
      throw new CameraError(
        'The camera account must remain offline, alive and in the monitored Rust team.',
      );
    this.guard(s);
    s.verified = Date.now();
  }
  private session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new CameraError('Viewer expired. Run /camera watch again.');
    try {
      this.guard(s);
    } catch (error) {
      this.close(id, error instanceof Error ? error.message : 'Session closed.');
      throw error;
    }
    s.seen = Date.now();
    return s;
  }
  status(id: string) {
    const s = this.session(id);
    return {
      server: this.servers.get(s.server).name,
      camera: this.registry(s.server).get(s.camera).name,
      shared: s.owner !== s.viewer,
      flags: s.info?.controlFlags ?? 0,
      frameAt: s.frameAt,
      fresh: s.frameAt > Date.now() - 10000,
      expires: s.expires,
    };
  }
  frame(id: string): Buffer | undefined {
    const s = this.session(id);
    return s.frameAt > Date.now() - 10000 ? s.png : undefined;
  }
  async input(id: string, action: string): Promise<void> {
    const s = this.session(id);
    if (!s.info || !s.rust || s.verified < Date.now() - 15000 || s.frameAt < Date.now() - 10000)
      throw new CameraError('Wait for a fresh camera frame and account verification.');
    const input = movement(action, s.info.controlFlags);
    if (s.controlling) throw new CameraError('A movement is still running. Wait for it to finish.');
    s.controlling = true;
    try {
      // A single short movement pulse, followed by neutral input at the normal request pace.
      // No held movement queue and no retries of uncertain state-changing requests.
      const guard = () => {
        this.guard(s);
        if (s.verified < Date.now() - 15000) throw new CameraError('Account verification expired.');
      };
      const result = await s.rust.request({ cameraInput: input }, false, guard);
      if (!result.success) throw new RustFailure('protocol');
      if (action !== 'release') {
        const released = await s.rust.request(
          { cameraInput: movement('release', 0) },
          false,
          guard,
        );
        if (!released.success) throw new RustFailure('protocol');
      }
    } catch {
      this.close(id, 'Camera control failed; the session was closed. Movement was not retried.');
      throw new CameraError(s.reason!);
    } finally {
      s.controlling = false;
    }
  }
  close(id: string, reason = 'Viewer closed.'): void {
    const s = this.sessions.get(id);
    if (!s || s.reason) return;
    s.reason = reason;
    s.renderer?.stop();
    s.renderer = undefined;
    s.png = undefined;
    if (s.onRays) s.rust?.off('cameraRays', s.onRays);
    if (s.onStatus) s.rust?.off('status', s.onStatus);
    const rust = s.rust;
    if (!rust?.online || this.stopped) {
      rust?.stop();
      return;
    }
    // Best-effort neutral input and unsubscribe, with a hard deadline. No queued movement
    // passes guard() once reason is set. Reserve the socket slot until it is really closed.
    s.closing = true;
    const finish = () => {
      if (!s.closing) return;
      s.closing = false;
      if (s.cleanupTimer) clearTimeout(s.cleanupTimer);
      rust.stop();
    };
    s.cleanupTimer = setTimeout(finish, 2000);
    void (async () => {
      try {
        await rust.request({ cameraInput: movement('release', 0) });
        await rust.request({ cameraUnsubscribe: {} });
      } catch {
        /* Disconnect is the bounded fallback when neutral input cannot be acknowledged. */
      } finally {
        finish();
      }
    })();
  }
  private tick(): void {
    this.prune();
    for (const [id, s] of this.sessions) {
      if (s.reason) continue;
      if (Date.now() - s.seen > 30000 || Date.now() >= s.expires) {
        this.close(id, 'Viewer idle or expired.');
        continue;
      }
      if (s.info && Date.now() - (s.frameAt || s.opened) > 30000) {
        this.close(id, 'No camera frames received for 30 seconds.');
        continue;
      }
      if (!s.info || s.renewing || Date.now() - s.verified < 10000) continue;
      s.renewing = true;
      void (async () => {
        try {
          await this.verify(s);
          const info = (
            await s.rust!.request({ cameraSubscribe: { cameraId: s.camera } }, false, () =>
              this.guard(s),
            )
          ).cameraSubscribeInfo;
          if (
            !info ||
            info.width !== s.info!.width ||
            info.height !== s.info!.height ||
            info.controlFlags !== s.info!.controlFlags
          )
            throw new CameraError('Camera capabilities changed. Reopen the viewer.');
        } catch (error) {
          this.close(
            id,
            error instanceof CameraError
              ? error.message
              : 'Camera access or account verification failed.',
          );
        } finally {
          s.renewing = false;
        }
      })();
    }
  }
  private prune(): void {
    for (const [id, t] of this.tickets) if (t.expires <= Date.now()) this.tickets.delete(id);
    for (const [id, s] of this.sessions)
      if (s.reason && s.expires <= Date.now()) this.sessions.delete(id);
    // Closed entries retain useful failure messages, with a hard memory bound.
    for (const [id, s] of this.sessions) {
      if (this.sessions.size <= 50) break;
      if (s.reason) this.sessions.delete(id);
    }
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.tickets.clear();
    for (const id of this.sessions.keys()) this.close(id, 'Bot is shutting down.');
    for (const s of this.sessions.values()) {
      if (s.cleanupTimer) clearTimeout(s.cleanupTimer);
      s.rust?.stop();
    }
    this.sessions.clear();
  }
}
