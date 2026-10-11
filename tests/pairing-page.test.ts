import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { page, script } from '../src/pairing/web-page';

function browser() {
  const code = 'synthetic-discord-code',
    origin = 'https://pair.example.org';
  const callback = 'http://localhost:55555/callback/0123456789abcdef0123456789abcdef';
  const loginUrl = `https://companion-rust.facepunch.com/login?returnUrl=${encodeURIComponent(callback)}`;
  const elements = new Map<
    string,
    {
      value: string;
      href: string;
      textContent: string;
      focus: ReturnType<typeof vi.fn>;
      select: ReturnType<typeof vi.fn>;
      classList: { toggle: ReturnType<typeof vi.fn> };
      addEventListener: (
        event: string,
        handler: (event: { preventDefault: () => void }) => void | Promise<void>,
      ) => void;
    }
  >();
  const handlers = new Map<
    string,
    (event: { preventDefault: () => void }) => void | Promise<void>
  >();
  const get = (id: string) => {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        href: '',
        textContent: '',
        focus: vi.fn(),
        select: vi.fn(),
        classList: { toggle: vi.fn() },
        addEventListener: (event, fn) => handlers.set(`${id}:${event}`, fn),
      });
    return elements.get(id)!;
  };
  const fetch = vi
    .fn<(path: string, options: { body: string }) => Promise<unknown>>()
    .mockResolvedValue({
      ok: true,
      json: async () => ({ csrf: 'csrf', loginUrl, command: 'encrypted-command' }),
    });
  let receive!: (event: object) => void;
  const window = {
    addEventListener: (_event: string, fn: typeof receive) => {
      receive = fn;
    },
    postMessage: vi.fn(),
  };
  const storage = new Map<string, string>();
  runInNewContext(script, {
    document: { getElementById: get },
    location: { hash: `#code=${code}`, pathname: '/', origin },
    history: { replaceState: vi.fn() },
    navigator: { clipboard: { writeText: vi.fn() } },
    URLSearchParams,
    URL,
    AbortSignal,
    fetch,
    window,
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    sessionStorage: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  return {
    callback,
    loginUrl,
    get,
    fetch,
    window,
    storage,
    click: (id: string) => handlers.get(`${id}:click`)!({ preventDefault: vi.fn() }),
    message: (data: unknown, source: unknown = window, requestOrigin = origin) =>
      receive({ source, origin: requestOrigin, data }),
  };
}

describe('website extension pairing', () => {
  it('requires extension detection and launches the exact session link only on user action', async () => {
    const ui = browser();
    await ui.click('prepare');
    await ui.click('steam');
    expect(ui.window.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'RUST_BASE_START' }),
      expect.anything(),
    );
    ui.message({ type: 'RUST_BASE_READY' });
    await ui.click('steam');
    expect(ui.window.postMessage).toHaveBeenLastCalledWith(
      { type: 'RUST_BASE_START', loginUrl: ui.loginUrl },
      'https://pair.example.org',
    );
    expect(page).not.toContain('RustPlus Pairing.cmd');
    expect(ui.storage.get('rust-base-code')).toBe('synthetic-discord-code');
  });
  it('rejects unrelated and cross-origin results and sends a valid result only after confirmation', async () => {
    const ui = browser();
    await ui.click('prepare');
    const address = `${ui.callback}?steamId=76561198000000000&token=synthetic-token-never-real`;
    ui.message({ type: 'RUST_BASE_RESULT', address }, {}, 'https://evil.example');
    ui.message({
      type: 'RUST_BASE_RESULT',
      address: address.replace('0123456789abcdef0123456789abcdef', 'wrong-session'),
    });
    expect(ui.get('login-progress').textContent).toBe('');
    ui.message({ type: 'RUST_BASE_RESULT', address });
    expect(ui.fetch).toHaveBeenCalledOnce();
    expect(ui.get('address').value).toBe('');
    expect([...ui.storage.values()].join('')).not.toContain('synthetic-token');
    await ui.click('finish');
    expect(JSON.parse(ui.fetch.mock.calls[1][1].body)).toEqual({ address, csrf: 'csrf' });
    expect(ui.get('command').value).toBe('encrypted-command');
    expect(ui.storage.has('rust-base-code')).toBe(false);
  });
});
