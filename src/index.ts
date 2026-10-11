import { loadConfig } from './config';
import { Store } from './database';
import { DiscordHost } from './discord/host';
import { Servers } from './servers';
import { log, errorCode } from './log';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    log.error(error instanceof Error ? error.message : 'Invalid configuration');
    process.exitCode = 1;
    return;
  }
  const store = new Store(config.DATABASE_PATH);
  // Refuse to silently reuse entities from a different server or Steam identity.
  const scope = `${config.RUST_SERVER_IP}:${config.RUST_APP_PORT}:${config.RUST_STEAM_ID}`;
  const savedScope = store.get('rustScope', scope);
  if (savedScope !== scope) {
    store.close();
    throw new Error(
      'Database belongs to another Rust server/player. Use a separate DATABASE_PATH or volume.',
    );
  }
  if (store.get('discordGuild', config.DISCORD_GUILD_ID) !== config.DISCORD_GUILD_ID) {
    store.close();
    throw new Error(
      'Database belongs to another Discord guild. Use a separate database or volume.',
    );
  }
  store.set('discordGuild', config.DISCORD_GUILD_ID);
  store.set('rustScope', scope);
  const servers = new Servers(config, store);
  const bot = new DiscordHost(config, servers);
  let closing = false;
  const shutdown = async (exitCode = 0) => {
    if (exitCode) process.exitCode = exitCode;
    if (closing) return;
    closing = true;
    process.exitCode = exitCode;
    log.info('Shutting down');
    const deadline = setTimeout(() => process.exit(Number(process.exitCode ?? exitCode)), 10000);
    deadline.unref();
    try {
      await bot.stop();
    } catch (error) {
      log.error({ code: errorCode(error) }, 'Shutdown did not complete cleanly');
      process.exitCode = 1;
    } finally {
      try {
        servers.close();
        store.close();
      } catch (error) {
        log.error({ code: errorCode(error) }, 'Unable to close SQLite');
        process.exitCode = 1;
      }
    }
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.on('unhandledRejection', (error) => {
    log.fatal({ code: errorCode(error) }, 'Unhandled rejection; restarting required');
    void shutdown(1);
  });
  process.on('uncaughtException', (error) => {
    log.fatal({ code: errorCode(error) }, 'Uncaught exception; restarting required');
    void shutdown(1);
  });
  try {
    await bot.start();
  } catch (error) {
    log.error(
      { code: errorCode(error) },
      'Startup failed; verify Discord credentials, application permissions and pairing website bind address/port',
    );
    await shutdown(1);
  }
}
void main().catch((error) => {
  log.fatal(
    { code: errorCode(error) },
    'Cannot initialize bot; check database path, credentials.key backup and server scope',
  );
  process.exitCode = 1;
});
