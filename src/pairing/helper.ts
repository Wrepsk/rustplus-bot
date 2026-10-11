import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { encryptPairing } from './crypto';
import { listenerSchema } from './schema';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let code = '',
    path = resolve('rustplus.config.json'),
    register = false,
    minimalConfig = false;
  for (let i = 0; i < args.length; ++i) {
    if (args[i] === '--code') code = args[++i] || '';
    else if (args[i] === '--config') path = resolve(args[++i] || 'rustplus.config.json');
    else if (args[i] === '--register') register = true;
    else if (args[i] === '--minimal-config') minimalConfig = true;
    else throw new Error('Usage: npm run pair -- --code CODE [--config FILE] [--register]');
  }
  if (!code) throw new Error('Run /pair start in Discord and copy its helper command first.');
  // Check the public code before starting a browser or reading credentials.
  encryptPairing(code, {});
  if (register || !existsSync(path)) {
    console.log('Opening the upstream Rust+ pairing flow. Sign in on the Steam website in Chrome.');
    console.log('The bot does not receive your Steam password. This can take a few minutes.');
    const cli = join(dirname(require.resolve('@liamcottle/rustplus.js')), 'cli', 'index.js');
    const child = spawn(process.execPath, [cli, `--config-file=${path}`, 'fcm-register'], {
      shell: false,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    // Upstream prints auth tokens. Drain output without copying secrets into console logs.
    child.stdout.resume();
    child.stderr.resume();
    const stop = () => child.kill();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', () => reject(new Error('Could not start the pairing CLI.')));
        child.once('exit', (exit) =>
          exit === 0
            ? resolve()
            : reject(
                new Error(
                  'Registration failed. Check Chrome, popup permissions and internet access, then retry.',
                ),
              ),
        );
      });
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { fcm_credentials?: { gcm?: unknown } };
  const credentials = listenerSchema.parse(raw.fcm_credentials?.gcm);
  // The desktop helper needs only the listener credentials after registration.
  // Keep the original CLI file intact unless this explicit flag is supplied.
  if (minimalConfig)
    writeFileSync(path, JSON.stringify({ fcm_credentials: { gcm: credentials } }), { mode: 0o600 });
  console.log('\nPaste this encrypted command into Discord (it contains no plaintext tokens):\n');
  console.log(`/pair import data:${encryptPairing(code, credentials)}`);
  console.log(
    '\nThen pair the server/devices in-game. The VPS listens for you; no fcm-listen needed.',
  );
}
void main().catch(() => {
  console.error(
    'Pairing failed. Check the /pair start code, registration file and Chrome installation. Use --register to register again.',
  );
  process.exitCode = 1;
});
