export const cameraPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rust Base · Cameras</title><link rel="stylesheet" href="/camera.css"></head><body><main><header><span>RUST BASE</span><h1>Camera viewer</h1><p id="identity">Opening your private Discord link…</p></header><p id="status" role="status">Connecting. Keep this tab open.</p><p id="metrics" role="status">Waiting for stream metrics…</p><div class="screen"><img id="feed" alt="Waiting for a Rust+ camera frame"></div><section id="controls" hidden><h2>Manual movement</h2><p>Hold WASD to move a drone or pan a camera. Arrow keys look; Space ascends and Shift descends on drones. Release keys or press Escape to stop. Movement releases when this window loses focus. Buttons still send short nudges. Rust+ input has latency.</p><div class="pads"><div><h3>Look</h3><div class="pad"><button data-action="look-up">↑</button><button data-action="look-left">←</button><button data-action="look-right">→</button><button data-action="look-down">↓</button></div></div><div><h3>Drone</h3><div class="pad"><button data-action="forward">Forward</button><button data-action="left">Left</button><button data-action="right">Right</button><button data-action="back">Back</button><button data-action="up">Ascend</button><button data-action="down">Descend</button></div></div></div></section><footer><button id="stop">Stop viewing</button><p>Low-resolution Rust+ feed. Static cameras have no movement controls. Turret firing is unavailable. Close this viewer before logging into Rust.</p><p id="error" role="alert"></p></footer></main><script src="/camera.js"></script></body></html>`;
export const cameraStyles = `:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#10141b;color:#ebedf1}body{margin:0}main{max-width:850px;margin:30px auto;padding:24px;background:#1b2230;border:1px solid #354052;border-radius:16px}header span{color:#e5946c;letter-spacing:3px;font-weight:800}h1{margin:8px 0}p{color:#bac4d4;line-height:1.5}.screen{background:#06090e;min-height:240px;display:grid;place-items:center;border-radius:10px;overflow:hidden}img{width:100%;image-rendering:auto;max-height:65vh;object-fit:contain}img[hidden]{display:none}.pads{display:flex;gap:35px;flex-wrap:wrap}.pad{display:grid;grid-template-columns:repeat(2,minmax(90px,1fr));gap:8px}button{background:#354359;color:#fff;border:1px solid #596b85;border-radius:8px;padding:13px;cursor:pointer;font:inherit;touch-action:manipulation}button:hover{background:#49617d}button:disabled{opacity:.4;cursor:wait}button[hidden]{display:none}#stop{background:#a33b35;margin-top:20px}#error{color:#ffaaa4}#status{font-weight:600}footer{border-top:1px solid #354052;margin-top:24px}`;
export const cameraScript = `(() => {
'use strict';
const $ = id => document.getElementById(id), feed = $('feed'), actions = [...document.querySelectorAll('[data-action]')];
let base, stream, running = true, controlling = false, objectURL, flags = 0, fresh = false;
let sequence = 0, sending = false, dirty = false, decoding = false, nextFrame, lastEvent = Date.now();
const keys = new Set(), shown = [];
const token = new URLSearchParams(location.hash.slice(1)).get('ticket');
history.replaceState(null, '', '/camera');
async function api(path, body, timeout = 45000) {
  const response = await fetch(path, {method: body === undefined ? 'GET' : 'POST', credentials:'same-origin', headers: body === undefined ? {} : {'Content-Type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout)});
  if (!response.ok) { let message = 'Camera request failed.'; try { message = (await response.json()).error || message; } catch {} throw new Error(message); }
  return response;
}
function buttons() {
  for (const button of actions) {
    const action = button.dataset.action, look = action.startsWith('look-');
    button.hidden = look ? !(flags & 2) : !(flags & 1) || (['up', 'down'].includes(action) && !(flags & 4));
    button.disabled = !fresh || controlling || keys.size > 0 || !running;
  }
  $('controls').hidden = !(flags & 3);
}
function fail(error) { if (!running) return; running = false; fresh = false; keys.clear(); nextFrame = undefined; stream?.close(); clearInterval(heartbeat); feed.hidden = true; buttons(); $('status').textContent = 'Session closed'; $('error').textContent = error.message; if (objectURL) URL.revokeObjectURL(objectURL); if (base) void api(base + '/stop', {}, 3000).catch(() => {}); }
function status(status) {
    lastEvent = Date.now();
    $('identity').textContent = status.server + ' · ' + status.camera + (status.shared ? ' · Consenting teammate’s offline account' : ' · Your offline account');
    flags = status.flags; fresh = status.fresh;
    $('status').textContent = fresh ? 'Live Rust+ view' : 'Waiting for fresh camera data…';
    while (shown.length && shown[0] <= Date.now() - 5000) shown.shift();
    const age = value => value === null ? 'waiting' : (value / 1000).toFixed(1) + 's';
    $('metrics').textContent = 'Rust ray packets: ' + status.rayFps.toFixed(1) + '/s · Render: ' + status.renderFps.toFixed(1) + ' FPS · Display: ' + (shown.length / 5).toFixed(1) + ' FPS · Last ray: ' + age(status.rayAge) + ' · Frame age: ' + age(status.frameAge);
    if (!fresh) { feed.hidden = true; if (keys.size) release(); }
    buttons();
}
async function display() {
  if (decoding || !nextFrame || !running) return;
  const frame = nextFrame; nextFrame = undefined; decoding = true;
  let next;
  try {
    if (typeof frame.image !== 'string' || frame.image.length > 2800000) throw new Error('Unsupported camera frame.');
    const bytes = Uint8Array.from(atob(frame.image), char => char.charCodeAt(0));
    next = URL.createObjectURL(new Blob([bytes], {type:'image/png'}));
    const image = new Image(); image.src = next; await image.decode();
    if (!running) { URL.revokeObjectURL(next); return; }
    const previous = objectURL; objectURL = next; feed.src = next; feed.hidden = !fresh;
    if (previous) URL.revokeObjectURL(previous);
    shown.push(Date.now());
  } catch (error) { if (next) URL.revokeObjectURL(next); fail(error); }
  finally { decoding = false; if (nextFrame && running) void display(); }
}
function mapping(code) {
  const planar = {KeyW:'forward', KeyS:'back', KeyA:'left', KeyD:'right'};
  const look = {KeyW:'look-up', KeyS:'look-down', KeyA:'look-left', KeyD:'look-right', ArrowUp:'look-up', ArrowDown:'look-down', ArrowLeft:'look-left', ArrowRight:'look-right'};
  if ((flags & 1) && planar[code]) return planar[code];
  if ((flags & 2) && look[code]) return look[code];
  if ((flags & 5) === 5) { if (code === 'Space') return 'up'; if (code === 'ShiftLeft' || code === 'ShiftRight') return 'down'; }
}
async function sendKeys() {
  dirty = true;
  if (sending || !base || !running) return;
  sending = true;
  try {
    while (dirty && running) {
      dirty = false;
      const held = [...new Set([...keys].map(mapping).filter(Boolean))];
      await api(base + '/input', {actions:held, sequence:++sequence}, 2000);
    }
  } catch (error) { fail(error); }
  finally { sending = false; }
}
function release() { if (!keys.size) return; keys.clear(); buttons(); void sendKeys(); }
addEventListener('keydown', event => {
  if (event.code === 'Escape') { release(); return; }
  if (!running || !fresh || controlling || event.ctrlKey || event.altKey || event.metaKey || event.target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '') || !mapping(event.code)) return;
  event.preventDefault();
  if (keys.has(event.code)) return;
  keys.add(event.code); buttons(); void sendKeys();
});
addEventListener('keyup', event => { if (!keys.delete(event.code)) return; event.preventDefault(); buttons(); void sendKeys(); });
addEventListener('blur', release);
const heartbeat = setInterval(() => {
  if (!running || !base) return;
  if (Date.now() - lastEvent > 6000) { fail(new Error('Camera stream stalled. Open a fresh viewer.')); return; }
  if (keys.size) void sendKeys();
}, 250);
for (const button of actions) button.addEventListener('click', async () => {
  if (controlling || keys.size || sending || !running || !fresh) return;
  controlling = true; buttons(); $('status').textContent = 'Sending movement and release…';
  try { await api(base + '/input', {action: button.dataset.action}); $('status').textContent = 'Movement and release acknowledged by Rust+'; }
  catch (error) { fail(error); }
  finally { controlling = false; buttons(); }
});
$('stop').addEventListener('click', () => fail(new Error('Viewer stopped. Open /camera watch in Discord to start again.')));
addEventListener('pagehide', () => { running = false; keys.clear(); stream?.close(); clearInterval(heartbeat); if (base) void fetch(base + '/stop', {method:'POST', credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}',keepalive:true}).catch(() => {}); if (objectURL) URL.revokeObjectURL(objectURL); });
document.addEventListener('visibilitychange', () => { if (document.hidden && base) fail(new Error('Viewer closed when this tab was hidden. Reopen it from Discord.')); });
if (!token) { fail(new Error('Open a fresh private link from /camera watch in Discord.')); return; }
void (async () => {
  try { const result = await (await api('/camera/api/open', {ticket: token})).json(); base = '/camera/api/' + result.slot; if (document.hidden) { fail(new Error('Keep the viewer tab visible. Open a fresh link from Discord.')); return; } if (!running) { void api(base + '/stop', {}).catch(() => {}); return; }
    lastEvent = Date.now(); stream = new EventSource(base + '/stream');
    stream.addEventListener('status', event => { if (!running) return; try { status(JSON.parse(event.data)); } catch (error) { fail(error); } });
    stream.addEventListener('frame', event => { if (!running) return; try { lastEvent = Date.now(); nextFrame = JSON.parse(event.data); void display(); } catch (error) { fail(error); } });
    stream.onerror = () => fail(new Error('Camera stream disconnected. Open a fresh link from /camera watch.'));
  }
  catch (error) { fail(error); }
})();
})();`;
