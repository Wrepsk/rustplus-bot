import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { listenerSchema } from './schema';

async function register(): Promise<void> {
  const localRequire = createRequire(require.resolve('@liamcottle/rustplus.js'));
  const fcm = localRequire('@liamcottle/push-receiver/src/android/fcm') as {
    register(...args: string[]): Promise<{ gcm: unknown; fcm: { token: string } }>;
  };
  // Public companion app identifiers, taken from rustplus.js 2.5.0 fcm-register.
  const credentials = await fcm.register(
    'AIzaSyB5y2y-Tzqb4-I4Qnlsh_9naYv_TD8pCvY',
    'rust-companion-app',
    '976529667804',
    '1:976529667804:android:d6f1ddeb4403b338fea619',
    'com.facepunch.rust.companion',
    'E28D05345FB78A7A1A63D70F4A302DBF426CA5AD',
  );
  const gcm = listenerSchema.parse(credentials.gcm);
  const expo = await fetch('https://exp.host/--/api/v2/push/getExpoPushToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      type: 'fcm',
      deviceId: randomUUID(),
      development: false,
      appId: 'com.facepunch.rust.companion',
      deviceToken: credentials.fcm.token,
      projectId: '49451aca-a822-41e6-ad59-955718d0ff9c',
    }),
  });
  if (!expo.ok) throw new Error('Expo registration failed');
  const data = (await expo.json()) as { data?: { expoPushToken?: unknown } };
  const pushToken = data.data?.expoPushToken;
  if (typeof pushToken !== 'string' || pushToken.length > 1024 || !pushToken.length)
    throw new Error('Invalid Expo response');
  const response = await fetch('https://companion-rust.facepunch.com/api/push/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      AuthToken: (workerData as { token: string }).token,
      DeviceId: 'rustplus.js',
      PushKind: 3,
      PushToken: pushToken,
    }),
  });
  if (!response.ok) throw new Error('Companion registration failed');
  parentPort?.postMessage(gcm);
}
if (parentPort) void register().catch(() => parentPort?.postMessage(null));
