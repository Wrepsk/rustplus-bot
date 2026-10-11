import { runInNewContext, Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { extensionFiles, extensionZip, nativeBridge } from '../src/pairing/extension';

const origin = 'https://pair.example.org',
  fp = 'https://companion-rust.facepunch.com';
const callback = 'http://localhost:55555/callback/0123456789abcdef0123456789abcdef';
const loginUrl = `${fp}/login?returnUrl=${encodeURIComponent(callback)}`;
const auth = { SteamId: '76561198000000000', Token: 'synthetic-auth-token-never-real' };
interface Sender {
  frameId: number;
  tab: { id: number };
  url: string;
  documentId: string;
}
const site: Sender = {
  frameId: 0,
  tab: { id: 1 },
  url: origin + '/',
  documentId: 'website-document',
};
function worker() {
  let receive!: (message: unknown, sender: Sender, respond: (result: unknown) => void) => boolean;
  let headers!: (details: object) => void;
  let removed!: (id: number) => void;
  const storage: Record<string, unknown> = {};
  let nextTab = 100;
  const chrome = {
    runtime: {
      onMessage: {
        addListener: (fn: typeof receive) => {
          receive = fn;
        },
      },
    },
    storage: {
      session: {
        get: vi.fn(async (key: string | null) =>
          key === null ? { ...storage } : { [key]: storage[key] },
        ),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(storage, values);
        }),
        remove: vi.fn(async (key: string) => {
          delete storage[key];
        }),
      },
    },
    tabs: {
      create: vi.fn(async () => ({ id: nextTab++ })),
      get: vi.fn(async () => ({ url: origin + '/' })),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}),
      sendMessage: vi
        .fn<
          (
            id: number,
            message: { type: string; address: string },
            options: { documentId: string },
          ) => Promise<{ ok: boolean }>
        >()
        .mockResolvedValue({ ok: true }),
      onRemoved: {
        addListener: (fn: typeof removed) => {
          removed = fn;
        },
      },
    },
    webRequest: {
      onHeadersReceived: {
        addListener: (fn: typeof headers) => {
          headers = fn;
        },
      },
    },
  };
  const context = { chrome, URL, Date };
  runInNewContext(extensionFiles(origin)['background.js'], context);
  const message = (data: unknown, sender = site) =>
    new Promise<unknown>((resolve) => receive(data, sender, resolve));
  const native = (id = 100, url = fp + '/app') => ({
    frameId: 0,
    tab: { id },
    url,
    documentId: 'native-document',
  });
  return {
    chrome,
    storage,
    message,
    native,
    headers: (details: object) => headers(details),
    removed: (id: number) => removed(id),
  };
}

describe('self-hosted pairing extension', () => {
  it('packages valid scripts and a reproducible ZIP with narrowly scoped permissions', () => {
    const files = extensionFiles(origin);
    const manifest = JSON.parse(files['manifest.json']);
    expect(manifest.permissions).toEqual(['storage', 'webRequest']);
    expect(manifest.host_permissions).toEqual([fp + '/*', origin + '/*']);
    expect(manifest.content_scripts[0].world).toBe('MAIN');
    for (const [name, source] of Object.entries(files))
      if (name.endsWith('.js')) expect(() => new Script(source)).not.toThrow();
    const zip = extensionZip(origin);
    expect(zip.equals(extensionZip(origin))).toBe(true);
    const end = zip.length - 22,
      central = zip.readUInt32LE(end + 16);
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt32LE(central)).toBe(0x02014b50);
    expect(zip.readUInt16LE(end + 10)).toBe(Object.keys(files).length);
    let offset = 0;
    for (const [name, source] of Object.entries(files)) {
      const length = zip.readUInt32LE(offset + 18),
        filename = zip.readUInt16LE(offset + 26);
      expect(zip.subarray(offset + 30, offset + 30 + filename).toString()).toBe(name);
      expect(zip.subarray(offset + 30 + filename, offset + 30 + filename + length).toString()).toBe(
        source,
      );
      offset += 30 + filename + length;
    }
    expect(offset).toBe(central);
  });
  it('returns credentials only to the bound website document and ignores duplicate payloads', async () => {
    const w = worker();
    expect(await w.message({ type: 'start', loginUrl })).toEqual({ ok: true });
    expect(JSON.stringify(w.storage)).not.toContain(auth.Token);
    expect(await w.message({ type: 'native', ...auth }, w.native())).toEqual({ ok: true });
    const [tab, payload, options] = w.chrome.tabs.sendMessage.mock.calls[0];
    expect(tab).toBe(1);
    expect(options.documentId).toBe(site.documentId);
    expect(new URL(payload.address).searchParams.get('token')).toBe(auth.Token);
    expect(Object.keys(w.storage)).toHaveLength(0);
    expect(await w.message({ type: 'native', ...auth }, w.native())).toEqual({ ok: false });
    expect(w.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
    expect(JSON.stringify(w.chrome.tabs.update.mock.calls)).not.toContain(auth.Token);
  });
  it('rejects unowned tabs, foreign sites, subframes and malformed login destinations', async () => {
    const w = worker();
    for (const sender of [
      { ...site, url: 'https://evil.example/' },
      { ...site, frameId: 2 },
    ])
      expect(await w.message({ type: 'start', loginUrl }, sender)).toEqual({ ok: false });
    for (const url of [
      loginUrl.replace(fp, 'https://evil.example'),
      loginUrl.replace('localhost', 'evil.example'),
      loginUrl + '&extra=1',
    ])
      expect(await w.message({ type: 'start', loginUrl: url })).toEqual({ ok: false });
    expect(w.chrome.tabs.create).not.toHaveBeenCalled();
    await w.message({ type: 'start', loginUrl });
    expect(await w.message({ type: 'native', ...auth }, w.native(999))).toEqual({ ok: false });
    expect(
      await w.message(
        { type: 'native', ...auth },
        w.native(100, 'https://companion-rust.facepunch.com.evil.example/app'),
      ),
    ).toEqual({ ok: false });
    expect(w.chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
  it('expires attempts and refuses delivery when the original website tab has navigated away', async () => {
    const w = worker();
    await w.message({ type: 'start', loginUrl });
    w.chrome.tabs.get.mockResolvedValueOnce({ url: 'https://evil.example/' });
    expect(await w.message({ type: 'native', ...auth }, w.native())).toEqual({ ok: false });
    const entry = w.storage['rust-base:100'] as { expires: number };
    entry.expires = Date.now() - 1;
    expect(await w.message({ type: 'native', ...auth }, w.native())).toEqual({ ok: false });
    expect(w.chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(Object.keys(w.storage)).toHaveLength(0);
  });
  it('isolates simultaneous users and replaces only the same website tab’s earlier attempt', async () => {
    const w = worker();
    await w.message({ type: 'start', loginUrl });
    const other = { ...site, tab: { id: 2 }, documentId: 'other-document' };
    await w.message(
      {
        type: 'start',
        loginUrl: loginUrl.replace(
          '0123456789abcdef0123456789abcdef',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ),
      },
      other,
    );
    await w.message({ type: 'start', loginUrl });
    expect(Object.keys(w.storage).sort()).toEqual(['rust-base:101', 'rust-base:102']);
    expect(await w.message({ type: 'native', ...auth }, w.native(100))).toEqual({ ok: false });
    await w.message({ type: 'native', ...auth }, w.native(101));
    expect(w.chrome.tabs.sendMessage.mock.calls[0][0]).toBe(2);
    await w.message({ type: 'native', ...auth }, w.native(102));
    expect(w.chrome.tabs.sendMessage.mock.calls[1][0]).toBe(1);
  });
  it('supports a real loopback redirect while rejecting a mismatched callback and duplicate broadcast', async () => {
    const w = worker();
    await w.message({ type: 'start', loginUrl });
    const event = (address: string) => ({
      tabId: 100,
      type: 'main_frame',
      statusCode: 302,
      responseHeaders: [{ name: 'Location', value: address }],
    });
    const address = `${callback}?steamId=${auth.SteamId}&token=${auth.Token}`;
    w.headers(event(address.replace('/callback/', '/wrong/')));
    // A subsequent request serializes behind the rejected redirect.
    await w.message({ type: 'unknown' });
    expect(w.chrome.tabs.sendMessage).not.toHaveBeenCalled();
    w.headers(event(address));
    await w.message({ type: 'native', ...auth }, w.native());
    expect(w.chrome.tabs.sendMessage).toHaveBeenCalledOnce();
  });
  it('cleans metadata when a tab closes and does not redirect credentials on failed delivery', async () => {
    const w = worker();
    await w.message({ type: 'start', loginUrl });
    w.chrome.tabs.sendMessage.mockRejectedValueOnce(new Error('Original document closed'));
    expect(await w.message({ type: 'native', ...auth }, w.native())).toEqual({ ok: false });
    expect(JSON.stringify(w.storage)).not.toContain(auth.Token);
    expect(JSON.stringify(w.chrome.tabs.update.mock.calls)).not.toContain(auth.Token);
    w.removed(1);
    await w.message({ type: 'unknown' });
    expect(Object.keys(w.storage)).toHaveLength(0);
  });
});

describe('Facepunch native handoff bridge', () => {
  function bridge(owned: boolean) {
    let receive!: (event: object) => void;
    const values = new Map<string, string>();
    const window: {
      top?: unknown;
      ReactNativeWebView?: { postMessage: (message: string) => void };
      dispatchEvent: ReturnType<typeof vi.fn>;
      addEventListener: (event: string, fn: typeof receive) => void;
    } = {
      dispatchEvent: vi.fn(),
      addEventListener: (_event, fn) => {
        receive = fn;
      },
    };
    window.top = window;
    runInNewContext(nativeBridge, {
      window,
      URL,
      URLSearchParams,
      Date,
      CustomEvent: class {
        constructor(
          readonly type: string,
          readonly options: { detail: string },
        ) {}
      },
      location: {
        origin: fp,
        hash: owned ? '#rust-base-bridge=0123456789abcdef0123456789abcdef' : '',
        search: '?returnUrl=' + encodeURIComponent(callback),
      },
      sessionStorage: {
        getItem: (key: string) => values.get(key),
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
      setTimeout: vi.fn(),
    });
    return {
      window,
      values,
      ready: () => receive({}),
    };
  }
  it('captures a single validated payload after the relay is ready without persisting tokens', () => {
    const b = bridge(true);
    b.window.ReactNativeWebView!.postMessage(JSON.stringify(auth));
    expect(b.window.dispatchEvent).not.toHaveBeenCalled();
    b.ready();
    expect(b.window.dispatchEvent).toHaveBeenCalledWith({
      type: 'rust-base-native',
      options: { detail: JSON.stringify(auth) },
    });
    b.window.ReactNativeWebView!.postMessage(JSON.stringify(auth));
    expect(b.window.dispatchEvent).toHaveBeenCalledOnce();
    expect([...b.values.values()].join('')).not.toContain(auth.Token);
  });
  it('does not install a bridge in unrelated login tabs and ignores malformed auth', () => {
    expect(bridge(false).window.ReactNativeWebView).toBeUndefined();
    const b = bridge(true);
    b.ready();
    b.window.ReactNativeWebView!.postMessage('not-json');
    b.window.ReactNativeWebView!.postMessage(JSON.stringify({ ...auth, SteamId: 'bad' }));
    expect(b.window.dispatchEvent).not.toHaveBeenCalled();
  });
});
