import { EventEmitter } from 'node:events';
import type { Config } from '../config';
import type { Device } from '../domain';
import { log, transportErrorDetails } from '../log';
import type { RustClient, RustMessage, RustRequest, RustResponse } from './protocol';
import { createRustClient } from './client';

export type ConnectionState =
  'stopped' | 'connecting' | 'synchronizing' | 'connected' | 'reconnecting' | 'invalid-credentials';
export class RustFailure extends Error {
  constructor(
    public kind: 'auth' | 'rate' | 'timeout' | 'protocol' | 'offline' | 'busy' | 'device',
  ) {
    super(
      {
        auth: 'Rust+ rejected credentials. Re-pair the server and update the environment.',
        rate: 'Rust+ rate limited this request. Wait before trying again.',
        timeout: 'Rust+ did not respond. The connection is being recovered.',
        protocol: 'Rust+ returned an invalid response.',
        offline: 'Rust+ is disconnected. Try again after reconnection.',
        busy: 'Rust+ queue is full. Try again shortly.',
        device: 'Rust+ could not access this device. Check its ID, pairing and server.',
      }[kind],
    );
  }
}
export class Connection extends EventEmitter {
  state: ConnectionState = 'stopped';
  info?: RustResponse['info'];
  lastConnectedAt?: number;
  private client?: RustClient;
  private stopped = true;
  private generation = 0;
  private attempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private pending = new Set<(error: Error) => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private queueSize = 0;
  private nextRequest = 0;
  private maintaining = false;
  private subscribed = new Set<string>();
  private versions = new Map<string, number>();
  private values = new Map<string, boolean>();
  private syncing = new Map<string, Promise<boolean>>();
  private sleepTimer?: NodeJS.Timeout;
  private wake?: () => void;
  private readonly transport: 'proxy' | 'direct';
  constructor(
    config: Config,
    private devices: () => Device[],
    private factory: () => RustClient = () => createRustClient(config),
    private paceMs = 800,
  ) {
    super();
    this.transport = config.RUST_USE_PROXY ? 'proxy' : 'direct';
  }
  get online(): boolean {
    return this.state === 'connected';
  }
  get unavailableDevices(): Device[] {
    return this.devices().filter(
      (d) => (d.type === 'switch' || d.enabled) && (!this.online || !this.subscribed.has(d.id)),
    );
  }
  refreshHealth(): void {
    this.emit('health');
  }
  forgetDevice(id: string): void {
    this.subscribed.delete(id);
    this.values.delete(id);
    this.versions.delete(id);
    this.refreshHealth();
  }
  private status(state: ConnectionState): void {
    this.state = state;
    this.emit('status', state);
    log.info({ state }, 'Rust+ connection state');
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    this.open();
  }
  private open(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.subscribed.clear();
    this.syncing.clear();
    this.info = undefined;
    let client: RustClient;
    try {
      client = this.factory();
    } catch {
      this.recover();
      return;
    }
    this.client = client;
    this.status('connecting');
    const current = () => !this.stopped && this.client === client && generation === this.generation;
    client.on('connecting', () => {
      if (!current()) queueMicrotask(() => client.disconnect());
    });
    client.on('connected', () => {
      if (!current()) {
        client.disconnect();
        return;
      }
      if (this.watchdog) clearTimeout(this.watchdog);
      this.status('synchronizing');
      void this.initialize(generation).catch(() => {
        if (current()) this.recover();
      });
    });
    client.on('disconnected', () => {
      if (current()) this.recover();
    });
    client.on('error', (error: unknown) => {
      log.warn(
        { transport: this.transport, ...transportErrorDetails(error) },
        'Rust+ transport error',
      );
      if (current()) this.recover();
    });
    client.on('message', (message: RustMessage) => {
      if (!current()) return;
      const changed = message.broadcast?.entityChanged;
      if (
        changed &&
        this.subscribed.has(String(changed.entityId)) &&
        typeof changed.payload.value === 'boolean'
      ) {
        const id = String(changed.entityId);
        if (!this.devices().some((d) => d.id === id)) return;
        this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
        this.values.set(id, changed.payload.value);
        this.emit('device', id, changed.payload.value, false);
      }
      if (this.online && message.broadcast?.teamMessage?.message)
        this.emit('chat', message.broadcast.teamMessage.message);
      if (this.online && message.broadcast?.teamChanged)
        this.emit('teamChanged', message.broadcast.teamChanged.teamInfo);
    });
    this.watchdog = setTimeout(() => {
      if (current()) this.recover();
    }, 15000);
    try {
      client.connect();
    } catch {
      this.recover();
    }
  }
  private async initialize(generation: number): Promise<void> {
    const response = await this.request({ getInfo: {} }, true);
    if (!response.info) throw new RustFailure('protocol');
    this.info = response.info;
    for (const device of this.devices()) {
      if (generation !== this.generation || this.stopped) return;
      try {
        await this.queryDevice(device.id, true);
      } catch {
        log.warn({ entityId: device.id }, 'Device subscription unavailable; will retry');
      }
    }
    if (generation !== this.generation || this.stopped) return;
    this.attempts = 0;
    this.lastConnectedAt = Date.now();
    this.status('connected');
    this.emit('ready');
    this.refreshHealth();
    this.heartbeat = setInterval(() => {
      void this.maintain().catch(() => {
        /* request handles connection failures */
      });
    }, 30000);
  }
  private async maintain(): Promise<void> {
    if (!this.online || this.maintaining) return;
    this.maintaining = true;
    try {
      this.info = (await this.request({ getInfo: {} })).info;
      for (const device of this.devices())
        if (!this.subscribed.has(device.id)) {
          try {
            await this.queryDevice(device.id);
          } catch {
            /* next heartbeat retries inaccessible entities */
          }
        }
    } finally {
      this.maintaining = false;
      this.refreshHealth();
    }
  }
  private cleanup(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.wake?.();
    this.wake = undefined;
    for (const reject of [...this.pending]) reject(new RustFailure('offline'));
    this.pending.clear();
    this.subscribed.clear();
    this.versions.clear();
    this.values.clear();
    this.syncing.clear();
    const client = this.client;
    this.client = undefined;
    if (client) {
      // Keep a harmless error handler for late websocket errors, but detach application handlers.
      client.removeAllListeners();
      client.on('error', () => {});
      client.on('connecting', () => queueMicrotask(() => client.disconnect()));
      client.on('connected', () => client.disconnect());
      client.disconnect();
      client.seqCallbacks = [];
    }
  }
  private recover(auth = false): void {
    if (this.stopped || this.reconnectTimer || this.state === 'invalid-credentials') return;
    ++this.generation;
    this.cleanup();
    if (auth) {
      this.status('invalid-credentials');
      return;
    }
    this.status('reconnecting');
    const delay =
      Math.min(60000, 1000 * 2 ** Math.min(this.attempts++, 6)) + Math.floor(Math.random() * 500);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
  }
  stop(): void {
    this.stopped = true;
    ++this.generation;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.cleanup();
    this.status('stopped');
  }
  request(request: RustRequest, internal = false, beforeSend?: () => void): Promise<RustResponse> {
    if (!this.online && !(internal && this.state === 'synchronizing'))
      return Promise.reject(new RustFailure('offline'));
    if (this.queueSize >= 40) return Promise.reject(new RustFailure('busy'));
    const generation = this.generation;
    ++this.queueSize;
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        if (generation !== this.generation || !this.client) throw new RustFailure('offline');
        const wait = this.nextRequest - Date.now();
        if (wait > 0)
          await new Promise<void>((resolve) => {
            this.wake = resolve;
            this.sleepTimer = setTimeout(resolve, wait);
          });
        this.wake = undefined;
        if (generation !== this.generation || !this.client) throw new RustFailure('offline');
        if (
          request.setEntityValue &&
          this.devices().find((d) => Number(d.id) === request.entityId)?.type !== 'switch'
        )
          throw new Error('Select a registered Smart Switch.');
        beforeSend?.(); // Session/registration checks and echo recording happen immediately before dispatch.
        this.nextRequest = Date.now() + this.paceMs * (request.sendTeamMessage ? 2 : 1);
        return this.send(this.client, request);
      })
      .finally(() => {
        --this.queueSize;
      });
    this.tail = task;
    return task;
  }
  private send(client: RustClient, request: RustRequest): Promise<RustResponse> {
    return new Promise((resolve, reject) => {
      const seq = client.seq + 1;
      const finish = (error?: Error, response?: RustResponse) => {
        clearTimeout(timer);
        this.pending.delete(cancel);
        delete client.seqCallbacks[seq];
        if (error) reject(error);
        else resolve(response!);
      };
      const cancel = (error: Error) => finish(error);
      const timer = setTimeout(() => {
        finish(new RustFailure('timeout'));
        this.recover();
      }, 10000);
      this.pending.add(cancel);
      try {
        client.sendRequest(request, (message) => {
          const response = message.response;
          if (!response) {
            finish(new RustFailure('protocol'));
            return true;
          }
          const error = response.error?.error.toLowerCase();
          if (error) {
            const kind =
              /token|auth|credential|player.?id/.test(error) ||
              (request.getInfo && /access.?denied/.test(error))
                ? 'auth'
                : /rate|limit|too.?many/.test(error)
                  ? 'rate'
                  : 'device';
            if (kind === 'rate') this.nextRequest = Date.now() + 10000;
            finish(new RustFailure(kind));
            if (kind === 'auth') this.recover(true);
          } else finish(undefined, response);
          return true;
        });
      } catch {
        finish(new RustFailure('offline'));
        this.recover();
      }
    });
  }
  queryDevice(id: string, internal = false): Promise<boolean> {
    const existing = this.syncing.get(id);
    if (existing) return existing;
    const device = this.devices().find((d) => d.id === id);
    if (!device) return Promise.reject(new Error('Device is not registered.'));
    const generation = this.generation;
    let version = 0;
    const task = this.request({ entityId: Number(id), getEntityInfo: {} }, internal, () => {
      version = this.versions.get(id) ?? 0;
    })
      .then((response) => {
        if (
          generation !== this.generation ||
          !this.devices().some((d) => d.id === id && d.type === device.type)
        )
          throw new RustFailure('offline');
        const info = response.entityInfo;
        if (
          !info ||
          info.type !== (device.type === 'switch' ? 1 : 2) ||
          typeof info.payload.value !== 'boolean'
        )
          throw new RustFailure('device');
        this.subscribed.add(id);
        // A live broadcast received after dispatch is newer than the response snapshot.
        if (version !== (this.versions.get(id) ?? 0) && this.values.has(id))
          return this.values.get(id)!;
        this.values.set(id, info.payload.value);
        this.emit('device', id, info.payload.value, true);
        this.refreshHealth();
        return info.payload.value;
      })
      .catch((error) => {
        if (generation === this.generation) {
          this.subscribed.delete(id);
          this.values.delete(id);
          this.emit('deviceError', id);
          this.refreshHealth();
        }
        throw error;
      })
      .finally(() => {
        if (this.syncing.get(id) === task) this.syncing.delete(id);
      });
    this.syncing.set(id, task);
    return task;
  }
  async setSwitch(id: string, value: boolean): Promise<boolean> {
    if (this.devices().find((d) => d.id === id)?.type !== 'switch')
      throw new Error('Select a registered Smart Switch.');
    if (!this.subscribed.has(id)) await this.queryDevice(id);
    const generation = this.generation;
    try {
      const response = await this.request({ entityId: Number(id), setEntityValue: { value } });
      if (!response.success) throw new RustFailure('protocol');
    } catch (error) {
      if (generation === this.generation) {
        this.subscribed.delete(id);
        this.values.delete(id);
        this.emit('deviceError', id);
        this.refreshHealth();
      }
      throw error;
    }
    return this.queryDevice(id);
  }
}
