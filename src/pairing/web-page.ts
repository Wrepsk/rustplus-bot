export const page = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link Rust+ · Rust Base</title><meta name="description" content="Link your Rust+ account to your friends’ Discord bot.">
<link rel="stylesheet" href="/pair.css"><script src="/pair.js" defer></script></head>
<body><main><header><a class="brand" href="/" aria-label="Rust Base pairing home"><span class="mark">R+</span> RUST BASE <span class="tag">ACCOUNT LINK</span></a></header>
<div class="layout"><aside><p class="eyebrow">YOUR ACCOUNT. YOUR TEAM.</p><h1>From Discord.<br>Into Rust.</h1>
<p class="intro">Link once, then pair servers and devices from the game. Your bot handles the rest.</p>
<ol class="steps"><li id="step-1" class="current"><span>01</span><div>Open your Discord link<small>Your private, temporary pairing code</small></div></li>
<li id="step-2"><span>02</span><div>Sign in through Steam<small>On the official Facepunch login page</small></div></li>
<li id="step-3"><span>03</span><div>Bring back the login address<small>One copy and paste, no installation</small></div></li>
<li id="step-4"><span>04</span><div>Finish in Discord<small>Paste your encrypted linking command</small></div></li></ol>
<p class="privacy">No Steam password is entered here.<br>No app or browser extension required.</p></aside>
<section class="card" aria-label="Account linking"><div class="card-head"><span class="dot"></span> PRIVATE PAIRING SESSION <span class="badge">15 MIN</span></div>
<section id="begin"><h2>Let’s link your account</h2><p>Use the link from <code>/pair start</code> in Discord. If you opened this page directly, paste the pairing code below.</p>
<label for="code">Discord pairing code</label><input id="code" autocomplete="off" spellcheck="false" placeholder="Paste your pairing code">
<button id="prepare">Continue to Steam sign-in <span aria-hidden="true">→</span></button></section>
<section id="login" hidden><h2>Sign in on Facepunch</h2><p>Open the official Rust companion login page below. Read its warning, continue to Steam, and finish signing in there.</p>
<div class="notice"><strong>A “can’t connect” page is expected afterward.</strong><p>The login result returns to a <code>localhost</code> address. Nothing needs to run on your PC. Copy the <strong>entire address bar</strong> from that page and paste it below.</p></div>
<a id="steam" class="button" target="_blank" rel="noopener noreferrer">Open Steam sign-in <span aria-hidden="true">↗</span></a>
<details><summary>Sent to the official Rust+ app page instead?</summary><p>That page is not a successful pairing result. Facepunch did not return a token to this login attempt. Reopen the exact sign-in link once; do not use the official app download link.</p>
<label for="login-link">This attempt’s sign-in link</label><input id="login-link" readonly spellcheck="false"><button id="copy-login" class="secondary">Copy sign-in link</button>
<p>If it still redirects there, browser pairing is unavailable for this attempt. Use the Windows desktop helper from <code>/pair start</code>, or ask the bot owner for its ZIP. Extract it, open <strong>RustPlus Pairing.cmd</strong>, and paste the code below. The helper uses a separate login method. No DNS or Nginx changes are needed.</p>
<label for="helper-code">Discord code for the desktop helper</label><input id="helper-code" readonly spellcheck="false"><button id="copy-helper" class="secondary">Copy helper code</button>
<p>The same 15-minute expiry applies. If expired, run <code>/pair start</code> again. Never paste Steam passwords or a raw login address into Discord.</p></details>
<label for="address">Address after Steam sign-in</label><textarea id="address" rows="3" autocomplete="off" spellcheck="false" placeholder="http://localhost:…/callback/…?steamId=…&amp;token=…"></textarea>
<p class="hint">This address contains a private Rust+ token. Paste it only here, never into Discord or a message.</p>
<button id="finish">Create Discord command <span aria-hidden="true">→</span></button></section>
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
let csrf = '';
const params = new URLSearchParams(location.hash.slice(1));
$('code').value = params.get('code') || '';
history.replaceState(null, '', location.pathname);
const status = (message, error = false) => { $('status').textContent = message; $('status').className = error ? 'error' : ''; };
const step = (number) => { for (let i = 1; i <= 4; i++) $('step-' + i).classList.toggle('current', i === number); };
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
    csrf = data.csrf; $('steam').href = data.loginUrl;
    $('login-link').value = data.loginUrl; $('helper-code').value = $('code').value.trim();
    $('begin').hidden = true; $('login').hidden = false; $('done').hidden = true;
    $('restart').hidden = true; status(''); step(2);
  } catch (error) { status(error instanceof Error ? error.message : 'Connection failed.', true); }
  finally { $('prepare').disabled = false; }
});
$('steam').addEventListener('click', () => step(3));
for (const [button, field, message] of [
  ['copy-login', 'login-link', 'Sign-in link copied. Open it in a new Chrome tab and complete Facepunch’s warning yourself.'],
  ['copy-helper', 'helper-code', 'Code copied. Paste it into the desktop pairing helper.'],
]) $(button).addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($(field).value); status(message); }
  catch { $(field).focus(); $(field).select(); status('Copy the selected text manually.'); }
});
$('finish').addEventListener('click', async () => {
  $('finish').disabled = true; $('restart').hidden = true; status('Registering Rust+ pairing. This can take up to a minute…');
  const address = $('address').value.trim(); $('address').value = '';
  try {
    const data = await post('/api/complete', { address, csrf });
    $('command').value = data.command; $('login').hidden = true; $('done').hidden = false;
    status('Keep this command private and use it before your Discord code expires.'); step(4);
  } catch (error) { status(error instanceof Error ? error.message : 'Connection failed.', true); $('restart').hidden = false; }
  finally { $('finish').disabled = false; }
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('command').value); $('copy').textContent = 'Copied — paste in Discord'; }
  catch { $('command').focus(); $('command').select(); status('Copy the selected command, then paste it into Discord.'); }
});
$('restart').addEventListener('click', () => {
  $('login').hidden = true; $('begin').hidden = false; $('restart').hidden = true; status(''); step(1);
});
`;
