import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { cameraScript } from '../src/cameras/page';

type Handler = (event: Record<string, unknown>) => void;
async function viewer(flags = 7) {
  vi.useFakeTimers();
  const events = new Map<string, Handler>();
  const streamEvents = new Map<string, Handler>();
  const elements = new Map<
    string,
    { textContent?: string; hidden?: boolean; addEventListener: ReturnType<typeof vi.fn> }
  >();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { addEventListener: vi.fn() });
    return elements.get(id)!;
  };
  const fetch = vi.fn<
    (
      path: string,
      options: { body?: string },
    ) => Promise<{ ok: boolean; json: () => Promise<{ slot: string }> }>
  >(async () => ({
    ok: true,
    json: async () => ({ slot: 'a'.repeat(24) }),
  }));
  const close = vi.fn();
  const document = {
    getElementById: element,
    querySelectorAll: () => [],
    hidden: false,
    addEventListener: vi.fn(),
  };
  runInNewContext(cameraScript, {
    document,
    location: { hash: '#ticket=' + 'b'.repeat(64) },
    history: { replaceState: vi.fn() },
    URLSearchParams,
    URL,
    AbortSignal,
    fetch,
    Date,
    setInterval,
    clearInterval,
    addEventListener: (name: string, handler: Handler) => events.set(name, handler),
    EventSource: class {
      close = close;
      addEventListener(name: string, handler: Handler) {
        streamEvents.set(name, handler);
      }
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  const status = (fresh = true) =>
    streamEvents.get('status')!({
      data: JSON.stringify({
        server: 'Test',
        camera: 'Roof',
        shared: false,
        flags,
        fresh,
        frameAt: Date.now(),
        rayFps: 10,
        renderFps: 10,
        frameAge: 0,
        rayAge: 0,
      }),
    });
  status();
  const key = async (type: string, code: string, extra = {}) => {
    const preventDefault = vi.fn();
    events.get(type)!({ code, preventDefault, ...extra });
    await vi.advanceTimersByTimeAsync(0);
    return preventDefault;
  };
  const inputs = () =>
    fetch.mock.calls
      .filter(([path]) => path.endsWith('/input'))
      .map(([, options]) => JSON.parse(options.body!) as { actions: string[]; sequence: number });
  return { key, status, inputs, events, fetch, close, elements };
}
afterEach(() => vi.useRealTimers());

it('holds WASD combinations, ignores key repeat and releases on key-up and focus loss', async () => {
  const v = await viewer();
  expect(await v.key('keydown', 'KeyW')).toHaveBeenCalled();
  await v.key('keydown', 'KeyW', { repeat: true });
  expect(v.inputs()).toHaveLength(1);
  await v.key('keydown', 'KeyD');
  expect(v.inputs().at(-1)?.actions).toEqual(['forward', 'right']);
  await v.key('keyup', 'KeyW');
  expect(v.inputs().at(-1)?.actions).toEqual(['right']);
  v.events.get('blur')!({});
  await vi.advanceTimersByTimeAsync(0);
  expect(v.inputs().at(-1)?.actions).toEqual([]);
  expect(v.inputs().map((i) => i.sequence)).toEqual([1, 2, 3, 4]);
});
it('maps WASD to look for stationary cameras; supports drone vertical keys and lease heartbeats', async () => {
  const camera = await viewer(2);
  await camera.key('keydown', 'KeyA');
  expect(camera.inputs().at(-1)?.actions).toEqual(['look-left']);
  await camera.key('keyup', 'KeyA');
  expect(await camera.key('keydown', 'Space')).not.toHaveBeenCalled();
  const drone = await viewer(7);
  await drone.key('keydown', 'Space');
  expect(drone.inputs().at(-1)?.actions).toEqual(['up']);
  await vi.advanceTimersByTimeAsync(250);
  expect(drone.inputs()).toHaveLength(2);
  await drone.key('keydown', 'Escape');
  expect(drone.inputs().at(-1)?.actions).toEqual([]);
  await drone.key('keydown', 'ShiftLeft');
  expect(drone.inputs().at(-1)?.actions).toEqual(['down']);
});
it('ignores text editing, modifiers, unsupported keys and stale feeds; closes on a stalled stream', async () => {
  const v = await viewer();
  await v.key('keydown', 'KeyW', { target: { tagName: 'INPUT' } });
  await v.key('keydown', 'KeyW', { ctrlKey: true });
  await v.key('keydown', 'KeyF');
  expect(v.inputs()).toHaveLength(0);
  await v.key('keydown', 'KeyW');
  v.status(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(v.inputs().at(-1)?.actions).toEqual([]);
  await v.key('keydown', 'KeyW');
  expect(v.inputs()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(6250);
  expect(v.close).toHaveBeenCalled();
  expect(v.elements.get('error')?.textContent).toContain('stalled');
});
it('shows a control delivery failure and closes the stream instead of pretending it worked', async () => {
  const v = await viewer();
  v.fetch.mockRejectedValueOnce(new Error('network down'));
  await v.key('keydown', 'KeyW');
  expect(v.close).toHaveBeenCalled();
  expect(v.elements.get('error')?.textContent).toBe('network down');
});
