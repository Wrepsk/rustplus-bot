import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config';
import type { Device } from '../src/domain';
import { Connection } from '../src/rust/connection';
import type { RustClient, RustMessage, RustRequest, RustResponse } from '../src/rust/protocol';

class FakeRust extends EventEmitter implements RustClient {
  seq = 0;
  seqCallbacks: ((message: RustMessage) => boolean)[] = [];
  requests: RustRequest[] = [];
  connect = vi.fn(() => {
    queueMicrotask(() => this.emit('connected'));
  });
  disconnect = vi.fn();
  response: (request: RustRequest) => Partial<RustResponse> = (request) =>
    request.getInfo
      ? { info: { name: 'Mock Rust', players: 2, maxPlayers: 100 } }
      : request.getEntityInfo
        ? { entityInfo: { type: request.entityId === 2 ? 2 : 1, payload: { value: false } } }
        : { success: {} };
  sendRequest(request: RustRequest, callback: (message: RustMessage) => boolean): void {
    const seq = ++this.seq;
    this.requests.push(request);
    this.seqCallbacks[seq] = callback;
    queueMicrotask(() => {
      callback({ response: { seq, ...this.response(request) } });
      delete this.seqCallbacks[seq];
    });
  }
}
const config = {
  RUST_SERVER_IP: 'localhost',
  RUST_APP_PORT: 28082,
  RUST_STEAM_ID: '76561198000000000',
  RUST_PLAYER_TOKEN: '1',
  RUST_USE_PROXY: false,
} as Config;
const devices: Device[] = [
  { id: '1', name: 'Lights', type: 'switch', sensitive: false, enabled: true },
  { id: '2', name: 'Outer wall', type: 'alarm', sensitive: false, enabled: true },
];
const connections: Connection[] = [];
function fixture() {
  const clients: FakeRust[] = [];
  const connection = new Connection(
    config,
    () => devices,
    () => {
      const client = new FakeRust();
      clients.push(client);
      return client;
    },
    0,
  );
  connections.push(connection);
  return { connection, clients };
}
async function ready(connection: Connection) {
  const promise = new Promise<void>((resolve) => connection.once('ready', resolve));
  connection.start();
  await promise;
}
afterEach(() => {
  for (const connection of connections.splice(0)) connection.stop();
  vi.useRealTimers();
});
describe('Rust+ connection recovery', () => {
  it('times out silent sockets, cleans callbacks and starts one recovery cycle', async () => {
    vi.useFakeTimers();
    const { connection, clients } = fixture();
    await ready(connection);
    clients[0].sendRequest = (request, callback) => {
      clients[0].requests.push(request);
      clients[0].seqCallbacks[++clients[0].seq] = callback;
    };
    const result = connection.request({ getTeamChat: {} });
    const rejected = expect(result).rejects.toThrow('did not respond');
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(connection.state).toBe('reconnecting');
    expect(Object.keys(clients[0].seqCallbacks)).toHaveLength(0);
    clients[0].emit('disconnected');
    clients[0].emit('error', new Error('old socket'));
    await vi.advanceTimersByTimeAsync(1600);
    expect(clients).toHaveLength(2);
  });
  it('pauses subsequent requests after a Rust+ rate-limit response', async () => {
    vi.useFakeTimers();
    const { connection, clients } = fixture();
    await ready(connection);
    const response = clients[0].response;
    clients[0].response = () => ({ error: { error: 'rate_limit' } });
    await expect(connection.request({ getTeamChat: {} })).rejects.toThrow('rate limited');
    clients[0].response = response;
    const before = clients[0].requests.length;
    const next = connection.request({ getInfo: {} });
    await vi.advanceTimersByTimeAsync(9999);
    expect(clients[0].requests.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(clients[0].requests.length).toBe(before + 1);
  });
  it('validates credentials, queries every registered entity and installs only one listener', async () => {
    const { connection, clients } = fixture();
    await ready(connection);
    connection.start();
    expect(clients).toHaveLength(1);
    expect(clients[0].requests.filter((r) => r.getEntityInfo).map((r) => r.entityId)).toEqual([
      1, 2,
    ]);
    expect(clients[0].listenerCount('message')).toBe(1);
    expect(connection.online).toBe(true);
  });
  it('restores subscriptions after reconnect and distinguishes snapshots from broadcasts', async () => {
    vi.useFakeTimers();
    const { connection, clients } = fixture();
    const events: unknown[][] = [];
    connection.on('device', (...args: unknown[]) => events.push(args));
    await ready(connection);
    expect(events).toEqual([
      ['1', false, true],
      ['2', false, true],
    ]);
    clients[0].emit('disconnected');
    expect(connection.online).toBe(false);
    const restored = new Promise<void>((resolve) => connection.once('ready', resolve));
    await vi.advanceTimersByTimeAsync(1600);
    await restored;
    expect(clients).toHaveLength(2);
    expect(clients[0].listenerCount('message')).toBe(0);
    expect(clients[1].requests.filter((r) => r.getEntityInfo).map((r) => r.entityId)).toEqual([
      1, 2,
    ]);
    clients[1].emit('message', {
      broadcast: { entityChanged: { entityId: 2, payload: { value: true } } },
    });
    expect(events.at(-1)).toEqual(['2', true, false]);
    clients[1].emit('message', {
      broadcast: { entityChanged: { entityId: 999, payload: { value: true } } },
    });
    expect(events.at(-1)).toEqual(['2', true, false]);
  });
  it('stops retrying invalid credentials and never logs tokens', async () => {
    const fake = new FakeRust();
    fake.response = () => ({ error: { error: 'invalid_token' } });
    const connection = new Connection(
      config,
      () => devices,
      () => fake,
      0,
    );
    connections.push(connection);
    const invalid = new Promise<void>((resolve) =>
      connection.on('status', (state) => {
        if (state === 'invalid-credentials') resolve();
      }),
    );
    connection.start();
    await invalid;
    expect(connection.state).toBe('invalid-credentials');
    expect(fake.disconnect).toHaveBeenCalledOnce();
  });
  it('confirms switch state through a new read and rejects unregistered controls', async () => {
    const { connection, clients } = fixture();
    await ready(connection);
    await expect(connection.setSwitch('1', true)).resolves.toBe(false);
    expect(clients[0].requests.slice(-2)).toEqual([
      { entityId: 1, setEntityValue: { value: true } },
      { entityId: 1, getEntityInfo: {} },
    ]);
    await expect(connection.setSwitch('999', true)).rejects.toThrow('registered');
  });
  it('shuts down and removes subscriptions and application event listeners', async () => {
    const { connection, clients } = fixture();
    await ready(connection);
    connection.stop();
    expect(connection.state).toBe('stopped');
    expect(clients[0].listenerCount('message')).toBe(0);
    await expect(connection.request({ getInfo: {} })).rejects.toThrow('disconnected');
  });
  it('deduplicates simultaneous status queries', async () => {
    const { connection, clients } = fixture();
    await ready(connection);
    const start = clients[0].requests.length;
    await Promise.all([connection.queryDevice('1'), connection.queryDevice('1')]);
    expect(clients[0].requests.length - start).toBe(1);
  });
});
