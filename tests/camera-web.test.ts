import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CameraWeb } from '../src/cameras/web';
import type { Cameras } from '../src/cameras/service';
import { PairingWeb } from '../src/pairing/web';
import { cameraScript } from '../src/cameras/page';
let web: PairingWeb, base: string;
const origin = 'https://pair.example.org',
  token = 'a'.repeat(64),
  session = 'b'.repeat(64);
const cameras = {
  redeem: vi.fn(async () => session),
  close: vi.fn(),
  status: vi.fn(() => ({
    server: '<script>alert(1)</script>',
    camera: '@everyone',
    flags: 3,
    fresh: true,
    frameAt: Date.now(),
  })),
  frame: vi.fn(() => Buffer.from('PNG')),
  input: vi.fn(async () => {}),
};
beforeEach(async () => {
  vi.clearAllMocks();
  const viewer = new CameraWeb(origin, cameras as unknown as Cameras);
  web = new PairingWeb(
    origin,
    () => false,
    undefined,
    (req, res) => viewer.handle(req, res),
  );
  await web.start(0);
  base = `http://127.0.0.1:${web.port}`;
});
afterEach(async () => {
  await web.stop();
});
async function post(path: string, body: unknown, cookie = '', from = origin) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: from, Cookie: cookie },
    body: JSON.stringify(body),
  });
}
async function open() {
  const response = await post('/camera/api/open', { ticket: token });
  expect(response.status).toBe(200);
  const data = (await response.json()) as { slot: string };
  return {
    path: '/camera/api/' + data.slot,
    cookie: response.headers.get('set-cookie')!,
    response,
  };
}
it('serves the camera viewer through the existing server, retaining pairing assets and privacy headers', async () => {
  for (const path of ['/camera', '/camera.js', '/camera.css', '/', '/pair.js']) {
    const response = await fetch(base + path);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  }
  expect(() => new Function(cameraScript)).not.toThrow();
  expect(cameraScript).toContain('textContent');
  expect(cameraScript).not.toContain('innerHTML');
});
it('exchanges fragment capabilities for secure path-scoped cookies, keeping tokens out of API URLs', async () => {
  const first = await open(),
    second = await open();
  expect(first.path).not.toBe(second.path);
  expect(first.path).not.toContain(session);
  expect(first.cookie).toContain('HttpOnly; Secure; SameSite=Strict');
  expect(first.cookie).toContain('Path=' + first.path);
  expect(await first.response.text().catch(() => '')).not.toContain(session);
  expect(cameras.redeem).toHaveBeenCalledWith(token);
});
it('requires same-origin JSON mutations and a session cookie, with bounded strict inputs', async () => {
  expect(
    (await post('/camera/api/open', { ticket: token }, '', 'https://evil.example')).status,
  ).toBe(403);
  expect(cameras.redeem).not.toHaveBeenCalled();
  expect((await post('/camera/api/open', { ticket: token, extra: true })).status).toBe(400);
  expect((await post('/camera/api/open', { ticket: 'x'.repeat(2000) })).status).toBe(413);
  const { path, cookie } = await open();
  expect((await fetch(base + path + '/frame')).status).toBe(400);
  expect(cameras.frame).not.toHaveBeenCalled();
  expect((await post(path + '/input', { buttons: 1024 }, cookie)).status).toBe(400);
  expect(cameras.input).not.toHaveBeenCalled();
  expect(
    (await post(path + '/input', { action: 'look-left' }, cookie, 'https://evil.example')).status,
  ).toBe(403);
  expect((await post(path + '/input', { action: 'look-left' }, cookie)).status).toBe(200);
  expect(cameras.input).toHaveBeenCalledWith(session, 'look-left');
  expect((await post(path + '/stop', {}, cookie)).status).toBe(200);
  expect(cameras.close).toHaveBeenCalledWith(session);
});
