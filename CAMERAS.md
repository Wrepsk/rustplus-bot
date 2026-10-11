# Rust+ camera viewer

Use Discord to select a server and camera; viewing and manual movement run on the **existing HTTPS pairing website**. No new domain, DNS record, public port or extension update is required. Keep `PAIRING_WEB_URL` and the Compose web override enabled. The existing Nginx `location /` must proxy all paths, including `/camera`, `/camera.js`, `/camera.css` and `/camera/api/`. If your proxy restricts paths, allow these routes and set the upstream read timeout to at least 60 seconds. Do not log request bodies or cookies.

## First camera

1. In Rust, assign an identifier to your deployed CCTV/PTZ camera, drone or supported turret. Verify access using the official Rust+ app first. This is the camera's identifier, **not a Smart Device entity ID**. Keep its capitalization exactly as configured. Rust controls power, range, permissions and camera availability.
2. An administrator runs `/camera add id:BASE_ROOF name:Roof`, choosing the server by name when prompted. Up to 25 camera registrations per server persist in SQLite.
3. Run `/camera watch` or `/camera list`, choose a camera, and open the private website link within **two minutes**. `/camera watch id:BASE_ROOF` also works.
4. The viewer shows the low-resolution ray-rendered Rust+ feed. **Hold WASD** to fly a drone; for cameras/turrets with mouse control, WASD pans the view. **Arrow keys** look, **Space** ascends and **Shift** descends on drones. **Escape**, releasing keys or losing window focus releases movement. Look/flight buttons remain available for short nudges. Only controls advertised by Rust+ are enabled. Static cameras expose no movement controls. No firing, reload, automated tracking or autopilot is provided.
5. Use **Stop viewing**, close/hide the tab, or `/camera stop` to end the session. Administrators can stop any viewer on the selected server. `/camera remove id:BASE_ROOF` removes a registration and closes that server's current viewer.

The viewer does not add the official app's separate entity/player-name overlays. This is a Rust+ ray image, not full-quality game capture or a Discord video stream. Actual optics, input directions, range and drone behavior need an in-game smoke test. W/Up pans upward and S/Down pans downward; drone forward/backward keep the protocol's normal movement buttons.

Drone ascent uses Sprint (128), and descent uses Duck (64), gated by the SprintAndDuck capability. The previous Jump input (32) was incorrect for ascent. These mappings follow the [camera API author's live-tested control notes](https://github.com/HandyS11/RustPlusApi/blob/develop/docs/articles/cameras.md); deployment still requires testing on your own server.

## Lending an offline account

Your own personal server pairing is preferred when fresh team information reports you **offline and alive**. If you are online, the bot may use an eligible paired teammate **only after that person enables `/camera share enabled:true` for this server**. Sharing is off by default and permits allowed operators to view and manually move registered cameras through the owner's Rust account.

Both viewer and owner must retain Discord operator access. The monitoring account and personal account must return matching Rust team membership; unknown presence is rejected. The game server still decides whether the selected account can access the camera. A failed camera subscription does not silently try another account or switch identities mid-session.

Revoke with `/camera share enabled:false` (works even after losing operator roles) or `/pair unlink`. `/camera stop` also closes viewers borrowing your account. Unlinking clears sharing consent across servers. Sharing grants no right to change another person's credentials or enable their consent.

## Limits and recovery

- One dedicated camera socket per server; four viewers across the bot. Monitoring plus three additional personal chat sockets plus a camera fits the upstream default of five connections per source IP/server, assuming no other automation or duplicate endpoint aliases. Stricter servers may reject a camera connection.
- Ten-minute sessions; 30-second idle/no-frame timeout. Hiding the browser tab closes the viewer. Different servers can be viewed in separate visible browser windows with independent cookie paths.
- Offline/team status and Discord roles are checked approximately every ten seconds. Stale verification blocks movement and expires viewing. Going online, dying, unlinking, revoking consent, pausing/restarting monitoring or losing connectivity closes the session. Open a fresh Discord link after recovery.
- Frames stream to the browser as they render instead of waiting for sequential HTTP polling. Stationary views retain the latest sample for each pixel instead of discarding image coverage after ten packets. Small unsampled gaps use nearby observed colours; actual sampled black pixels are preserved. While moving, only the last 300ms of samples are reconstructed on a half-resolution grid to improve coverage without smearing together old viewpoints. Starting/stopping motion clears the old sample cache; stationary native detail rebuilds from new packets. Browser scaling uses smoothing. This trades detail for readability while moving, not for full-resolution video. Rendering is capped at ten updates per second and coalesces pending work instead of building a delay queue. Actual FPS depends on Rust's ray feed, image size and VPS performance; this is not a promised ten FPS. Old frames are hidden rather than presented as live. Rendering runs in workers with bounded image size, pending ray data, per-pixel cache, memory and execution time. With this installed protocol, motion detection follows this viewer's dispatched controls; movement from other clients or changing objects still updates as new rays arrive.
- The viewer displays **Rust ray packets/s**, **Render FPS**, **Display FPS**, and ray/frame ages over a five-second window. Sparse incoming packets or increasing ray age point to the game/feed connection; frequent rays but slow renders point to rendering/VPS load; healthy renders but slow display point to browser/network/proxy delivery. Check these readings when reporting lag. Camera subscriptions renew independently of role checks so a slow Discord request cannot delay renewal.
- Keyboard updates replace the latest held state, with sequence numbers rejecting delayed requests. Inputs are serialized and dispatched no faster than twice per second, leaving room for verification/subscription requests under Rust+'s default player rate limit. Holding keys sends manual input updates, not automatic retries of uncertain requests. The browser refreshes a one-second input lease; missing heartbeats release keys at the next input dispatch. Unacknowledged keyboard input closes the socket after approximately two seconds. Pulse buttons cannot overlap held input. Closing attempts neutral input and unsubscription for up to two seconds, then terminates the socket. Physical drone response, movement cadence and connection loss must be verified in-game.
- Camera failures do not block alarm monitoring or the main connection's recovery.

The private, single-use URL fragment is exchanged for an HttpOnly, Secure, SameSite cookie scoped to that viewer. It is removed from browser history on load; API URLs contain no authentication secret. Rust tokens remain on the VPS. Keep private links private. Real server policy still applies: [Facepunch restricts cameras to disconnected accounts, blocks monument CCTV and disallows extensive camera/drone automation](https://rust.facepunch.com/news/r-u-s-t). The bounded worker codec adapts the [installed library's ray decoding, palette, seeded shuffle and input flags](https://github.com/liamcottle/rustplus.js/blob/master/camera.js), validated against a [public reference camera capture and expected image](https://github.com/HandyS11/RustPlusApi/tree/develop/tests/RustPlusApi.Camera.UnitTests/Fixtures). The Rust+ library, transport and installed protocol schema are unchanged. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The stream sends `X-Accel-Buffering: no` for Nginx. Most existing reverse-proxy configurations need no change. If yours overrides/ignores this response header or buffers streams elsewhere, set `proxy_buffering off;` in the existing location that proxies `/camera/api/`, then validate and reload Nginx. Keep its upstream read timeout at least 60 seconds. Do not add a separate location that omits your existing proxy settings. Stream delivery remains authenticated by the viewer cookie; no Rust tokens are sent to the browser. Slow consumers drop intermediate frames and disconnect rather than accumulating an unbounded queue.

## VPS update

Transfer these changes to your Git remote first, then on the VPS:

```bash
cd ~/rust_bot
git pull
sudo docker compose -f docker-compose.yml -f docker-compose.web.yml up -d --build
sudo docker compose -f docker-compose.yml -f docker-compose.web.yml logs --tail=80 rust-bot
```

New slash commands are registered at startup. No new environment variables, package dependencies or database migration are needed. Existing smart devices, panels, alert channels and chat settings remain intact.

Automated tests cover mocked sessions, held-key sequencing/expiry/timeouts, browser key handling, HTTP stream protections/cleanup, Discord permission checks, real installed-protocol loopback messages and synthetic PNG rendering. They do **not** verify live camera access, real FPS, physical movement or public-server compatibility. Complete the camera section in [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) before relying on it.
