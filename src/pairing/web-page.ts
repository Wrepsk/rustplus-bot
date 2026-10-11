export const page = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link Rust+ · Rust Base</title><meta name="description" content="Link your Rust+ account to your friends’ Discord bot.">
<link rel="stylesheet" href="/pair.css"><script src="/pair.js" defer></script></head>
<body><main><header><a class="brand" href="/" aria-label="Rust Base pairing home"><span class="mark">R+</span> RUST BASE <span class="tag">ACCOUNT LINK</span></a></header>
<div class="layout"><aside><p class="eyebrow">YOUR ACCOUNT. YOUR TEAM.</p><h1>From Discord.<br>Into Rust.</h1>
<p class="intro">Link once, then pair servers and devices from the game. Your bot handles the rest.</p>
<ol class="steps"><li id="step-1" class="current"><span>01</span><div>Open your Discord link<small>Your private, temporary pairing code</small></div></li>
<li id="step-2"><span>02</span><div>Sign in through Steam<small>On the official Facepunch login page</small></div></li>
<li id="step-3"><span>03</span><div>Return to this website<small>The extension brings back your login</small></div></li>
<li id="step-4"><span>04</span><div>Finish in Discord<small>Paste your encrypted linking command</small></div></li></ol>
<p class="privacy">No Steam password is entered here.<br>No desktop app or terminal required.</p></aside>
<section class="card" aria-label="Account linking"><div class="card-head"><span class="dot"></span> PRIVATE PAIRING SESSION <span class="badge">15 MIN</span></div>
<section id="begin"><h2>Let’s link your account</h2><p>Use the link from <code>/pair start</code> in Discord. If you opened this page directly, paste the pairing code below.</p>
<label for="code">Discord pairing code</label><input id="code" autocomplete="off" spellcheck="false" placeholder="Paste your pairing code">
<button id="prepare">Continue to Steam sign-in <span aria-hidden="true">→</span></button></section>
<section id="login" hidden><h2>Sign in on Facepunch</h2><p>Open the official Rust companion login page below. Read its warning, continue to Steam, and finish signing in there.</p>
<div class="notice"><strong id="extension-status">Checking the pairing extension…</strong><p>Facepunch returns Rust+ access through an app handoff. A small browser extension brings it back here without a desktop app. It accesses only this website and Facepunch’s companion site, never your Steam password or cookies.</p></div>
<details id="extension-install" open><summary>Install once in Chrome or Edge</summary><ol><li><a href="/pairing-extension.zip" download>Download the pairing extension ZIP</a> and extract it to a folder you will keep.</li><li>Open <code>chrome://extensions</code> (Edge: <code>edge://extensions</code>).</li><li>Enable <strong>Developer mode</strong>, click <strong>Load unpacked</strong>, and select the extracted folder containing <code>manifest.json</code>.</li><li>Refresh this website, paste your Discord code again if needed, and continue.</li></ol><p>This extension is self-hosted, not published in the browser store. A refresh after installation is required. You can remove it after importing; your VPS keeps listening.</p></details>
<a id="steam" class="button" target="_blank" rel="noopener noreferrer">Open Steam sign-in <span aria-hidden="true">↗</span></a>
<p id="login-progress" class="hint">Keep this tab open while signing in. Complete the official warning yourself; the extension never approves it for you.</p>
<details><summary>Manual callback or redirect troubleshooting</summary><p>If Facepunch sends you to its official app page, verify the extension is enabled and this page says <strong>Extension connected</strong>. Refresh this page and sign in again from this button. A login opened independently is not linked to this tab.</p><p>If a genuine “can’t connect” localhost callback appears instead, you may paste its complete address below. Never paste that private address into Discord.</p>
<label for="address">Address after Steam sign-in</label><textarea id="address" rows="3" autocomplete="off" spellcheck="false" placeholder="http://localhost:…/callback/…?steamId=…&amp;token=…"></textarea>
<p class="hint">A raw login token is never needed in Discord. No DNS or Nginx changes are needed for this handoff.</p></details>
<button id="finish" disabled>Create Discord command <span aria-hidden="true">→</span></button></section>
<section id="done" hidden><div class="success-mark" aria-hidden="true">✓</div><h2>One last step in Discord</h2><p>Copy this encrypted command and paste it into your Discord server. Only the Discord account that started this session can use it.</p>
<label for="command">Your linking command</label><textarea id="command" rows="4" readonly spellcheck="false"></textarea><button id="copy">Copy Discord command</button>
<div class="next"><strong>Then pair in-game</strong><p>Wait for <code>/pair status</code> to show <strong>listening</strong>. Pair the server or Smart Device in Rust, then open <code>/pair inbox</code> to accept it.</p></div></section>
<p id="status" role="status" aria-live="polite"></p><button id="restart" class="secondary" hidden>Start a new login attempt</button>
<footer>Self-hosted by your Discord bot owner. Rust+ pairing is unofficial and may change with game updates.</footer></section></div>
</main></body></html>`;

export const styles = String.raw`
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#121411;color:#eff0e9;--muted:#a8aea1;--orange:#e5824d;--line:#343a30}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 0 25%,#2b302138,transparent 65%)}main{max-width:1180px;margin:auto;padding:0 48px}header{padding:34px 0;border-bottom:1px solid var(--line)}a{color:inherit}.brand{text-decoration:none;display:flex;align-items:center;gap:12px;font-weight:800;font-size:14px;letter-spacing:.08em}.mark{background:var(--orange);color:#161810;padding:8px;font-size:19px;letter-spacing:-1px}.tag{font-size:10px;font-weight:500;color:var(--muted);margin-left:auto}.layout{display:grid;grid-template-columns:1fr 1fr;gap:75px;padding:70px 0 50px;align-items:start}.eyebrow{font-size:11px;letter-spacing:.16em;color:var(--orange);font-weight:700}h1{font-size:clamp(42px,5vw,64px);line-height:1.05;letter-spacing:-.055em;margin:21px 0}p{font-size:14px;line-height:1.7;color:var(--muted)}.intro{max-width:350px;font-size:16px}.steps{list-style:none;padding:0;margin:35px 0;display:grid;gap:22px}.steps li{display:flex;gap:16px;font-size:14px;font-weight:600;color:var(--muted)}.steps li>span{border:1px solid var(--line);width:34px;height:34px;display:grid;place-items:center;font-size:11px;flex-shrink:0}.steps .current{color:#fff}.steps .current>span{color:var(--orange);border-color:var(--orange)}small{display:block;font-weight:400;font-size:12px;margin-top:5px;color:var(--muted)}.privacy{font-size:12px;border-left:2px solid var(--line);padding-left:15px}.card{border:1px solid #414638;background:#20241c;padding:29px;box-shadow:0 24px 70px #0003}.card-head{display:flex;align-items:center;font-size:9px;letter-spacing:.1em;color:#c3cbb9;gap:9px;padding-bottom:23px;border-bottom:1px solid var(--line)}.dot{width:6px;height:6px;background:#9eb57d;border-radius:50%}.badge{margin-left:auto;font-size:9px;border:1px solid #414638;padding:4px 6px;white-space:nowrap}h2{font-size:25px;letter-spacing:-.035em;line-height:1.2;margin:26px 0 12px}label{display:block;font-size:12px;font-weight:600;margin:23px 0 9px}input,textarea{display:block;width:100%;background:#151911;border:1px solid #454c3c;border-radius:3px;color:#e8eddf;padding:12px;font:12px/1.6 ui-monospace,monospace;resize:vertical}input:focus,textarea:focus{outline:2px solid var(--orange);outline-offset:2px}button,.button{width:100%;display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:20px;padding:14px 16px;border:0;border-radius:3px;background:var(--orange);color:#1c1d15;font-family:inherit;font-size:13px;font-weight:700;line-height:1.4;text-decoration:none;cursor:pointer}button:disabled{opacity:.55;cursor:wait}.button:focus-visible,button:focus-visible{outline:2px solid #fff;outline-offset:3px}code{font:12px ui-monospace,monospace;color:#e5e9df}.notice,.next{border:1px solid #50593f;padding:15px;margin:22px 0 0;background:#2c3324}.notice strong,.next strong{font-size:13px;color:#e4ebd8}.notice p,.next p{font-size:12px;margin:7px 0 0}.hint{font-size:11px;line-height:1.6;margin:10px 0}.secondary{background:transparent;border:1px solid #555e49;color:#dce2d2;text-align:left}#status{font-size:13px;margin:18px 0 0;overflow-wrap:anywhere}#status.error{color:#ffbca6}footer{border-top:1px solid var(--line);font-size:10px;line-height:1.7;color:#9ca58f;margin-top:28px;padding-top:17px}.success-mark{margin-top:25px;width:38px;height:38px;background:#a3b97f;color:#20241c;display:grid;place-items:center;font-weight:800;font-size:22px}[hidden]{display:none!important}@media(max-width:850px){main{padding:0 24px}.layout{gap:35px;padding-top:40px}}@media(max-width:650px){main{padding:0 20px}header{padding:23px 0}.layout{grid-template-columns:1fr;gap:20px;padding-top:30px}h1{font-size:46px}.steps{grid-template-columns:1fr 1fr;gap:18px;margin:25px 0}.steps li{font-size:12px;gap:10px}small{font-size:10px}.privacy{margin-bottom:6px}.card{padding:23px}.intro{max-width:none}.tag{font-size:8px}}
`;

export const script = String.raw`
'use strict';
const $ = (id) => document.getElementById(id);
let csrf = '', loginUrl = '', callback = '', returnedAddress = '', extensionReady = false;
let loginTimer;
const params = new URLSearchParams(location.hash.slice(1));
$('code').value = params.get('code') || '';
try {
  $('code').value ||= sessionStorage.getItem('rust-base-code') || '';
  if ($('code').value) sessionStorage.setItem('rust-base-code', $('code').value);
} catch { /* Pairing also works when browser storage is unavailable. */ }
history.replaceState(null, '', location.pathname);
const status = (message, error = false) => { $('status').textContent = message; $('status').className = error ? 'error' : ''; };
const step = (number) => { for (let i = 1; i <= 4; i++) $('step-' + i).classList.toggle('current', i === number); };
const extensionStatus = () => {
  $('extension-status').textContent = extensionReady ? 'Extension connected' : 'Install the pairing extension, then refresh this page';
  $('extension-install').open = !extensionReady;
};
window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.type === 'RUST_BASE_READY') {
    extensionReady = /^1\.0\.([1-9]\d*)$/.test(event.data.version || ''); extensionStatus();
    if (!extensionReady) status('Update the pairing extension: download the new ZIP, replace its files, click Reload in chrome://extensions, and refresh this page.', true);
  }
  if (event.data?.type === 'RUST_BASE_ERROR') {
    clearTimeout(loginTimer); status('The extension could not return this login. Update or reload the extension, refresh this page, and start a fresh sign-in. Keep the original website tab open throughout.', true);
  }
  if (event.data?.type !== 'RUST_BASE_RESULT' || typeof event.data.address !== 'string' || event.data.address.length > 12000 || !callback) return;
  try {
    const result = new URL(event.data.address);
    if (result.origin + result.pathname !== callback || result.username || result.password || result.hash ||
        result.searchParams.getAll('steamId').length !== 1 || result.searchParams.getAll('token').length !== 1 ||
        !/^\d{17}$/.test(result.searchParams.get('steamId') || '') || !/^[A-Za-z0-9._~-]{20,10000}$/.test(result.searchParams.get('token') || '')) return;
    returnedAddress = result.href; clearTimeout(loginTimer);
    $('finish').disabled = false;
    $('login-progress').textContent = 'Steam sign-in complete. Create your Discord command below.';
    status('Login received. Click Create Discord command to finish.'); step(3);
  } catch { /* Ignore invalid or unrelated messages; never display raw tokens. */ }
});
window.postMessage({ type: 'RUST_BASE_PING' }, location.origin);
setTimeout(extensionStatus, 700);
async function post(path, body) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(75000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Pairing failed. Please try again.');
  return data;
}
$('prepare').addEventListener('click', async () => {
  $('prepare').disabled = true; status('Preparing your private login…');
  try {
    const data = await post('/api/start', { code: $('code').value.trim() });
    try { sessionStorage.setItem('rust-base-code', $('code').value.trim()); } catch { /* No tokens are stored. */ }
    csrf = data.csrf; loginUrl = data.loginUrl; callback = new URL(loginUrl).searchParams.get('returnUrl');
    returnedAddress = ''; $('address').value = ''; $('steam').href = loginUrl; $('finish').disabled = true;
    $('begin').hidden = true; $('login').hidden = false; $('done').hidden = true;
    $('restart').hidden = true; extensionStatus(); status(''); step(2);
  } catch (error) { status(error instanceof Error ? error.message : 'Connection failed.', true); }
  finally { $('prepare').disabled = false; }
});
$('steam').addEventListener('click', (event) => {
  event.preventDefault();
  if (!extensionReady) { extensionStatus(); status('Install or enable the pairing extension and refresh this page first.', true); return; }
  if (!loginUrl) return;
  returnedAddress = ''; clearTimeout(loginTimer);
  $('finish').disabled = true;
  $('login-progress').textContent = 'Waiting for Steam sign-in. Finish the warning on Facepunch’s official page.';
  window.postMessage({ type: 'RUST_BASE_START', loginUrl }, location.origin); step(3);
  loginTimer = setTimeout(() => status('Still waiting for Facepunch. If it redirected to the official app page, reload the extension and refresh this page before trying again. No login has been received.', true), 90000);
});
$('address').addEventListener('input', () => { $('finish').disabled = !returnedAddress && !$('address').value.trim(); });
$('finish').addEventListener('click', async () => {
  $('finish').disabled = true; $('restart').hidden = true; status('Registering Rust+ pairing. This can take up to a minute…');
  const address = returnedAddress || $('address').value.trim(); returnedAddress = ''; $('address').value = '';
  try {
    const data = await post('/api/complete', { address, csrf });
    $('command').value = data.command; $('login').hidden = true; $('done').hidden = false;
    try { sessionStorage.removeItem('rust-base-code'); } catch { /* No tokens are stored. */ }
    status('Keep this command private and use it before your Discord code expires.'); step(4);
  } catch (error) { status(error instanceof Error ? error.message : 'Connection failed.', true); $('restart').hidden = false; }
  finally { $('finish').disabled = !returnedAddress && !$('address').value.trim(); }
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('command').value); $('copy').textContent = 'Copied — paste in Discord'; }
  catch { $('command').focus(); $('command').select(); status('Copy the selected command, then paste it into Discord.'); }
});
$('restart').addEventListener('click', () => {
  returnedAddress = ''; loginUrl = ''; callback = ''; clearTimeout(loginTimer); $('address').value = '';
  $('login').hidden = true; $('begin').hidden = false; $('restart').hidden = true; status(''); step(1);
});
`;
