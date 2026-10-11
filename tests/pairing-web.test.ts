import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PairingWeb, parseSteamReturn } from '../src/pairing/web';
import { decryptPairing, pairingChallenge } from '../src/pairing/crypto';
import type { Registration } from '../src/pairing/registration';

let web: PairingWeb, base: string;
let challenge: ReturnType<typeof pairingChallenge>;
let register: ReturnType<typeof vi.fn<Registration>>;
let active: boolean;
const origin = 'https://pair.example.org';
const token = 'synthetic-test-token-never-a-real-credential';
const credentials = { androidId: '12345', securityToken: '67890' };
beforeEach(async () => {
  active = true;
  challenge = pairingChallenge();
  register = vi.fn<Registration>().mockResolvedValue(credentials);
  web = new PairingWeb(origin, (code) => active && code === challenge.code, register);
  await web.start(0);
  base = `http://127.0.0.1:${web.port}`;
});
afterEach(async () => {
  await web.stop();
  vi.restoreAllMocks();
});
async function post(path: string, body: unknown, cookie = '', requestOrigin = origin) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: requestOrigin,
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });
}
async function start() {
  const response = await post('/api/start', { code: challenge.code });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const data = (await response.json()) as { csrf: string; loginUrl: string };
  const callback = new URL(data.loginUrl).searchParams.get('returnUrl')!;
  const address = `${callback}?steamId=76561198000000000&token=${token}`;
  return { cookie, csrf: data.csrf, address, callback, loginUrl: data.loginUrl };
}
describe('self-hosted browser pairing', () => {
  it('serves only fixed assets with privacy and framing protections', async () => {
    const response = await fetch(base);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await response.text()).toContain('can’t connect');
    expect((await fetch(`${base}/.env`)).status).toBe(404);
    expect((await fetch(`${base}/?token=secret`)).status).toBe(404);
  });
  it('requires a complete active Discord challenge, not just its ID', async () => {
    for (const code of ['invalid', challenge.code.split('.')[0], `${challenge.code}x`])
      expect((await post('/api/start', { code })).status).toBe(400);
    active = false;
    expect((await post('/api/start', { code: challenge.code })).status).toBe(400);
    expect(register).not.toHaveBeenCalled();
  });
  it('opens official Facepunch login with a nonce-bound loopback return', async () => {
    const response = await post('/api/start', { code: challenge.code });
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Strict');
    const result = (await response.json()) as { loginUrl: string };
    const login = new URL(result.loginUrl),
      callback = new URL(login.searchParams.get('returnUrl')!);
    expect(login.origin).toBe('https://companion-rust.facepunch.com');
    expect(callback.hostname).toBe('localhost');
    expect(callback.pathname).toMatch(/^\/callback\/[a-f0-9]{32}$/);
    expect(Number(callback.port)).toBeGreaterThanOrEqual(49152);
  });
  it('returns an encrypted import command compatible with the existing protocol', async () => {
    const session = await start();
    const response = await post('/api/complete', session, session.cookie);
    // Strict endpoint input: use only the documented two fields.
    expect(response.status).toBe(403);
    const result = await post(
      '/api/complete',
      { address: session.address, csrf: session.csrf },
      session.cookie,
    );
    expect(result.status).toBe(200);
    const data = (await result.json()) as { command: string };
    expect(data.command).toMatch(/^\/pair import data:/);
    expect(data.command).not.toContain(token);
    expect(data.command).not.toContain(credentials.securityToken);
    expect(decryptPairing(challenge.privateKey, data.command.split('data:')[1])).toEqual(
      credentials,
    );
    expect(register).toHaveBeenCalledWith(token, expect.any(AbortSignal));
  });
  it('rejects cross-origin, missing-cookie and forged-CSRF requests', async () => {
    expect(
      (await post('/api/start', { code: challenge.code }, '', 'https://evil.example')).status,
    ).toBe(403);
    const session = await start();
    expect(
      (await post('/api/complete', { address: session.address, csrf: session.csrf })).status,
    ).toBe(403);
    expect(
      (await post('/api/complete', { address: session.address, csrf: 'forged' }, session.cookie))
        .status,
    ).toBe(403);
    expect(register).not.toHaveBeenCalled();
  });
  it('rejects replay after importing or superseding the Discord challenge', async () => {
    const session = await start();
    active = false;
    expect(
      (
        await post(
          '/api/complete',
          { address: session.address, csrf: session.csrf },
          session.cookie,
        )
      ).status,
    ).toBe(403);
    expect(register).not.toHaveBeenCalled();
  });
  it('validates pasted addresses without fetching arbitrary URLs', async () => {
    const session = await start();
    const bad = [
      session.address.replace('localhost', 'evil.example'),
      session.address.replace('/callback/', '/different/'),
      session.address.replace('http:', 'https:'),
      `${session.address}&token=another`,
      session.address.replace('76561198000000000', 'nope'),
      `${session.address}#fragment`,
    ];
    for (const address of bad)
      expect(
        (await post('/api/complete', { address, csrf: session.csrf }, session.cookie)).status,
      ).toBe(400);
    expect(register).not.toHaveBeenCalled();
  });
  it('deduplicates double submission and retries after a lost response', async () => {
    let finish!: (value: typeof credentials) => void;
    register.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const session = await start(),
      body = { address: session.address, csrf: session.csrf };
    const pending = post('/api/complete', body, session.cookie);
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
    expect((await post('/api/complete', body, session.cookie)).status).toBe(409);
    finish(credentials);
    const first = await (await pending).json();
    expect(await (await post('/api/complete', body, session.cookie)).json()).toEqual(first);
    expect(register).toHaveBeenCalledOnce();
  });
  it('bounds failed registration attempts and never returns raw upstream errors', async () => {
    register.mockRejectedValue(new Error(`sensitive upstream address=${token}`));
    const session = await start(),
      body = { address: session.address, csrf: session.csrf };
    for (let index = 0; index < 3; index++) {
      const response = await post('/api/complete', body, session.cookie);
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain(token);
    }
    expect((await post('/api/complete', body, session.cookie)).status).toBe(429);
    expect(register).toHaveBeenCalledTimes(3);
  });
  it('expires browser sessions and clears them on shutdown', async () => {
    const session = await start();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60000);
    expect(
      (
        await post(
          '/api/complete',
          { address: session.address, csrf: session.csrf },
          session.cookie,
        )
      ).status,
    ).toBe(403);
    expect(register).not.toHaveBeenCalled();
  });
  it('aborts pending registration on shutdown', async () => {
    let signal: AbortSignal | undefined;
    register.mockImplementation(
      (_token, abort) =>
        new Promise((_resolve, reject) => {
          signal = abort;
          abort.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
        }),
    );
    const session = await start();
    const pending = post(
      '/api/complete',
      { address: session.address, csrf: session.csrf },
      session.cookie,
    ).catch(() => null);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await web.stop();
    expect(signal!.aborted).toBe(true);
    await pending;
  });
});
describe('Steam return parser', () => {
  it('rejects credentials, duplicate Steam IDs and missing token fields', () => {
    const callback = 'http://localhost:55555/callback/nonce';
    for (const address of [
      `${callback}?steamId=76561198000000000`,
      `${callback}?steamId=76561198000000000&steamId=76561198000000001&token=${token}`,
      `http://user:password@localhost:55555/callback/nonce?steamId=76561198000000000&token=${token}`,
    ])
      expect(() => parseSteamReturn(address, callback)).toThrow();
  });
});
