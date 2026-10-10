# Live deployment checklist

Automated mocks and the local protocol test cover application behavior. Every unchecked item below requires your Discord guild, Rust server, VPS or Docker Engine; none was verified with real credentials during this review. Use harmless test circuits first.

- [ ] Back up the stopped SQLite volume before updating. Keep `.env` and desktop pairing files private; run one instance per database/player.
- [ ] Run `docker compose config --no-env-resolution --quiet`, `docker compose build --pull`, then `docker compose up -d` on the x86-64 Ubuntu VPS. Confirm the non-root process can create/write `/app/data/bot.sqlite` and logs contain no secrets.
- [ ] Verify Discord authentication, guild slash commands, Message Content Intent and panel/chat/alert channel permissions. Configure the existing alert channel with `/settings alerts`; run `/alarm test` and verify its simulated label and intended role ping.
- [ ] Complete desktop `fcm-register` / `fcm-listen` and in-game server pairing. Use the notification's app port, Steam64 ID and player token. `/status` must show connected, a last-success time and operational monitoring.
- [ ] Pair a real Smart Switch in-game, register its entity ID/type/name, then create `/panel`. Confirm the initial ON/OFF matches the switch in-game.
- [ ] Test ON, OFF, Refresh and rapid repeated clicks. Verify actual switch state, no false success on failed reads, and independent operation of a second switch. Door position must not be inferred from switch power.
- [ ] Register a harmless switch as sensitive; confirm it cannot change without the user-bound confirmation. Test another user's confirmation attempt and an expired confirmation.
- [ ] Test an ordinary member without an allowed role: buttons, direct/stale components and Discord-to-Rust relay must not operate. Remove an operator role and verify access is revoked; administrative commands stay restricted.
- [ ] Pair/register a powered Smart Alarm wired to a sensor. Establish an inactive baseline, activate it and verify exactly one normal raid alert. Verify continued activity and rapid toggling respect deduplication/cooldown. Disable it and verify silence.
- [ ] Leave an enabled alarm active across a reconnect/restart: expect the distinct **Alarm Active After Reconnection** warning, no fabricated raid alert and no recovery-warning role ping. Reconnect again while active: no duplicate warning. Observe inactive, then test normal activation and a later monitoring-gap warning.
- [ ] Configure `/chat setup`. Verify original Rust player names/text in Discord and `[Discord] DisplayName:` in Rust, both without echoes. Check mentions, Unicode, long text, bots/webhooks, attachments-only messages and changing team membership.
- [ ] Interrupt Rust connectivity briefly (<60s): no connection notice. Interrupt it for >60s: one loss notice; controls become unavailable and Discord chat sends receive failure feedback. Restore it: one recovery notice with downtime after subscriptions initialize; panel refreshes and chat resumes without replaying history.
- [ ] Make one registered device inaccessible: `/status` and any outage recovery must show degraded monitoring. Repair/pair it and confirm a subsequent maintenance cycle restores its state.
- [ ] Restart the Rust server and test switches, alarms and both chat directions afterwards. Test temporary proxy/internet loss. If credentials are revoked, verify `invalid-credentials`, paused retries, and recovery after re-pairing/update/recreation.
- [ ] Interrupt Discord connectivity: confirm its gateway reconnects, pending alert/connection notices eventually deliver in the correct order and no new event-listener duplicates appear.
- [ ] `docker compose restart`, then `docker compose up -d --force-recreate`: registrations, roles, cooldowns, outboxes and panel message persist. No historical chat or ordinary baseline raid alerts appear.
- [ ] Reboot the VPS with Docker enabled at boot; verify `unless-stopped` recovery. Confirm an intentional `docker compose stop` remains stopped. Never use `down -v` to test persistence.

Notifications use an at-least-once persistent outbox. A crash after Discord accepts a message but before SQLite acknowledges it can duplicate that message. Alarm changes wholly within an offline interval cannot be reconstructed; an active recovery warning only reports the observed baseline.
