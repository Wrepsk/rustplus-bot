# Pre-deployment review — 2026-10-11

The existing implementation has been inspected, improved and tested. It is ready for a **controlled live smoke test**, with the Docker image build and real Discord/Rust/VPS behavior still unverified. The architecture, commands, Discord panel layout, environment names, existing registrations and persisted settings were retained. No dependencies or protocol libraries were replaced.

## 1. Bugs found and fixed

- **Switch click race:** the lock was acquired after awaiting Discord's progress response, allowing rapid interactions to overlap. The per-device lock now reserves the operation first; other switches remain independent.
- **Uncertain switch state:** failed/unacknowledged writes could leave the old cached panel state looking confirmed. Failures invalidate it, disable ON/OFF until a valid read, and never produce success feedback. An unverified device type must pass a read before any write. Successful writes still require an actual Rust+ read and report mismatched requested/reported state honestly.
- **Stale reads:** a delayed snapshot could overwrite a newer broadcast, and an old connection's query could restore stale state. Generation/version guards discard those results and protect newer subscription work.
- **Partial restoration:** successful transport/authentication could conceal failed device subscriptions. `/status` and recovery notices now report degraded monitoring; maintenance retries inaccessible subscriptions.
- **Alert durability/races:** cooldown and alert persistence were separate writes; an older in-flight alert acknowledgement could erase a replacement after disabling/re-enabling an alarm. Activation persistence is transactional, and per-job nonces protect newer jobs. Notification settings are rechecked before delivery.
- **Chat ordering/session races:** asynchronous role fetches could reorder outgoing messages; queued Rust requests could outlive their team session. Authorization runs in the ordered queue and session checks repeat at actual dispatch. Uncertain sends receive failure feedback and are never automatically retried.
- **Chat echoes/history:** delayed outgoing echoes could outlive short-lived fingerprints. The connected player's reserved `[Discord] ` prefix remains suppressed, while teammates' quotations remain eligible. History baseline filtering and refreshed deduplication records avoid old history replay; failed incoming deliveries remain eligible for a later active-session poll.
- **Queue/shutdown handling:** background panel refreshes could accumulate behind slow Discord requests. Refreshes now coalesce, application queues and chat tables are bounded, in-flight event/chat/panel/alert work is drained before SQLite closes, and shutdown errors cannot escape as unhandled rejections. Discord REST timeouts/retries are bounded. Removed devices release cached state.
- **Startup/security hygiene:** invalid `LOG_LEVEL` could fail during logger construction before configuration diagnostics. Logging now permits the configuration validator to report it. Initial operator roles cannot include `@everyone`; authorization ignores legacy persisted entries and role-remove allows their cleanup. Ignore patterns also cover SQLite and custom pairing filenames.

## 2. New functionality

- One connection-loss notification after a continuous **60-second outage**, and one subsequent restoration notification after authentication/device initialization, including approximate downtime.
- No connection notices for brief interruptions or a fresh startup. A previously recorded outage survives a process restart. Invalid credentials explain re-pair/update/restart rather than promising endless retries.
- A degraded restoration message lists unavailable required devices. `/status` shows connection/reconnection state, monitoring health and the persisted last successful connection time.
- Connectivity notices use the existing alert channel and persistent SQLite outbox. They retain loss-before-restoration order during Discord disconnection and retry after its gateway resumes. Notification errors are isolated from Rust+ recovery.
- An enabled alarm found active in its startup/recovery baseline produces **Alarm Active After Reconnection**, with an explicitly unknown activation time/cause. It never becomes a fabricated raid event or a role ping. Persistent deduplication suppresses further warnings until an inactive state is observed. Ordinary edges/cooldowns remain intact.

## 3. Files changed

| Files                                                                                                                                      | Purpose                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/connection-notifications.ts` (new)                                                                                                    | Outage threshold, persisted tracking, recovery/degraded notices.                                                                       |
| `src/rust/connection.ts`                                                                                                                   | Subscription health, stale-result protection, verification-before-write, failure invalidation and removed-device cleanup.              |
| `src/devices.ts`, `src/domain.ts`                                                                                                          | Active recovery baselines, switch failure/locking behavior, device-cache cleanup.                                                      |
| `src/database.ts`                                                                                                                          | Additive outbox/warning migration, atomic alarm persistence, job nonces and bounded chat storage.                                      |
| `src/discord/alerts.ts`                                                                                                                    | Persistent operational/recovery delivery, settings guards, bounded queue and shutdown safety.                                          |
| `src/discord/bot.ts`                                                                                                                       | Notification wiring, status fields, gateway recovery wake-ups, switch lock race fix, bounded REST settings and shutdown task draining. |
| `src/discord/panel.ts`                                                                                                                     | Coalesced background updates, unknown-state controls and drain support.                                                                |
| `src/chat.ts`                                                                                                                              | Ordered authorization, dispatch-time guards/echo recording, robust polling, clear delivery failures and shutdown synchronization.      |
| `src/config.ts`, `src/log.ts`, `src/index.ts`                                                                                              | Initial role validation, safe startup logging and shutdown error containment.                                                          |
| `tests/connection-notifications.test.ts`, `tests/recovery-alerts.test.ts`, `tests/interactions.test.ts`, `tests/persistence.test.ts` (new) | Controlled-timer outage tests, recovery delivery, actual button authorization/concurrency and persisted migration tests.               |
| `tests/connection.test.ts`, `tests/chat.test.ts`, `tests/panel.test.ts`                                                                    | Subscription/read/write races, chat lifecycle/order/echo/history and panel refresh regression tests.                                   |
| `.gitignore`, `.dockerignore`                                                                                                              | Additional pairing/SQLite/audit artifact exclusions.                                                                                   |
| `README.md`, `VALIDATION.md`                                                                                                               | Updated behavior/setup and actual verification evidence.                                                                               |
| `DEPLOYMENT_CHECKLIST.md`, `SECURITY_REVIEW.md`, `REVIEW_REPORT.md` (new)                                                                  | Live/VPS checks, dependency-by-dependency security analysis and this report.                                                           |

`src/permissions.ts` and `tests/domain.test.ts` also changed to enforce/test rejection of legacy persisted `@everyone` access.

The Dockerfile, Compose deployment settings, `.env.example`, package manifest and lockfile required no changes after inspection.

## 4. Checks actually executed

| Check                                                   | Result                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                     | Passed strict application and test checks.                                                   |
| `npm run lint`                                          | Passed ESLint.                                                                               |
| `npm test`                                              | Passed **77 tests / 10 files**; 35 new regression cases.                                     |
| `npm run build`                                         | Passed production TypeScript compilation.                                                    |
| Final `npm run check`                                   | Passed all four checks together.                                                             |
| `node dist/index.js` with missing configuration         | Expected exit 1; actionable field diagnostics, no secrets printed.                           |
| `docker compose config --no-env-resolution --quiet`     | Passed without requiring secrets.                                                            |
| `docker build -t rust-discord-base-bot:review .`        | Attempted; blocked before image build by unavailable Docker Linux engine.                    |
| `npm audit --json` / `npm audit --omit=dev --json`      | Both completed with vulnerability exit 1: 11 moderate, 0 high/critical.                      |
| `npm audit fix --dry-run --json`                        | Completed with vulnerability exit 1; no changed/removed package versions, advisories remain. |
| `npm ls` and installed dependency/source inspection     | Confirmed exact affected versions and call paths.                                            |
| `git diff --check` / tracked-secret filename inspection | Passed; no tracked environment, pairing credential or SQLite data files found.               |

Vitest initially encountered Windows sandbox temporary-file isolation errors. The successful final suite ran outside that sandbox. Mocks and controlled timers cover failure behavior; the protocol test runs the installed RustPlus implementation against a local WebSocket endpoint. None establishes real game/Discord connectivity.

## 5. Remaining dependency vulnerabilities

Both production and full installations retain **11 moderate package findings**, originating from four advisories: file-type's ASF parser loop, request's redirect SSRF, tough-cookie's optional-cookie-jar prototype pollution and uuid's supplied-buffer handling in v3/v5/v6. Seven other audit entries inherit those issues.

The affected image parser is loaded with camera dependencies but never called by this bot. The request/cookie stack is used by manual desktop pairing, not the deployed bot. The inspected upstream UUID call sites use v4; bot IDs use Node crypto. These are reachability conclusions for the reviewed feature set, not claims that the installed packages are patched. Forced major overrides would risk old Jimp or legacy `uuid/v4` imports. Safe existing overrides remain; the compatible audit-fix dry run found no resolving updates. See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for every package/version, advisory link and fix decision.

## 6. Live testing still required

Real Discord authentication/channel permissions, Steam/FCM pairing, switch wiring and confirmed ON/OFF reads, alarm edges and active recovery baselines, both chat directions/team changes, actual Rust/proxy/internet/Discord outages, Docker volume ownership/persistence and VPS reboot recovery remain untested. Follow [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md). No credentials were requested or added to tests.

## 7. Required configuration and update steps

No new environment variables or slash commands are required. Configure the existing alert channel with `/settings alerts` or its initial environment default. Operational/recovery notices deliberately do not mention the raid role; real/simulated raid messages retain the configured role behavior.

Back up the stopped SQLite volume, update code, build and recreate with the existing Compose instructions. The first run adds tables/indexes and an alarm-outbox nonce column while retaining existing rows/settings. Old pending alerts survive migration. Keep one bot instance per database, and never remove the volume as an update step. An initial `ALLOWED_ROLE_IDS` containing the guild's `@everyone` role now requires removing that role and choosing a specific operator role. Authorization ignores any legacy persisted `@everyone` entry; clean it up with `/settings role-remove role:@everyone` and add a specific operator role.

## 8. Deployment readiness and limits

Application checks pass and the project is ready for a supervised live smoke test. Start Docker Engine on the Ubuntu VPS and verify the image build before deployment; the local environment could not verify it. Supply real configuration privately and complete the live checklist before relying on raid monitoring.

The existing image uses Node 22, non-root UID 1000, a writable named SQLite volume, production dependencies and no inbound ports. Compose uses `unless-stopped`, capability dropping, bounded logs and a shutdown grace period. Temporary Rust/proxy outages keep the process alive and trigger backoff; rejected credentials pause retry until re-pairing/restart. No connectivity-based container health check was added, avoiding game-server downtime being treated as process failure. Container lifecycle plus `/status` and logs provide separate process/connection information.

Remaining inherent limits: offline alarm edges cannot be reconstructed; active baseline warnings cannot prove a raid; chat history can expire before polling catches up; and a crash between Discord acceptance and SQLite acknowledgement can duplicate a notification. Successful switch reads describe electrical switch state, never physical door/equipment behavior.
