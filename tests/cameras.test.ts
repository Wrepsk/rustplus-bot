import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/database';
import { Servers } from '../src/servers';
import type { Config } from '../src/config';
import type { Connection } from '../src/rust/connection';
import type { RustRequest, RustResponse } from '../src/rust/protocol';
import { Cameras, offlineMember } from '../src/cameras/service';
import { CameraRegistry, movement, heldMovement } from '../src/cameras/registry';

const motionCalls = vi.hoisted(() => vi.fn());
vi.mock('../src/cameras/renderer', () => ({
  CameraRenderer: class {
    constructor(
      _info: unknown,
      private output: (png: Buffer) => void,
    ) {}
    push() {
      this.output(Buffer.from('frame'));
    }
    stop() {}
    motion = motionCalls;
  },
}));
const steam = '76561198000000000',
  friend = '76561198000000001';
let directory: string, root: Store, servers: Servers, cameras: Cameras;
let authorize: ReturnType<typeof vi.fn<(server: string, user: string) => Promise<void>>>;
let team: NonNullable<RustResponse['teamInfo']>;
let connections: FakeConnection[];
let monitor: FakeConnection;
class FakeConnection extends EventEmitter {
  state = 'connected';
  get online() {
    return this.state === 'connected';
  }
  request = vi.fn(
    async (
      _request: RustRequest,
      _internal?: boolean,
      before?: () => void,
    ): Promise<RustResponse> => {
      before?.();
      return {
        seq: 1,
        success: {},
        teamInfo: team,
        cameraSubscribeInfo: { width: 4, height: 4, nearPlane: 0, farPlane: 100, controlFlags: 7 },
      };
    },
  );
  start() {
    this.emit('ready');
  }
  stop() {
    this.state = 'stopped';
    this.emit('status', 'stopped');
  }
}
beforeEach(() => {
  motionCalls.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T00:00:00Z'));
  directory = mkdtempSync(join(tmpdir(), 'rust-camera-'));
  root = new Store(join(directory, 'bot.sqlite'));
  const config = {
    DATABASE_PATH: join(directory, 'bot.sqlite'),
    BASE_NAME: 'Main',
    RUST_SERVER_IP: 'rust.example',
    RUST_APP_PORT: 28082,
    RUST_STEAM_ID: steam,
    RUST_PLAYER_TOKEN: '123',
    ADMIN_USER_ID: 'owner',
  } as Config;
  servers = new Servers(config, root);
  team = {
    leaderSteamId: steam,
    members: [
      { steamId: steam, name: 'Owner', isOnline: false, isAlive: true },
      { steamId: friend, name: 'Friend', isOnline: false, isAlive: true },
    ],
  };
  authorize = vi.fn(async () => {});
  connections = [];
  monitor = new FakeConnection();
  cameras = new Cameras(
    servers,
    () => monitor as unknown as Connection,
    authorize,
    () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection as unknown as Connection;
    },
  );
  cameras.registry('default').add({ id: 'BASE_CAM', name: 'Roof' });
  cameras.start();
});
afterEach(() => {
  cameras.stop();
  servers.close();
  root.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (!directory.startsWith(join(tmpdir(), 'rust-camera-'))) throw new Error('Unsafe cleanup.');
  rmSync(directory, { recursive: true, force: true });
});
async function open(user = 'owner') {
  return cameras.redeem(cameras.issue('default', user, 'BASE_CAM'));
}
function frame() {
  connections[0].emit('cameraRays', { sampleOffset: 0, rayData: Buffer.from([0, 0]) });
}

describe('camera registrations and controls', () => {
  it('validates identifiers without changing case; persists across SQLite reopen', () => {
    expect(() => cameras.registry('default').add({ id: '\n', name: 'Bad' })).toThrow();
    expect(() => cameras.registry('default').add({ id: 'x'.repeat(33), name: 'Bad' })).toThrow();
    expect(() => cameras.registry('default').add({ id: 'BASE_CAM', name: 'Duplicate' })).toThrow();
    expect(() => cameras.registry('default').get('base_cam')).toThrow();
    const reopened = new Store(join(directory, 'bot.sqlite'));
    expect(new CameraRegistry(reopened).list()).toEqual([{ id: 'BASE_CAM', name: 'Roof' }]);
    reopened.close();
  });
  it('only permits explicit capability-gated movement, never firing/reload or arbitrary buttons', () => {
    for (const action of ['fire', 'reload', 'zoom', '1024', 'constructor', '__proto__'])
      expect(() => movement(action, 63)).toThrow();
    expect(() => movement('forward', 2)).toThrow();
    expect(() => movement('look-left', 1)).toThrow();
    expect(() => movement('down', 1)).toThrow();
    expect(movement('look-left', 2).mouseDelta).toEqual({ x: -5, y: 0 });
    expect(movement('look-up', 2).mouseDelta).toEqual({ x: 0, y: 5 });
    expect(movement('look-down', 2).mouseDelta).toEqual({ x: 0, y: -5 });
    expect(() => movement('up', 1)).toThrow();
    expect(movement('up', 7).buttons).toBe(128);
    expect(movement('release', 0).buttons).toBe(0);
  });
  it('combines held keys, cancels opposites and rejects unsupported or dangerous inputs', () => {
    expect(heldMovement(['forward', 'right', 'up'], 7).buttons).toBe(146);
    expect(heldMovement(['forward', 'back', 'left', 'right', 'up', 'down'], 7).buttons).toBe(0);
    expect(heldMovement(['look-left', 'look-right'], 2).mouseDelta.x).toBe(0);
    expect(heldMovement([], 0).buttons).toBe(0);
    for (const actions of [['fire'], ['release'], ['up'], ['forward', 'forward']])
      expect(() => heldMovement(actions, 1)).toThrow();
  });
  it('rejects unknown or dead presence', () => {
    expect(offlineMember(team, steam)).toBe(true);
    delete team.members[0].isOnline;
    expect(offlineMember(team, steam)).toBe(false);
    team.members[0].isOnline = false;
    team.members[0].isAlive = false;
    expect(offlineMember(team, steam)).toBe(false);
  });
});
describe('camera session authorization and lifecycle', () => {
  it('single-use links expire, and unregistered cameras cannot be selected', async () => {
    expect(() => cameras.issue('default', 'owner', 'unregistered')).toThrow();
    const token = cameras.issue('default', 'owner', 'BASE_CAM');
    const id = await cameras.redeem(token);
    await expect(cameras.redeem(token)).rejects.toThrow('already used');
    expect(cameras.status(id).shared).toBe(false);
    cameras.stopFor('default', 'owner');
    const expired = cameras.issue('default', 'owner', 'BASE_CAM');
    await vi.advanceTimersByTimeAsync(121000);
    await expect(cameras.redeem(expired)).rejects.toThrow('expired');
  });
  it('rechecks operator permission when a private link is redeemed', async () => {
    const token = cameras.issue('default', 'owner', 'BASE_CAM');
    authorize.mockRejectedValue(new Error('revoked'));
    await expect(cameras.redeem(token)).rejects.toThrow('camera access failed');
    expect(connections).toHaveLength(0);
  });
  it('never borrows an offline account without explicit consent; revocation closes it', async () => {
    await expect(open('viewer')).rejects.toThrow('No eligible');
    cameras.share('default', 'owner', true);
    const id = await open('viewer');
    expect(cameras.status(id).shared).toBe(true);
    cameras.share('default', 'owner', false);
    expect(() => cameras.status(id)).toThrow('revoked');
    await vi.advanceTimersByTimeAsync(2000);
    expect(connections[0].online).toBe(false);
  });
  it('will not select online accounts and stops when the owner goes online', async () => {
    team.members[0].isOnline = true;
    await expect(open()).rejects.toThrow('No eligible');
    team.members[0].isOnline = false;
    const id = await open();
    frame();
    team.members[0].isOnline = true;
    await vi.advanceTimersByTimeAsync(11000);
    expect(() => cameras.status(id)).toThrow('remain offline');
  });
  it('reserves the server socket slot before asynchronous opens', async () => {
    cameras.share('default', 'owner', true);
    const first = cameras.redeem(cameras.issue('default', 'owner', 'BASE_CAM'));
    const second = cameras.redeem(cameras.issue('default', 'viewer', 'BASE_CAM'));
    await expect(second).rejects.toThrow('already has an open camera');
    await first;
    expect(connections).toHaveLength(1);
  });
  it('sends to the registered camera and releases movement; concurrent inputs are rejected', async () => {
    const id = await open();
    frame();
    expect(
      connections[0].request.mock.calls.some(([r]) => r.cameraSubscribe?.cameraId === 'BASE_CAM'),
    ).toBe(true);
    const pending = cameras.input(id, 'forward');
    await expect(cameras.input(id, 'back')).rejects.toThrow('still running');
    await pending;
    const inputs = connections[0].request.mock.calls.flatMap(([r]) =>
      r.cameraInput ? [r.cameraInput.buttons] : [],
    );
    expect(inputs).toEqual([2, 0]);
    expect(motionCalls.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });
  it('does not retry failed movement and closes the session', async () => {
    const id = await open();
    frame();
    connections[0].request.mockRejectedValueOnce(new Error('timeout'));
    await expect(cameras.input(id, 'forward')).rejects.toThrow('not retried');
    expect(() => cameras.status(id)).toThrow('not retried');
    const moves = connections[0].request.mock.calls.filter(([r]) => r.cameraInput?.buttons === 2);
    expect(moves).toHaveLength(1);
  });
  it('coalesces held input, ignores old sequences and releases within the dead-man deadline', async () => {
    const id = await open();
    frame();
    cameras.hold(id, ['forward'], 1);
    cameras.hold(id, ['forward', 'right'], 2);
    await vi.advanceTimersByTimeAsync(100);
    cameras.hold(id, [], 3);
    cameras.hold(id, ['back'], 2);
    await vi.advanceTimersByTimeAsync(500);
    const inputs = () =>
      connections[0].request.mock.calls.flatMap(([r]) =>
        r.cameraInput ? [r.cameraInput.buttons] : [],
      );
    expect(inputs()).toEqual([18, 0]);
    expect(motionCalls.mock.calls.map(([active]) => active)).toEqual([true, false]);
    cameras.hold(id, ['left'], 4);
    await vi.advanceTimersByTimeAsync(1500);
    expect(inputs().slice(2, -1).length).toBeGreaterThan(1);
    expect(inputs().slice(2, -1).length).toBeLessThanOrEqual(10);
    expect(
      inputs()
        .slice(2, -1)
        .every((buttons) => buttons === 8),
    ).toBe(true);
    expect(inputs().at(-1)).toBe(0);
    expect(cameras.status(id).fresh).toBe(true);
  });
  it('samples the newest keys at dispatch and closes a stalled held input without retry', async () => {
    const id = await open();
    frame();
    let dispatch: (() => void) | undefined;
    connections[0].request.mockImplementationOnce(async (_request, _internal, before) => {
      dispatch = before;
      return new Promise(() => {});
    });
    cameras.hold(id, ['forward'], 1);
    await vi.advanceTimersByTimeAsync(100);
    cameras.hold(id, [], 2);
    dispatch?.();
    const held = connections[0].request.mock.calls.find(([r]) => r.cameraInput)?.[0];
    expect(held?.cameraInput?.buttons).toBe(0);
    await vi.advanceTimersByTimeAsync(2100);
    expect(() => cameras.status(id)).toThrow('timed out');
    expect(connections[0].online).toBe(false);
    expect(connections[0].request.mock.calls.some(([r]) => r.cameraInput?.buttons === 2)).toBe(
      false,
    );
  });
  it('streams smaller held look steps at a bounded ten Hz and promptly releases on key-up', async () => {
    const id = await open();
    frame();
    for (let i = 0; i < 4; i++) {
      cameras.hold(id, ['look-right'], i + 1);
      await vi.advanceTimersByTimeAsync(250);
    }
    const inputs = () =>
      connections[0].request.mock.calls.flatMap(([r]) => (r.cameraInput ? [r.cameraInput] : []));
    expect(inputs().length).toBeGreaterThanOrEqual(8);
    expect(inputs().length).toBeLessThanOrEqual(10);
    expect(inputs().every((input) => input.mouseDelta.x === 1 && input.buttons === 0)).toBe(true);
    cameras.hold(id, [], 5);
    await vi.advanceTimersByTimeAsync(100);
    expect(inputs().at(-1)?.mouseDelta).toEqual({ x: 0, y: 0 });
    const count = inputs().length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(inputs()).toHaveLength(count);
  });
  it('stream callbacks cannot interrupt cleanup and only one stream can attach', async () => {
    const id = await open();
    cameras.subscribe(id, () => {
      throw new Error('broken browser');
    });
    expect(() => cameras.subscribe(id, () => {})).toThrow('already has');
    expect(() => frame()).not.toThrow();
    expect(() => cameras.status(id)).toThrow('stream failed');
    await vi.advanceTimersByTimeAsync(2000);
    expect(connections[0].online).toBe(false);
  });
  it('renews the camera before a slow Discord permission refresh completes', async () => {
    const id = await open();
    frame();
    authorize.mockImplementation(async () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(17000);
    expect(connections[0].request.mock.calls.filter(([r]) => r.cameraSubscribe)).toHaveLength(3);
    expect(cameras.status(id).rayAge).toBe(17000);
  });
  it('closes on camera disconnect without reconnecting or switching accounts mid-session', async () => {
    const id = await open();
    connections[0].state = 'reconnecting';
    connections[0].emit('status', 'reconnecting');
    expect(() => cameras.status(id)).toThrow('connection lost');
    expect(connections[0].listenerCount('cameraRays')).toBe(0);
    expect(connections[0].listenerCount('status')).toBe(0);
    expect(connections).toHaveLength(1);
  });
  it('suspends a rejected personal identity instead of reopening it repeatedly', async () => {
    const id = await open();
    connections[0].state = 'invalid-credentials';
    connections[0].emit('status', 'invalid-credentials');
    expect(root.get('identityInvalid:default:owner', false)).toBe(true);
    expect(() => cameras.status(id)).toThrow('connection lost');
    await expect(open()).rejects.toThrow('No eligible');
    expect(connections).toHaveLength(1);
  });
  it('renews subscriptions and stops for revoked roles, lost monitoring, removed cameras and shutdown', async () => {
    const id = await open();
    frame();
    await vi.advanceTimersByTimeAsync(11000);
    expect(connections[0].request.mock.calls.filter(([r]) => r.cameraSubscribe)).toHaveLength(2);
    authorize.mockRejectedValue(new Error('roles revoked'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(() => cameras.status(id)).toThrow('verification failed');
    authorize.mockResolvedValue(undefined);
    const next = await open();
    frame();
    monitor.state = 'reconnecting';
    expect(() => cameras.status(next)).toThrow('monitoring is unavailable');
    monitor.state = 'connected';
    await vi.advanceTimersByTimeAsync(2000);
    const removed = await open();
    cameras.registry('default').remove('BASE_CAM');
    expect(() => cameras.status(removed)).toThrow('registered camera');
    cameras.stop();
    expect(connections.every((c) => !c.online)).toBe(true);
  });
  it('closes abandoned viewers and rejects stale movement', async () => {
    const id = await open();
    frame();
    await vi.advanceTimersByTimeAsync(11000);
    await expect(cameras.input(id, 'forward')).rejects.toThrow('fresh camera');
    await vi.advanceTimersByTimeAsync(20000);
    expect(() => cameras.status(id)).toThrow('No camera frames');
  });
});
