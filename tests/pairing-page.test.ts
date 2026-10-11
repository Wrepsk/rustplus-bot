import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { page, script } from '../src/pairing/web-page';

function browser() {
  const code = 'synthetic-discord-code';
  const loginUrl =
    'https://companion-rust.facepunch.com/login?returnUrl=http%3A%2F%2Flocalhost%3A55555%2Fcallback%2Fnonce';
  const elements = new Map<
    string,
    {
      value: string;
      href: string;
      focus: ReturnType<typeof vi.fn>;
      select: ReturnType<typeof vi.fn>;
      classList: { toggle: ReturnType<typeof vi.fn> };
      addEventListener: (event: string, handler: () => void | Promise<void>) => void;
    }
  >();
  const handlers = new Map<string, () => void | Promise<void>>();
  const get = (id: string) => {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        href: '',
        focus: vi.fn(),
        select: vi.fn(),
        classList: { toggle: vi.fn() },
        addEventListener: (event, handler) => handlers.set(`${id}:${event}`, handler),
      });
    return elements.get(id)!;
  };
  const fetch = vi
    .fn<(path: string, options: unknown) => Promise<unknown>>()
    .mockResolvedValue({ ok: true, json: async () => ({ csrf: 'csrf', loginUrl }) });
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  runInNewContext(script, {
    document: { getElementById: get },
    location: { hash: `#code=${code}`, pathname: '/' },
    history: { replaceState: vi.fn() },
    navigator: { clipboard: { writeText } },
    URLSearchParams,
    AbortSignal,
    fetch,
  });
  return {
    code,
    loginUrl,
    get,
    fetch,
    writeText,
    click: (id: string) => handlers.get(`${id}:click`)!(),
  };
}

describe('pairing handoff troubleshooting', () => {
  it('copies the exact nonce-bound login link and same Discord code without automating consent', async () => {
    const ui = browser();
    await ui.click('prepare');
    expect(ui.get('steam').href).toBe(ui.loginUrl);
    await ui.click('copy-login');
    expect(ui.writeText).toHaveBeenLastCalledWith(ui.loginUrl);
    await ui.click('copy-helper');
    expect(ui.writeText).toHaveBeenLastCalledWith(ui.code);
    expect(ui.fetch).toHaveBeenCalledOnce();
    expect(ui.fetch.mock.calls[0][0]).toBe('/api/start');
    expect(page).toContain('Sent to the official Rust+ app page instead?');
    expect(script).not.toContain('ReactNativeWebView');
  });

  it('selects the public login link for manual copy if clipboard access fails', async () => {
    const ui = browser();
    await ui.click('prepare');
    ui.writeText.mockRejectedValueOnce(new Error('Clipboard denied'));
    await ui.click('copy-login');
    expect(ui.get('login-link').value).toBe(ui.loginUrl);
    expect(ui.get('login-link').focus).toHaveBeenCalledOnce();
    expect(ui.get('login-link').select).toHaveBeenCalledOnce();
    expect(ui.fetch).toHaveBeenCalledOnce();
  });
});
