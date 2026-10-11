export const cameraPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rust Base · Cameras</title><link rel="stylesheet" href="/camera.css"></head><body><main><header><span>RUST BASE</span><h1>Camera viewer</h1><p id="identity">Opening your private Discord link…</p></header><p id="status" role="status">Connecting. Keep this tab open.</p><div class="screen"><img id="feed" alt="Waiting for a Rust+ camera frame"></div><section id="controls" hidden><h2>Manual movement</h2><p>Each press sends one short movement, then releases. Wait for confirmation before pressing again. Rust+ controls have latency.</p><div class="pads"><div><h3>Look</h3><div class="pad"><button data-action="look-up">↑</button><button data-action="look-left">←</button><button data-action="look-right">→</button><button data-action="look-down">↓</button></div></div><div><h3>Drone</h3><div class="pad"><button data-action="forward">Forward</button><button data-action="left">Left</button><button data-action="right">Right</button><button data-action="back">Back</button><button data-action="up">Ascend</button><button data-action="down">Descend</button></div></div></div></section><footer><button id="stop">Stop viewing</button><p>Low-resolution Rust+ feed. Static cameras have no movement controls. Turret firing is unavailable. Close this viewer before logging into Rust.</p><p id="error" role="alert"></p></footer></main><script src="/camera.js"></script></body></html>`;
export const cameraStyles = `:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#10141b;color:#ebedf1}body{margin:0}main{max-width:850px;margin:30px auto;padding:24px;background:#1b2230;border:1px solid #354052;border-radius:16px}header span{color:#e5946c;letter-spacing:3px;font-weight:800}h1{margin:8px 0}p{color:#bac4d4;line-height:1.5}.screen{background:#06090e;min-height:240px;display:grid;place-items:center;border-radius:10px;overflow:hidden}img{width:100%;image-rendering:pixelated;max-height:65vh;object-fit:contain}img[hidden]{display:none}.pads{display:flex;gap:35px;flex-wrap:wrap}.pad{display:grid;grid-template-columns:repeat(2,minmax(90px,1fr));gap:8px}button{background:#354359;color:#fff;border:1px solid #596b85;border-radius:8px;padding:13px;cursor:pointer;font:inherit;touch-action:manipulation}button:hover{background:#49617d}button:disabled{opacity:.4;cursor:wait}button[hidden]{display:none}#stop{background:#a33b35;margin-top:20px}#error{color:#ffaaa4}#status{font-weight:600}footer{border-top:1px solid #354052;margin-top:24px}`;
export const cameraScript = `(() => {
'use strict';
const $ = id => document.getElementById(id), feed = $('feed'), actions = [...document.querySelectorAll('[data-action]')];
let base, running = true, controlling = false, objectURL, flags = 0, fresh = false;
const token = new URLSearchParams(location.hash.slice(1)).get('ticket');
history.replaceState(null, '', '/camera');
async function api(path, body) {
  const response = await fetch(path, {method: body === undefined ? 'GET' : 'POST', credentials:'same-origin', headers: body === undefined ? {} : {'Content-Type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000)});
  if (!response.ok) { let message = 'Camera request failed.'; try { message = (await response.json()).error || message; } catch {} throw new Error(message); }
  return response;
}
function buttons() {
  for (const button of actions) {
    const action = button.dataset.action, look = action.startsWith('look-');
    button.hidden = look ? !(flags & 2) : !(flags & 1) || (action === 'down' && !(flags & 4));
    button.disabled = !fresh || controlling || !running;
  }
  $('controls').hidden = !(flags & 3);
}
function fail(error) { running = false; fresh = false; feed.hidden = true; buttons(); $('status').textContent = 'Session closed'; $('error').textContent = error.message; if (base) void api(base + '/stop', {}).catch(() => {}); }
async function poll() {
  if (!running) return;
  try {
    const status = await (await api(base + '/status')).json();
    $('identity').textContent = status.server + ' · ' + status.camera + (status.shared ? ' · Consenting teammate’s offline account' : ' · Your offline account');
    flags = status.flags; fresh = status.fresh;
    $('status').textContent = fresh ? 'Live Rust+ view · ' + new Date(status.frameAt).toLocaleTimeString() : 'Waiting for fresh camera data…';
    const response = await api(base + '/frame');
    if (response.status === 204 || !fresh) { feed.hidden = true; } else {
      const next = URL.createObjectURL(await response.blob()), previous = objectURL;
      feed.src = next; feed.hidden = false; objectURL = next;
      if (previous) URL.revokeObjectURL(previous);
    }
    buttons();
    if (running) setTimeout(poll, 1000);
  } catch (error) { fail(error); }
}
for (const button of actions) button.addEventListener('click', async () => {
  if (controlling || !running || !fresh) return;
  controlling = true; buttons(); $('status').textContent = 'Sending movement and release…';
  try { await api(base + '/input', {action: button.dataset.action}); $('status').textContent = 'Movement and release acknowledged by Rust+'; }
  catch (error) { fail(error); }
  finally { controlling = false; buttons(); }
});
$('stop').addEventListener('click', () => fail(new Error('Viewer stopped. Open /camera watch in Discord to start again.')));
addEventListener('pagehide', () => { running = false; if (base) void fetch(base + '/stop', {method:'POST', credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}',keepalive:true}); if (objectURL) URL.revokeObjectURL(objectURL); });
document.addEventListener('visibilitychange', () => { if (document.hidden && base) fail(new Error('Viewer closed when this tab was hidden. Reopen it from Discord.')); });
if (!token) { fail(new Error('Open a fresh private link from /camera watch in Discord.')); return; }
void (async () => {
  try { const result = await (await api('/camera/api/open', {ticket: token})).json(); base = '/camera/api/' + result.slot; if (document.hidden) { fail(new Error('Keep the viewer tab visible. Open a fresh link from Discord.')); return; } if (!running) { void api(base + '/stop', {}).catch(() => {}); return; } await poll(); }
  catch (error) { fail(error); }
})();
})();`;
