import { companionTokenPattern, handoffErrors } from './handoff';

// These packaged scripts run in Chrome, not in Node. No remote code or dependencies.
export const nativeBridge = String.raw`
(() => {
  if (window !== window.top || location.origin !== 'https://companion-rust.facepunch.com') return;
  const key = 'rust-base-login';
  let pending = null, ready = false, sent = false, inFlight = false;
  try {
    const nonce = new URLSearchParams(location.hash.slice(1)).get('rust-base-bridge');
    const callback = new URL(new URLSearchParams(location.search).get('returnUrl') || '');
    if (/^[a-f0-9]{32}$/.test(nonce || '') && callback.pathname === '/callback/' + nonce && callback.hostname === 'localhost')
      sessionStorage.setItem(key, JSON.stringify({ expires: Date.now() + 900000 }));
  } catch { /* An existing marker survives the Steam round trip in this tab. */ }
  try {
    if (!(JSON.parse(sessionStorage.getItem(key) || 'null')?.expires > Date.now())) return;
  } catch { return; }
  // Leave real native bridges and the official consent UI untouched.
  if (window.ReactNativeWebView !== undefined) return;
  const flush = () => {
    if (!pending || !ready || inFlight) return;
    inFlight = true;
    // Synchronous DOM events reach the isolated relay before Facepunch navigates away.
    window.dispatchEvent(new CustomEvent('rust-base-native', { detail: JSON.stringify(pending) }));
    pending = null;
  };
  window.addEventListener('rust-base-relay-ready', () => { ready = true; flush(); });
  window.addEventListener('rust-base-delivery', (event) => {
    inFlight = false;
    sent = event.detail === 'ok';
    if (sent) sessionStorage.removeItem(key);
  });
  window.ReactNativeWebView = { postMessage: (message) => {
    if (sent || inFlight) return;
    const invalid = (code) => window.dispatchEvent(new CustomEvent('rust-base-invalid-auth', { detail: code }));
    if (typeof message !== 'string' || message.length > 12000) { invalid('AUTH_PAYLOAD'); return; }
    try {
      const data = JSON.parse(message);
      if (typeof data?.SteamId !== 'string' || !/^\d{17}$/.test(data.SteamId)) { invalid('AUTH_STEAM_ID'); return; }
      if (typeof data.Token !== 'string' || !${companionTokenPattern}.test(data.Token)) { invalid('AUTH_TOKEN_FORMAT'); return; }
      pending = { SteamId: data.SteamId, Token: data.Token }; flush();
    } catch { invalid('AUTH_PAYLOAD'); }
  } };
  // Content scripts in MAIN and ISOLATED worlds may start in either order.
  // If the relay's first ready event was missed, ask it to announce itself again.
  window.dispatchEvent(new Event('rust-base-bridge-ready'));
  setTimeout(() => { pending = null; }, 900000);
})();
`;

export const nativeRelay = String.raw`
(() => {
  if (window !== window.top) return;
  const errors = ${JSON.stringify(handoffErrors)};
  const ready = () => window.dispatchEvent(new Event('rust-base-relay-ready'));
  window.addEventListener('rust-base-bridge-ready', ready);
  const fail = (reason) => {
    const code = Object.hasOwn(errors, reason) ? reason : 'DELIVERY_FAILED';
    window.dispatchEvent(new CustomEvent('rust-base-delivery', { detail: 'failed' }));
    console.warn('Rust Base pairing [' + code + ']: ' + errors[code]);
    void chrome.runtime.sendMessage({ type: 'failed', code }).catch(() => {});
  };
  window.addEventListener('rust-base-invalid-auth', (event) => fail(event.detail));
  window.addEventListener('rust-base-native', (event) => {
    if (typeof event.detail !== 'string' || event.detail.length > 12000) return;
    try {
      const data = JSON.parse(event.detail);
      void chrome.runtime.sendMessage({ type: 'native', SteamId: data.SteamId, Token: data.Token }).then((result) => {
        if (!result?.ok) { fail(result?.code); return; }
        window.dispatchEvent(new CustomEvent('rust-base-delivery', { detail: 'ok' }));
        // Acknowledge delivery before asking the worker to close this tab.
        void chrome.runtime.sendMessage({ type: 'finish' }).catch(() => {});
      }).catch(() => fail('MESSAGE_PORT'));
    } catch { fail('AUTH_PAYLOAD'); }
  });
  ready();
})();
`;

export const websiteRelay = String.raw`
(() => {
  if (window !== window.top) return;
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === 'RUST_BASE_PING')
      window.postMessage({ type: 'RUST_BASE_READY', version: '1.0.2' }, location.origin);
    if (event.data?.type !== 'RUST_BASE_START' || typeof event.data.loginUrl !== 'string') return;
    void chrome.runtime.sendMessage({ type: 'start', loginUrl: event.data.loginUrl }).then((result) => {
      if (!result?.ok) window.postMessage({ type: 'RUST_BASE_ERROR', error: 'Could not open the extension login. Refresh this page and try again.' }, location.origin);
    }).catch(() => window.postMessage({ type: 'RUST_BASE_ERROR', error: 'Extension unavailable. Reload the extension and refresh this page.' }, location.origin));
  });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'error') {
      window.postMessage({ type: 'RUST_BASE_ERROR', code: message.code }, location.origin);
      respond({ ok: true }); return;
    }
    if (message?.type !== 'result' || typeof message.address !== 'string') return;
    window.postMessage({ type: 'RUST_BASE_RESULT', address: message.address }, location.origin);
    respond({ ok: true });
  });
})();
`;

export const background = String.raw`
const FP = 'https://companion-rust.facepunch.com';
const errors = ${JSON.stringify(handoffErrors)};
const prefix = 'rust-base:';
let chain = Promise.resolve(), queued = 0;
function serialize(work) {
  if (queued >= 40) return Promise.reject(new Error('Busy'));
  queued++;
  const result = chain.then(work);
  chain = result.catch(() => {}).finally(() => { queued--; });
  return result;
}
function website(url) {
  try { const u = new URL(url); return u.origin === PAIR_ORIGIN && u.pathname === '/'; } catch { return false; }
}
function auth(data) {
  return data && typeof data.SteamId === 'string' && /^\d{17}$/.test(data.SteamId) &&
    typeof data.Token === 'string' && ${companionTokenPattern}.test(data.Token);
}
async function finish(tabId) {
  const key = prefix + tabId;
  const stored = (await chrome.storage.session.get(key))[key];
  if (!stored?.delivered) return { ok: false };
  await chrome.storage.session.remove(key);
  await chrome.tabs.remove(tabId).catch(() => {});
  return { ok: true };
}
async function failed(tabId, reason) {
  const stored = (await chrome.storage.session.get(prefix + tabId))[prefix + tabId];
  if (!stored || stored.delivered || stored.expires <= Date.now()) return { ok: false };
  const target = await chrome.tabs.get(stored.siteTab);
  if (!website(target.url)) return { ok: false };
  const code = Object.hasOwn(errors, reason) ? reason : 'DELIVERY_FAILED';
  await chrome.tabs.sendMessage(stored.siteTab, { type: 'error', code }, { documentId: stored.documentId });
  return { ok: false };
}
async function deliver(tabId, data, redirect) {
  if (!auth(data)) return { ok: false, code: 'AUTH_TOKEN_FORMAT' };
  const key = prefix + tabId;
  const stored = (await chrome.storage.session.get(key))[key];
  if (!stored) return { ok: false, code: 'NO_SESSION' };
  if (stored.expires <= Date.now()) {
    await chrome.storage.session.remove(key); return { ok: false, code: 'SESSION_EXPIRED' };
  }
  if (stored.delivered) return { ok: false };
  if (redirect && redirect !== stored.callback) return { ok: false, code: 'CALLBACK_MISMATCH' };
  let target;
  try { target = await chrome.tabs.get(stored.siteTab); }
  catch { return { ok: false, code: 'WEBSITE_CLOSED' }; }
  if (!website(target.url)) return { ok: false, code: 'WEBSITE_NAVIGATED' };
  const address = new URL(stored.callback);
  address.searchParams.set('steamId', data.SteamId);
  address.searchParams.set('token', data.Token);
  let result;
  try { result = await chrome.tabs.sendMessage(stored.siteTab, { type: 'result', address: address.href }, { documentId: stored.documentId }); }
  catch { return { ok: false, code: 'WEBSITE_RECEIVER' }; }
  if (!result?.ok) return { ok: false, code: 'WEBSITE_REJECTED' };
  // Retain only metadata until the content script receives our acknowledgement.
  // Closing its tab here would close the runtime message port before responding.
  await chrome.storage.session.set({ [key]: { ...stored, delivered: true } });
  await chrome.tabs.update(stored.siteTab, { active: true }).catch(() => {});
  return { ok: true };
}
async function receive(message, sender) {
  if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) return { ok: false };
  if (message?.type === 'start') {
    if (!website(sender.url) || !sender.documentId || typeof message.loginUrl !== 'string' || message.loginUrl.length > 1000) return { ok: false };
    const login = new URL(message.loginUrl);
    if (login.origin !== FP || login.pathname !== '/login' || login.username || login.password || login.hash ||
      [...login.searchParams.keys()].length !== 1 || login.searchParams.getAll('returnUrl').length !== 1) return { ok: false };
    const callback = new URL(login.searchParams.get('returnUrl'));
    if (callback.protocol !== 'http:' || callback.hostname !== 'localhost' || callback.username || callback.password || callback.search || callback.hash ||
      Number(callback.port) < 49152 || Number(callback.port) > 65535 || !/^\/callback\/[a-f0-9]{32}$/.test(callback.pathname)) return { ok: false };
    const entries = Object.entries(await chrome.storage.session.get(null)).filter(([key]) => key.startsWith(prefix));
    for (const [key, value] of entries) {
      if (value.expires <= Date.now() || value.siteTab === sender.tab.id) {
        await chrome.storage.session.remove(key);
        await chrome.tabs.remove(Number(key.slice(prefix.length))).catch(() => {});
      }
    }
    const current = Object.keys(await chrome.storage.session.get(null)).filter((key) => key.startsWith(prefix));
    if (current.length >= 20) return { ok: false };
    // Associate the tab before it can load a page that returns credentials.
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    const key = prefix + tab.id;
    await chrome.storage.session.set({ [key]: { siteTab: sender.tab.id, documentId: sender.documentId, callback: callback.href, expires: Date.now() + 900000 } });
    login.hash = 'rust-base-bridge=' + callback.pathname.split('/').pop();
    try { await chrome.tabs.update(tab.id, { url: login.href, active: true }); }
    catch { await chrome.storage.session.remove(key); await chrome.tabs.remove(tab.id).catch(() => {}); return { ok: false }; }
    return { ok: true };
  }
  if (new URL(sender.url).origin === FP) {
    if (message?.type === 'finish') return finish(sender.tab.id);
    if (message?.type === 'failed') return failed(sender.tab.id, message.code);
    if (message?.type === 'native') return deliver(sender.tab.id, message);
  }
  return { ok: false };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  void serialize(() => receive(message, sender)).then(respond).catch(() => respond({ ok: false, code: 'WORKER_ERROR' }));
  return true;
});
// Also handle an actual loopback HTTP redirect, if Facepunch provides one.
chrome.webRequest.onHeadersReceived.addListener((details) => {
  if (details.type !== 'main_frame' || details.statusCode < 300 || details.statusCode >= 400) return;
  const location = details.responseHeaders?.find((h) => h.name.toLowerCase() === 'location')?.value;
  if (!location || location.length > 12000) return;
  try {
    const u = new URL(location);
    if (u.searchParams.getAll('steamId').length !== 1 || u.searchParams.getAll('token').length !== 1) return;
    const data = { SteamId: u.searchParams.get('steamId'), Token: u.searchParams.get('token') };
    const redirect = u.origin + u.pathname;
    void serialize(async () => {
      const result = await deliver(details.tabId, data, redirect);
      if (result.ok) await finish(details.tabId);
    }).catch(() => {});
  } catch { /* No auth data is logged. */ }
}, { urls: [FP + '/*'], types: ['main_frame'] }, ['responseHeaders']);
chrome.tabs.onRemoved.addListener((tabId) => {
  void serialize(async () => {
    const entries = Object.entries(await chrome.storage.session.get(null));
    for (const [key, value] of entries)
      if (key.startsWith(prefix) && (key === prefix + tabId || value.siteTab === tabId)) await chrome.storage.session.remove(key);
  }).catch(() => {});
});
`;

export function extensionFiles(origin: string): Record<string, string> {
  const url = new URL(origin);
  if (url.origin !== origin || (url.protocol !== 'https:' && url.hostname !== '127.0.0.1'))
    throw new Error('Invalid extension origin');
  const companion = 'https://companion-rust.facepunch.com/*';
  // Chrome match patterns cover all ports; the worker still checks the exact origin.
  const website = `${url.protocol}//${url.hostname}/*`;
  return {
    'manifest.json': JSON.stringify(
      {
        manifest_version: 3,
        name: 'Rust Base Website Pairing',
        version: '1.0.2',
        minimum_chrome_version: '111',
        description:
          'Returns your requested Rust+ login to your own Discord bot’s pairing website.',
        permissions: ['storage', 'webRequest'],
        host_permissions: [companion, website],
        background: { service_worker: 'background.js' },
        content_scripts: [
          { matches: [companion], js: ['native.js'], run_at: 'document_start', world: 'MAIN' },
          { matches: [companion], js: ['native-relay.js'], run_at: 'document_start' },
          { matches: [website], js: ['website.js'], run_at: 'document_start' },
        ],
      },
      null,
      2,
    ),
    'background.js': `const PAIR_ORIGIN = ${JSON.stringify(origin)};\n${background}`,
    'native.js': nativeBridge,
    'native-relay.js': nativeRelay,
    'website.js': websiteRelay,
    'INSTALL.txt': `Rust Base Website Pairing\n\nFor ${origin} only.\n\n1. Extract this ZIP to a permanent folder.\n2. Open chrome://extensions (Edge: edge://extensions).\n3. Enable Developer mode, click Load unpacked, choose the folder containing manifest.json.\n4. Refresh your pairing website, then start Steam sign-in there.\n5. Read the official Facepunch warning and approve it yourself.\n6. Return to the website and click Create Discord command.\n\nNo desktop app, Node.js or terminal is required. This extension is not store-published.\nKeep the extracted folder while installed. You may disable/remove it after importing into Discord; the VPS continues listening.\n\nPrivacy: only the configured website and companion-rust.facepunch.com are accessed.\nSteam passwords, Steam Guard codes and cookies are never read.\nRust+ tokens travel only through transient messages to the original website tab, never extension storage or logs.\nTemporary login-tab metadata expires after 15 minutes and is cleared when the browser closes.\nNo UI warnings are hidden or clicked, no browser security settings are disabled.\n\nUpdates: download a new ZIP, replace the files in this folder, click Reload in chrome://extensions, and refresh the website.\nA different website hostname requires its own generated extension.\n`,
  };
}

// Small, uncompressed ZIP for fixed source files; no runtime archive dependency.
export function extensionZip(origin: string): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(extensionFiles(origin))) {
    const filename = Buffer.from(name),
      data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); // 1980-01-01, reproducible archive.
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
