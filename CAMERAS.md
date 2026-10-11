# Rust+ camera viewer

Use Discord to select a server and camera; viewing and manual movement run on the **existing HTTPS pairing website**. No new domain, DNS record, public port or extension update is required. Keep `PAIRING_WEB_URL` and the Compose web override enabled. The existing Nginx `location /` must proxy all paths, including `/camera`, `/camera.js`, `/camera.css` and `/camera/api/`. If your proxy restricts paths, allow these routes and set the upstream read timeout to at least 60 seconds. Do not log request bodies or cookies.

## First camera

1. In Rust, assign an identifier to your deployed CCTV/PTZ camera, drone or supported turret. Verify access using the official Rust+ app first. This is the camera's identifier, **not a Smart Device entity ID**. Keep its capitalization exactly as configured. Rust controls power, range, permissions and camera availability.
2. An administrator runs `/camera add id:BASE_ROOF name:Roof`, choosing the server by name when prompted. Up to 25 camera registrations per server persist in SQLite.
3. Run `/camera watch` or `/camera list`, choose a camera, and open the private website link within **two minutes**. `/camera watch id:BASE_ROOF` also works.
4. The viewer shows the low-resolution ray-rendered Rust+ feed. Look/flight buttons appear according to the server's capabilities. Each click sends one short movement pulse followed by neutral input at the normal Rust+ request pace. Wait for acknowledgement before pressing again; input has latency. Static cameras expose no movement controls. No firing, reload, automated tracking or autopilot is provided.
5. Use **Stop viewing**, close/hide the tab, or `/camera stop` to end the session. Administrators can stop any viewer on the selected server. `/camera remove id:BASE_ROOF` removes a registration and closes that server's current viewer.

The library's renderer does not add the official app's separate entity/player-name overlays. This is a Rust+ ray image, not full-quality game capture or a Discord video stream. Actual optics, input directions, range and drone behavior need an in-game smoke test.

## Lending an offline account

Your own personal server pairing is preferred when fresh team information reports you **offline and alive**. If you are online, the bot may use an eligible paired teammate **only after that person enables `/camera share enabled:true` for this server**. Sharing is off by default and permits allowed operators to view and manually move registered cameras through the owner's Rust account.

Both viewer and owner must retain Discord operator access. The monitoring account and personal account must return matching Rust team membership; unknown presence is rejected. The game server still decides whether the selected account can access the camera. A failed camera subscription does not silently try another account or switch identities mid-session.

Revoke with `/camera share enabled:false` (works even after losing operator roles) or `/pair unlink`. `/camera stop` also closes viewers borrowing your account. Unlinking clears sharing consent across servers. Sharing grants no right to change another person's credentials or enable their consent.

## Limits and recovery

- One dedicated camera socket per server; four viewers across the bot. Monitoring plus three additional personal chat sockets plus a camera fits the upstream default of five connections per source IP/server, assuming no other automation or duplicate endpoint aliases. Stricter servers may reject a camera connection.
- Ten-minute sessions; 30-second idle/no-frame timeout. Hiding the browser tab closes the viewer. Different servers can be viewed in separate visible browser windows with independent cookie paths.
- Offline/team status and Discord roles are checked approximately every ten seconds. Stale verification blocks movement and expires viewing. Going online, dying, unlinking, revoking consent, pausing/restarting monitoring or losing connectivity closes the session. Open a fresh Discord link after recovery.
- Old frames are hidden rather than presented as live. Rendering runs in workers with bounded image size, ray history, memory and execution time.
- Movement is serialized; concurrent presses are rejected. State-changing requests are never automatically retried. Closing attempts neutral input and unsubscription for up to two seconds, then terminates the socket. Physical drone response to connection loss must be verified in-game.
- Camera failures do not block alarm monitoring or the main connection's recovery.

The private, single-use URL fragment is exchanged for an HttpOnly, Secure, SameSite cookie scoped to that viewer. It is removed from browser history on load; API URLs contain no authentication secret. Rust tokens remain on the VPS. Keep private links private. Real server policy still applies: [Facepunch restricts cameras to disconnected accounts, blocks monument CCTV and disallows extensive camera/drone automation](https://rust.facepunch.com/news/r-u-s-t). Implementation uses the [installed library's camera renderer and verified input flags](https://github.com/liamcottle/rustplus.js/blob/master/camera.js) with the installed `rustplus.proto` request/response schema.

## VPS update

Transfer these changes to your Git remote first, then on the VPS:

```bash
cd ~/rust_bot
git pull
sudo docker compose -f docker-compose.yml -f docker-compose.web.yml up -d --build
sudo docker compose -f docker-compose.yml -f docker-compose.web.yml logs --tail=80 rust-bot
```

New slash commands are registered at startup. No new environment variables, package dependencies or database migration are needed. Existing smart devices, panels, alert channels and chat settings remain intact.

Automated tests cover mocked sessions, HTTP protections, Discord permission checks, real installed-protocol loopback messages and synthetic PNG rendering. They do **not** verify live camera access, physical movement or public-server compatibility. Complete the camera section in [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) before relying on it.
