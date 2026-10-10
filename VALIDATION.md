# Verification record

Verified locally on 2026-10-10 with Node.js 22.18.0 on Windows.

- The starting directory was empty; no existing application needed preservation.
- Read the rustplus.js README, pairing flow, device broadcast/request examples, source, and protobuf schema; checked the installed 2.5.0 package as well.
- Dependencies installed; a clean `npm ci --ignore-scripts` verified the regenerated dependency lockfile. The bot has no package lifecycle scripts.
- `npm run check`: strict application/test TypeScript checks, ESLint, **42 tests across 6 files**, and production compilation passed.
- Tests use mocks, SQLite, and a local WebSocket server. The protocol test uses the actual installed RustPlus class and protobuf schema with dummy credentials; it does not contact a game server.
- `docker compose config --no-env-resolution --quiet`: passed without needing a real `.env` file.
- Docker image build attempted, but blocked: Docker CLI is installed and its Linux engine is not running (`dockerDesktopLinuxEngine` pipe missing). The image build has not been verified.
- Missing-configuration startup smoke test: process rejected missing required fields, printed only field names/validation reasons, and exited with code 1.
- Final full and production dependency audits: **11 moderate, 0 high, 0 critical** advisories. The unresolved chains come from rustplus.js's bundled legacy pairing CLI and camera image dependencies; details are in the README. Those features are not invoked by this bot at runtime.

Real Discord/Rust credentials were unavailable. Manual verification still required:

1. Complete desktop FCM/Steam pairing and obtain server/device notification fields.
2. Verify the Discord invite, Message Content Intent and channel permissions.
3. Register a real paired switch, confirm panel reads and both state changes, and test an unauthorized user's button interaction.
4. Test sensitive-switch confirmation and repeated clicks; restart the bot and verify it edits the same panel message.
5. Configure alerts, run the simulated test, then activate a powered/wired real alarm. Confirm cooldowns, rearming, and no alert from an already-active reconnect baseline.
6. Send team messages in both directions; verify the Discord name prefix, absence of echoes, and behavior when the connected player's team changes.
7. Restart Rust / interrupt its connection, verify subscriptions restore, then check real chat and alarms again.
8. Start Docker Engine on the VPS and run the documented image build / Compose deployment. Confirm database persistence after recreating the container.
