import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PairingListener } from '../src/pairing/listener';

const upstreamRequire = createRequire(require.resolve('@liamcottle/rustplus.js'));
const Upstream = upstreamRequire('@liamcottle/push-receiver/src/client') as {
  prototype: { connect(): Promise<void>; _destroy(): void };
};
const listeners: PairingListener[] = [];
function fixture() {
  const receive = vi.fn(),
    listener = new PairingListener({ androidId: '123', securityToken: '456' }, receive);
  listeners.push(listener);
  return { listener, receive };
}
afterEach(() => {
  for (const listener of listeners.splice(0)) listener.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('persistent FCM pairing listener lifecycle', () => {
  it('recovers a half-open push socket when heartbeat acknowledgements stop', async () => {
    vi.useFakeTimers();
    const { listener } = fixture();
    Object.assign(listener, { _socket: { write: vi.fn() } });
    vi.spyOn(Upstream.prototype, '_destroy').mockImplementation(() => {});
    listener._onMessage({ tag: 3, object: {} });
    await vi.advanceTimersByTimeAsync(60000);
    listener._onMessage({ tag: 1, object: {} });
    await vi.advanceTimersByTimeAsync(15000);
    expect(listener.state).toBe('listening');
    await vi.advanceTimersByTimeAsync(60000);
    expect(listener.state).toBe('reconnecting');
  });
  it('catches failed connects, backs off and does not reconnect after shutdown', async () => {
    vi.useFakeTimers();
    const connect = vi
      .spyOn(Upstream.prototype, 'connect')
      .mockRejectedValue(new Error('private network error'));
    const { listener } = fixture();
    await expect(listener.connect()).resolves.toBeUndefined();
    expect(listener.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(connect).toHaveBeenCalledTimes(2);
    listener.destroy();
    await vi.advanceTimersByTimeAsync(60000);
    expect(connect).toHaveBeenCalledTimes(2);
  });
  it('deduplicates and bounds push IDs, ignores alarm/unsupported payloads and stops receiving after destroy', () => {
    const { listener, receive } = fixture();
    const wire = (id: string) => ({
      persistentId: id,
      appData: [
        { key: 'channelId', value: 'pairing' },
        {
          key: 'body',
          value: JSON.stringify({
            type: 'entity',
            ip: 'rust.example.org',
            port: 28082,
            entityType: 1,
            entityId: 42,
          }),
        },
      ],
    });
    listener._onDataMessage(wire('one'));
    listener._onDataMessage(wire('one'));
    expect(receive).toHaveBeenCalledOnce();
    listener._onDataMessage({
      persistentId: 'encrypted',
      appData: [{ key: 'crypto-key', value: 'ignored' }],
    });
    expect(receive).toHaveBeenCalledOnce();
    for (let i = 0; i < 1100; ++i) listener._onDataMessage(wire(String(i)));
    expect(listener._persistentIds).toHaveLength(1000);
    listener.destroy();
    listener._onDataMessage(wire('later'));
    expect(receive).toHaveBeenCalledTimes(1101);
  });
  it('guards the actual upstream parser callback instead of allowing malformed bytes to crash the process', async () => {
    vi.useFakeTimers();
    const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), write: vi.fn() });
    const original = vi.fn(() => {
      throw new Error('malformed secret frame');
    });
    const parser = { _onData: original, _data: Buffer.alloc(0) };
    vi.spyOn(Upstream.prototype, 'connect').mockImplementation(async function (this: unknown) {
      Object.assign(this as object, { _socket: socket, _parser: parser });
      socket.on('data', original);
    });
    vi.spyOn(Upstream.prototype, '_destroy').mockImplementation(() => {});
    const { listener } = fixture();
    await listener.connect();
    expect(() => socket.emit('data', Buffer.from([255]))).not.toThrow();
    expect(listener.state).toBe('reconnecting');
  });
  it('uses the CLI check-in schema with bounded fetch and pauses rejected credentials', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 401 }));
    const { listener } = fixture();
    vi.spyOn(Upstream.prototype, 'connect').mockImplementation(async () => {
      await listener._checkIn();
    });
    await listener.connect();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://android.clients.google.com/checkin',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
    expect(listener.state).toBe('invalid-credentials');
    await listener.connect();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('reports listening only after authenticated FCM login and handles heartbeat frames', () => {
    vi.useFakeTimers();
    const { listener } = fixture();
    const socket = { write: vi.fn() };
    Object.assign(listener, { _socket: socket });
    vi.spyOn(Upstream.prototype, '_destroy').mockImplementation(() => {});
    listener._onMessage({ tag: 3, object: {} });
    expect(listener.state).toBe('listening');
    listener._onMessage({ tag: 0, object: {} });
    expect(socket.write).toHaveBeenCalledWith(Buffer.from([1, 0]));
    vi.advanceTimersByTime(60000);
    expect(socket.write).toHaveBeenCalledWith(Buffer.from([0, 0]));
    listener._onMessage({ tag: 3, object: { error: { code: 401 } } });
    expect(listener.state).toBe('invalid-credentials');
  });
});
