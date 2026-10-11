import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { listenerSchema } from './schema';
import type { z } from 'zod';

export type Registration = (
  token: string,
  signal: AbortSignal,
) => Promise<z.infer<typeof listenerSchema>>;

// The upstream registration helper has requests without timeouts. A short-lived
// worker provides a hard deadline and prevents its console output leaking tokens.
export const registerCompanion: Registration = (token, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Registration stopped.'));
      return;
    }
    const path = join(__dirname, 'registration-worker');
    const compiled = existsSync(`${path}.js`);
    const worker = new Worker(
      compiled ? `${path}.js` : `require('tsx/cjs'); require(${JSON.stringify(`${path}.ts`)});`,
      {
        eval: !compiled,
        workerData: { token },
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 96 },
      },
    );
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (credentials?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {});
      const parsed = listenerSchema.safeParse(credentials);
      if (parsed.success) resolve(parsed.data);
      else
        reject(new Error('Companion registration failed or timed out. Try a fresh Steam login.'));
    };
    const abort = () => finish();
    const timer = setTimeout(abort, 60000);
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', finish);
    worker.once('error', abort);
    worker.once('exit', abort);
  });
