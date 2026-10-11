# Rust+ Discord Base Bot

A self-hosted, single-server / single-guild bot for your friends: native Discord base controls, real Smart Alarm notifications and two-way Rust team chat. TypeScript, discord.js 14.27.0, rustplus.js 2.5.0 and SQLite. No website, inbound HTTP listener or hosted database.

## Before you start

You need a Discord server where you can invite a bot, a Steam account that can join the Rust server, and a Rust server with Rust+ enabled and reachable. **You do not need server administrator access.** The server operator must already have enabled its companion port; a player cannot enable Rust+ on a server where it is disabled.

Use Node.js 22.13 or newer (Node 22 LTS recommended), or Docker Engine with the Compose plugin on an x86-64 Ubuntu VPS. SQLite uses Node's bundled `node:sqlite`, so no native database compilation is required. Some Node 22 releases print an experimental SQLite warning.

## 1. Create and invite the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), create an application, and create/reset its bot token under **Bot**. Keep the token private.
2. Enable **Message Content Intent** under Bot → Privileged Gateway Intents. The bot requests Guilds, Guild Messages and Message Content. It fetches individual members for role checks; Server Members and Presence privileged intents are not required.
3. Copy the application's **Application ID** to `DISCORD_CLIENT_ID`. Enable Discord **User Settings → Advanced → Developer Mode**; right-click your server and your user to copy `DISCORD_GUILD_ID` and `ADMIN_USER_ID`.
4. Under **OAuth2 → URL Generator**, select `bot` and `applications.commands`. Grant **View Channels**, **Send Messages**, **Embed Links**, and **Read Message History**. Open the generated invite URL and add the bot to your guild. Do not grant Administrator to the bot.
5. Ensure channel permission overrides allow these permissions in the panel, alarm and chat channels. For alert pings, make the chosen alert role mentionable. Alternatively grant **Mention @everyone, @here, and All Roles** only in the alarm channel. The bot explicitly allows mentions of the configured role only.

Commands are registered for the configured guild at startup. All administrative commands enforce authorization in the application; the configured initial administrator can use them even without Discord's Administrator permission. Other server administrators also have administrative access. Operator roles can use switch buttons and relay chat, but cannot modify settings.

## 2. Obtain Rust+ server credentials (public servers supported)

Perform pairing on your desktop with Chrome installed, rather than trying to open a browser on the VPS. See the upstream [pairing instructions](https://github.com/liamcottle/rustplus.js#pairing) and [pairing flow](https://github.com/liamcottle/rustplus.js/blob/master/docs/PairingFlow.md).

```sh
npx @liamcottle/rustplus.js fcm-register
npx @liamcottle/rustplus.js fcm-listen
```

`fcm-register` launches a special Chrome profile and opens the Rust Companion/Steam sign-in flow. Sign in in that browser. This bot never asks for or stores a Steam password or Steam Guard code. The upstream CLI stores push/auth registration material in `rustplus.config.json`; treat that file as a secret. Its temporary browser disables web security for the pairing flow: use it only for pairing and close it afterwards.

While `fcm-listen` runs:

1. Join your existing public Rust server with the same Steam account.
2. Open the in-game Rust+ menu and click **Pair with Server**.
3. Read the server pairing notification in your terminal. Copy **ip**, **port**, **playerId**, **playerToken** into the corresponding environment variables:

| Notification field | Environment variable |
| ------------------ | -------------------- |
| `ip`               | `RUST_SERVER_IP`     |
| `port`             | `RUST_APP_PORT`      |
| `playerId`         | `RUST_STEAM_ID`      |
| `playerToken`      | `RUST_PLAYER_TOKEN`  |

Use the notification's **app port**, not the game or RCON port. The Steam64 ID is a 17-digit string; the player token is a signed 32-bit integer and can be negative. Keep both tokens out of screenshots and logs shared with others. Re-pair if the server revokes your token or changes pairing data. Change `.env` and recreate the container to load updated credentials.

The CLI can use an explicit file if needed:

```sh
npx @liamcottle/rustplus.js --config-file=./private-pairing.json fcm-register
npx @liamcottle/rustplus.js --config-file=./private-pairing.json fcm-listen
```

Keep any custom pairing file outside the project. The running bot does **not** need FCM registration files, Chrome or a continuously running pairing CLI. Only copy the four server fields to your VPS. CLI pairing depends on third-party FCM/Expo/Steam services and may need upstream fixes if those services change.

## 3. Obtain Smart Switch and Smart Alarm entity IDs

Keep `fcm-listen` running, return to the same Rust server, look at your placed **Smart Switch** or **Smart Alarm**, and use its in-game **Pair** interaction (hold the use key to open its interaction menu where necessary). The device notification includes its entity ID, type and server information. Use that ID for `/device add`. You need the normal in-game access required to pair the device; administrator-only debug commands are unnecessary.

Do not substitute an electrical branch/ordinary switch/door ID. A door cannot be controlled directly: wire a **Smart Switch** to the desired circuit. Register devices paired to the same Steam account and server as the bot. After a wipe, destroyed/replaced devices usually need fresh pairing and registration. The bot verifies registered device types when it queries Rust+; an inaccessible or mismatched device is shown as unknown and retried.

## 4. Configure and run locally

Copy `.env.example` to `.env` and fill the required fields. On Linux:

```sh
cp .env.example .env
chmod 600 .env
npm ci
npm run check
npm start
```

On PowerShell use `Copy-Item .env.example .env`. For development use `npm run dev`. The first startup creates the database and registers guild slash commands. Missing/invalid environment fields produce a startup error identifying the fields without printing their values.

`RUST_USE_PROXY=true` connects through Facepunch's secure WebSocket proxy. Use `false` only when you need a direct connection: direct `ws://` is unencrypted. Neither mode requires opening an inbound port on the VPS. Allow outbound HTTPS/WSS and, for direct mode, TCP to the server's app port. Run only one bot instance per SQLite database and avoid competing Rust+ automation under the same player identity.

Optional settings:

| Variable                             | Default / meaning                                                    |
| ------------------------------------ | -------------------------------------------------------------------- |
| `DATABASE_PATH`                      | `./data/bot.sqlite`; overridden to `/app/data/bot.sqlite` in Compose |
| `ALLOWED_ROLE_IDS`                   | Empty: administrators only. Comma-separated initial operator roles   |
| `ALERT_CHANNEL_ID` / `ALERT_ROLE_ID` | Optional initial alert channel and role                              |
| `BASE_NAME`                          | Main Base                                                            |
| `ALARM_COOLDOWN_SECONDS`             | 60; per alarm, persisted across restarts                             |
| `CHAT_POLL_SECONDS`                  | 30; minimum 10                                                       |
| `RUST_CHAT_MAX_LENGTH`               | 128 UTF-16 units; adjustable down to 64 for stricter servers         |
| `LOG_LEVEL`                          | info; structured JSON to stdout                                      |

Settings changed through Discord are saved in SQLite and override the corresponding **initial** environment role/alert defaults. The database is bound to the Rust server and player identity to prevent accidental control of unrelated entities when changing servers. Use a separate database/volume for a different server or Steam account.

## 5. First-time Discord setup

Run these as `ADMIN_USER_ID` or a Discord guild administrator. Entity IDs below are examples: replace them with your actual pairing IDs.

1. `/settings role-add role:@RustFriends` allows friends to operate switches and send team chat. With no allowed roles, only administrators can operate them.
2. `/device add id:123456 name:Garage Door Power type:Smart Switch` registers your first switch. Use `sensitive:true` for any potentially destructive circuit, regardless of its friendly name.
3. `/panel` creates the control panel in the current channel. Run it again to refresh the saved message. Four switches fit on each page, with navigation buttons for additional devices. The saved message and button handlers survive restarts.
4. `/settings alerts channel:#raid-alerts role:@RaidTeam` configures notifications. Omit the role to clear the role ping.
5. `/device add id:654321 name:Outer Wall type:Smart Alarm` registers an alarm. Wire it to your in-game sensors and provide power. Rust+ itself does not detect raids.
6. `/alarm test id:654321` sends an explicitly **simulated** Discord alert. It never changes an in-game device. Then test a real inactive → active sensor transition in-game.
7. Join/create a Rust team using the paired Steam player. `/chat setup channel:#rust-team` configures and enables the dedicated chat channel. Wait for `/chat status` to show **Live**, then test messages in both directions.
8. Check `/status` for connection state, server/player information, registered device count and chat health.

The panel reports actual **Smart Switch ON/OFF**, never inferred door position. Buttons acknowledge privately, show work in progress, disable while busy/disconnected, and read the device after a command. Persistent IDs never bypass role or device-registration checks. Sensitive switches require a short-lived, user-bound confirmation for state changes; names containing terms such as explosives, detonator, rocket or C4 also activate that safeguard. Explicitly mark other hazardous circuits sensitive when registering them.

## Commands

| Command                                                              | Access / purpose                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `/panel`                                                             | Admin; create/refresh saved base controls                          |
| `/device add`                                                        | Admin; entity ID, name, switch/alarm type, optional sensitive flag |
| `/device remove`, `/device rename`, `/device list`, `/device status` | Admin; manage/query devices                                        |
| `/alarm list`, `/alarm enable`, `/alarm disable`                     | Admin; notification settings only, never physical alarm wiring     |
| `/alarm test`                                                        | Admin; simulated notification                                      |
| `/chat setup`, `/chat enable`, `/chat disable`                       | Admin; manage bridge                                               |
| `/chat status`                                                       | Guild members; bridge health                                       |
| `/settings role-add`, `/settings role-remove`, `/settings roles`     | Admin; operator role allow list                                    |
| `/settings alerts`                                                   | Admin; alert channel and optional ping role                        |
| `/status`, `/ping`, `/help`                                          | Guild members; operational information                             |

Administrative responses are ephemeral. The panel and alerts are channel messages. Discord-to-Rust relay only accepts ordinary non-bot, non-webhook messages from authorized members in the configured channel. Attachment-only messages are ignored; when a message has text and attachments, only its text is relayed. Embeds, stickers and attachment URLs are not fabricated into plain text.

## Chat and recovery behavior

Rust's protocol exposes `broadcast.teamMessage.message`, `getTeamChat` history and `teamChanged`. The bot combines live messages with periodic history polling and team-information checks. It uses Steam identity + protocol timestamp + text as a persistent deduplication key (the protocol has no unique team-message ID), plus short-lived fingerprints. Discord message IDs suppress duplicate outgoing events. Echo text from the connected Steam identity is recorded before sending, including in SQLite, so the connected player's Discord-origin messages do not loop back.

Player names and text are preserved in bot embeds with a `[Rust]` author label. This uses the ordinary bot-message fallback rather than player webhooks, avoiding webhook-token storage and extra permissions. Mentions cannot ping Discord roles/users through relayed messages. Outgoing messages use `[Discord] DisplayName: text`; mentions/markdown/control characters are sanitized, long messages are split with a prefix on each part, and more than eight parts are rejected. Both directions use ordered queues with bounded capacity. Different message sources and simultaneous game events can still arrive out of timestamp order.

At startup, reconnect, team change, or re-enabling chat, the first history snapshot is **baseline-only**: old messages and messages sent while the bridge was offline are intentionally not replayed. Live chat resumes after synchronization. Polling recovers messages missed within an active session while the server retains them. A disconnected bridge tells an authorized Discord sender that their message was not relayed. Uncertain Rust sends are not automatically retried, since that could duplicate a delivered message.

Smart Alarm baselines never trigger ordinary raid alerts. Only a live inactive → active broadcast triggers a raid alert. If an enabled alarm is already active when its monitoring baseline is established at startup/reconnect, a separate **⚠️ Alarm Active After Reconnection** warning explains that the activation time and cause are unknown. This warning never claims a raid or pings the raid role. It is suppressed across reconnects and process restarts until an inactive state is observed. Disabled/deleted alarms do not produce recovery warnings; disabling removes pending alerts and warnings. Cooldowns still apply to normal raid alerts and survive restarts.

Observed activations and cooldown timestamps are committed together in SQLite before Discord delivery; failed sends retry with capped backoff and survive restarts. Multiple undelivered activations of the same alarm coalesce into one pending alert showing its original observation time. Discord delivery is at-least-once: a crash after Discord accepts a notification but before its local acknowledgement can cause a duplicate. No bot can observe alarms while Rust+ or its host is unreachable; events during an offline Rust session are not reconstructed from an active snapshot.

After the first initialized connection, a continuous Rust+ outage of **60 seconds** queues one **⚠️ Rust+ Connection Lost** notification in the existing alert channel. Reconnection attempts do not repeat it. A single recovery notification follows authentication and device initialization, includes approximate downtime, and explicitly says **Degraded Monitoring** if required devices failed to subscribe. Failed subscriptions retry on the 30-second maintenance cycle; `/status` reports the current device health and last successful connection time. A fresh startup or a brief outage does not produce connection notices. A previously recorded outage resumes across a process restart. These operational notices do not ping the raid role. If Discord is unavailable, SQLite retains the notices in outage order and retries after Discord reconnects. Configure `/settings alerts` to receive them.

The Rust connection authenticates by requesting server info, restores each device subscription with `getEntityInfo`, and periodically probes the server to catch half-open connections. Failed transport/timeout requests reconnect with capped exponential backoff and jitter. Invalid-token/authentication responses stop retries and show `invalid-credentials` until you re-pair and restart. Requests are serialized, bounded and paced below the documented player budget: one token every 800 ms, two tokens for chat. A rate-limit response pauses subsequent work for ten seconds. Mutating requests are never blindly retried. discord.js handles Discord gateway reconnects and REST rate limits.

## 6. Ubuntu VPS deployment with Docker Compose

Install [Docker Engine and its Compose plugin](https://docs.docker.com/engine/install/ubuntu/) from Docker's Ubuntu instructions. Upload/clone this project to your VPS, excluding your local `.env`, data and pairing files. Create `.env` privately on the VPS with the paired server fields and Discord credentials.

```sh
# First build and start (no inbound ports are published)
docker compose build --pull
docker compose up -d

# Status and logs
docker compose ps
docker compose logs -f --tail=100

# Graceful stop; preserve the named database volume
docker compose stop

# Start again
docker compose start

# Update code, then rebuild/recreate
git pull
docker compose up -d --build

# Reload changed .env values
docker compose up -d --force-recreate

# Remove containers/network while retaining the database volume
docker compose down
```

If you uploaded an archive instead of using Git, replace files with the newer release before the rebuild. The image uses a production dependency tree, runs as the unprivileged Node user, drops Linux capabilities and persists `/app/data` in `bot-data`. It has no exposed ports. `restart: unless-stopped` restarts after process failures or host reboots; an explicit stop remains stopped. A `.env` validation failure requires fixing configuration, not repeated restarts. Do **not** use `docker compose down -v` unless you intend to permanently erase the saved configuration.

Back up the entire data directory while stopped, including any SQLite WAL/SHM files. From this project directory:

```sh
docker compose stop
docker compose run --rm --no-deps --entrypoint tar rust-bot -C /app/data -czf - . > rust-bot-data.tar.gz
docker compose start
```

To restore, stop the service and copy/extract the backup into its named volume with ownership readable/writable by UID 1000 (the container's Node user). Keep backups private. The SQLite database contains guild configuration, device IDs and short-lived relayed-chat deduplication text, not Discord/Rust login tokens. Wipes/server changes should use a new volume or remove obsolete registrations deliberately.

## Troubleshooting and validation

- **`exec ...: operation not permitted` before application logs:** this is a container execution failure, not a Discord/Rust credential error. If disabling `init` just changes the blocked path from `docker-init` to `docker-entrypoint.sh`, the restriction is broader than the init helper. Compare disposable runs of the built image with `--entrypoint /usr/local/bin/node --cap-drop ALL` and then the same command plus `--security-opt no-new-privileges:true`, passing `--version` as the Node argument. These probes need no environment file or data volume. If only the second fails, the host's security policy conflicts with no-new-privileges; inspect `docker info` and kernel AppArmor denials before changing the host. A host-specific workaround is removing just the two-line `security_opt` block, which removes the extra privilege-escalation guard; retain the non-root user, capability dropping and Docker's other default isolation. Do not disable AppArmor/seccomp globally or use privileged mode. Fixing the host's Docker/security integration is preferable; back up volumes before changing Docker installations. This bot can run without `init` because it handles SIGTERM/SIGINT and does not spawn child processes.
- **Commands missing:** confirm application ID, guild ID, invite scopes, and startup logs. Guild command registration requires the bot to be installed in that guild.
- **Discord 401 / startup failure:** reset/update the bot token. For unavailable intents, enable Message Content Intent and restart.
- **No Rust+ connection:** use the pairing notification's game-server IP/app port (not the VPS IP or game/query port), verify the server supports Rust+, and check outbound firewall rules. Transport error logs identify the `proxy`/`direct` route, a safe `reason`, and `httpStatus` when the WebSocket upgrade is rejected; raw error messages and credentials are omitted. Errors while still `connecting` occur before player-token authentication. A proxy HTTP failure alone does not distinguish an unavailable proxy from an unreachable game-server app port; compare connectivity through both routes before changing credentials. Direct `ws://` transport is unencrypted. A game-server restart may briefly interrupt service.
- **Invalid credentials:** re-pair the server with the matching Steam account, update the token and recreate the container. Never paste tokens into Discord.
- **`ProtocolError` during synchronization or chat setup:** rustplus.js 2.5.0 requires metadata fields that Rust servers can omit when they have default values. Examples include `AppInfo.queuedPlayers`, offline team members' `isOnline`/`isAlive`, zero coordinates/timestamps, and map-note `type`. The bot applies an in-memory compatibility fix to server/team metadata before its first request on every connection, preserving protobuf defaults (`false`, `0`, empty strings), identity and message-text requirements, response sequence requirements, and device type/payload validation. It does not edit `node_modules` or change entity type IDs. Update the source and rebuild the image if using an older bot build. Unexpected decoding failures cancel pending requests and enter normal reconnection, with safe schema-field diagnostics when available, rather than crashing the process. If an older build reconnects repeatedly after enabling chat, temporarily run `/chat disable` while updating. See upstream [issue #81](https://github.com/liamcottle/rustplus.js/issues/81), [PR #77](https://github.com/liamcottle/rustplus.js/pull/77) and [PR #82](https://github.com/liamcottle/rustplus.js/pull/82).
- **Unknown devices:** check entity ID, type, Steam pairing identity and server. Re-pair and re-register after a wipe or entity replacement. Maximum 100 registered devices.
- **No raid alert / alarm test fails:** first run `/settings alerts channel:#raid-alerts` without a role and allow the bot **View Channel**, **Send Messages** and **Embed Links** in that channel, including category/channel overrides. Retry `/alarm test id:<registered-alarm-id>`; this tests Discord delivery without contacting Rust+. A saved channel setting in SQLite overrides `ALERT_CHANNEL_ID`, so changing the environment alone may not select a new destination. Once the test succeeds, optionally configure a mentionable raid role, enable alarm notifications, confirm electrical power/wiring and test a real inactive → active sensor transition. Check cooldowns. Expected missing-channel/access/permission errors have actionable ephemeral responses; unknown errors remain private and their code is logged.
- **Chat unavailable:** the paired player must belong to a Rust team; verify the channel, operator role and Message Content Intent. Check `/chat status`. No messages are forwarded while chat is synchronizing.
- **Panel missing/deleted:** run `/panel` to recreate a deleted saved message. Check Read Message History and Embed Links permissions.

```sh
npm run typecheck
npm run lint
npm test
npm run build
docker compose config --no-env-resolution --quiet
docker build -t rust-discord-base-bot .
```

Tests use mocks, controlled timers, local SQLite and a loopback WebSocket server with the installed rustplus.js library and protobuf schema. They cover permission isolation, actual button handlers, simultaneous controls, uncertain switch failures, chat ordering/polling/echo suppression, notification thresholds, recovery warnings, alarm edges/cooldowns, additive database migrations and subscription restoration. Successful automated checks do not establish that your real credentials, Discord permissions, public server configuration or in-game wiring work. Complete [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) before relying on the bot for alerts. See [REVIEW_REPORT.md](REVIEW_REPORT.md) for the pre-deployment review and [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for each remaining dependency advisory.

## Implementation references

The integration was checked against the installed rustplus.js source and protocol, its [device broadcast example](https://github.com/liamcottle/rustplus.js/blob/master/examples/4_entity_changed_broadcasts.js), [request example](https://github.com/liamcottle/rustplus.js/blob/master/examples/6_async_requests.js) and [documented request budgets](https://github.com/liamcottle/rustplus.js#rate-limits). `src/rust/protocol.ts` defines only the protocol fields used by this bot. `src/rust/connection.ts` wraps the verified callback API with timeout cleanup; it deliberately consumes handled responses instead of emitting them again as generic messages.

Dependency overrides update protobufjs and the pairing CLI's form-data/qs packages. `npm audit` currently reports 11 moderate advisories in upstream bundled dependencies, with no high or critical advisories in either the full or production tree. Remaining issues involve the legacy pairing CLI's request/tough-cookie/uuid chain and the camera image decoder's file-type chain. This bot never runs the pairing CLI or decodes camera images at runtime. Avoid forcing incompatible major replacements of these packages; review upstream releases and rerun the protocol tests when updating. Pairing itself remains a manual desktop step using the upstream CLI. The current dependency lockfile is included for reproducible installs.

Code is split into configuration/logging, SQLite storage, permissions, device/alarm transitions, the Rust connection manager, the team-chat bridge and Discord command/panel/alert modules. There is no arbitrary command execution path in Discord. Only registered switch entity IDs can reach a state-changing Rust+ request.
