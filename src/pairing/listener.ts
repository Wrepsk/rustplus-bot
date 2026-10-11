import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import type { ListenerCredentials, Pairing } from './schema';
import { parsePairing } from './schema';
import { log } from '../log';

interface PushClient extends EventEmitter {
  connect(): Promise<void>;
  destroy(): void;
  _destroy(): void;
  _retry(): void;
  _onMessage(message: unknown): void;
  _onDataMessage(message: unknown): void;
  _checkIn(): Promise<unknown>;
  _socket?: TLSSocket;
  _parser?: { _onData: (data: Buffer) => void; _data: Buffer };
  _persistentIds: string[];
}
const upstreamRequire = createRequire(require.resolve('@liamcottle/rustplus.js'));
const Upstream = upstreamRequire('@liamcottle/push-receiver/src/client') as {
  new (androidId: string, securityToken: string, ids: string[]): PushClient;
};
const protobuf = upstreamRequire('protobufjs') as typeof import('protobufjs');
let checkinRoot: Promise<import('protobufjs').Root> | undefined;
class PushAuthenticationError extends Error {}

// The CLI's receiver retries async connect without catching rejections. Own that
// lifecycle here so FCM failure cannot stop device monitoring or the Discord bot.
export class PairingListener extends Upstream {
  state = 'starting';
  private stopped = false;
  private attempt = 0;
  private retryTimer?: NodeJS.Timeout;
  private connecting?: Promise<void>;
  private abort = new AbortController();
  private heartbeat?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  constructor(
    private credentials: ListenerCredentials,
    private receive: (pairing: Pairing) => void,
  ) {
    super(credentials.androidId, credentials.securityToken, []);
    this.on('ON_DATA_RECEIVED', (data: unknown) => {
      const pairing = parsePairing(data);
      if (pairing && !this.stopped) {
        try {
          this.receive(pairing);
        } catch {
          log.warn('Could not save pairing notification');
        }
      }
    });
  }
  override connect(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = super
      .connect()
      .then(() => {
        if (this.stopped) return;
        // The receiver's parser also decodes in an unguarded socket callback.
        // Guard that callback and bound its buffer before any network frame is handled.
        const socket = this._socket,
          parser = this._parser;
        if (socket && parser) {
          const original = parser._onData;
          socket.off('data', original);
          parser._onData = (bytes) => {
            if (this.stopped) return;
            if (bytes.length + parser._data.length > 1048576) {
              this._retry();
              return;
            }
            try {
              original(bytes);
            } catch {
              this._retry();
            }
          };
          socket.on('data', parser._onData);
          socket.setTimeout(120000, () => this._retry());
          this.watchdog = setTimeout(() => this._retry(), 15000);
        }
      })
      .catch((error: unknown) => {
        if (error instanceof PushAuthenticationError) {
          this.destroy();
          this.state = 'invalid-credentials';
          return;
        }
        if (!this.stopped) this._retry();
      })
      .finally(() => {
        this.connecting = undefined;
        if (this.stopped) super.destroy();
      });
    return this.connecting;
  }
  override async _checkIn(): Promise<unknown> {
    // Same request/schema as the CLI's gcm.checkIn, using bounded native fetch.
    // Its request helper otherwise retries forever and logs raw upstream errors.
    checkinRoot ||= protobuf.load(
      join(
        dirname(upstreamRequire.resolve('@liamcottle/push-receiver/src/client')),
        'gcm',
        'checkin.proto',
      ),
    );
    const root = await checkinRoot;
    const type = root.lookupType('checkin_proto.AndroidCheckinRequest');
    const data = type
      .encode(
        type.fromObject({
          userSerialNumber: 0,
          checkin: {
            type: 3,
            chromeBuild: { platform: 2, chromeVersion: '63.0.3234.0', channel: 1 },
          },
          version: 3,
          id: this.credentials.androidId,
          securityToken: this.credentials.securityToken,
        }),
      )
      .finish();
    const response = await fetch('https://android.clients.google.com/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: Uint8Array.from(data).buffer,
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
    });
    if (response.status === 401 || response.status === 403) throw new PushAuthenticationError();
    if (!response.ok) throw new Error('Push check-in failed');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 1048576) throw new Error('Push response too large');
    return root.lookupType('checkin_proto.AndroidCheckinResponse').decode(bytes);
  }
  override _retry(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.watchdog) clearTimeout(this.watchdog);
    super._destroy();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.stopped) return;
    this.state = 'reconnecting';
    const delay = Math.min(60000, 1000 * 2 ** Math.min(this.attempt++, 6));
    this.retryTimer = setTimeout(() => {
      void this.connect();
    }, delay);
  }
  override _onMessage(message: unknown): void {
    if (this.stopped) return;
    const frame = message as { tag?: number; object?: { error?: unknown } };
    if (frame.tag === 4 || frame.tag === 10) {
      this._retry();
      return;
    }
    if (frame.tag === 0) this._socket?.write(Buffer.from([1, 0])); // empty HeartbeatAck
    if (frame.tag === 1 && this.watchdog) clearTimeout(this.watchdog);
    if (frame.tag === 3) {
      if (frame.object?.error) {
        this.destroy();
        this.state = 'invalid-credentials';
        return;
      }
      if (this.watchdog) clearTimeout(this.watchdog);
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.state = 'listening';
      this.attempt = 0;
      this.heartbeat = setInterval(() => {
        // A socket inactivity timeout can be reset by writes on a half-open
        // transport. Require an actual HeartbeatAck to prove the peer is alive.
        this.watchdog = setTimeout(() => this._retry(), 15000);
        this._socket?.write(Buffer.from([0, 0]));
      }, 60000);
    }
    try {
      super._onMessage(message);
    } catch {
      this._retry();
    }
  }
  override _onDataMessage(message: unknown): void {
    // Rust pairing notifications use the CLI's plain appData format. Never try
    // the upstream encrypted-webpush branch (it references undefined `keys`).
    if (typeof message !== 'object' || !message) return;
    const data = message as { persistentId?: string; appData?: { key: string }[] };
    if (!Array.isArray(data.appData) || data.appData.some((v) => v.key === 'crypto-key')) return;
    if (data.persistentId && this._persistentIds.includes(data.persistentId)) return;
    if (data.persistentId) this._persistentIds.push(data.persistentId);
    this._persistentIds = this._persistentIds.slice(-1000);
    this.attempt = 0;
    this.emit('ON_DATA_RECEIVED', message);
  }
  override destroy(): void {
    this.stopped = true;
    this.state = 'stopped';
    this.abort.abort();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    super.destroy();
  }
}
