import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function seal(key: Buffer, plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
function open(key: Buffer, encrypted: string, context: string): string {
  const bytes = Buffer.from(encrypted, 'base64url');
  if (bytes.length < 28 || bytes.length > 8192) throw new Error('Invalid encrypted data');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
}

// Only Rust+ credentials are transferred. Steam passwords/cookies never leave the browser.
export function pairingChallenge(): { code: string; privateKey: string } {
  const pair = generateKeyPairSync('x25519');
  const id = randomBytes(16).toString('hex');
  return {
    code: `${id}.${pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')}`,
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
  };
}
export function encryptPairing(code: string, data: unknown): string {
  const [id, publicKey] = code.split('.');
  if (!/^[a-f0-9]{32}$/.test(id) || !publicKey || code.length > 200)
    throw new Error('Invalid pairing code');
  const pair = generateKeyPairSync('x25519');
  const secret = diffieHellman({
    privateKey: pair.privateKey,
    publicKey: createPublicKey({
      key: Buffer.from(publicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    }),
  });
  const key = Buffer.from(hkdfSync('sha256', secret, id, 'rust-bot-pair-v1', 32));
  const sender = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  return `${id}.${sender}.${seal(key, JSON.stringify(data), id)}`;
}
export function decryptPairing(privateKey: string, envelope: string): unknown {
  if (envelope.length > 4000) throw new Error('Pairing data is too large');
  const [id, sender, body, extra] = envelope.split('.');
  if (!/^[a-f0-9]{32}$/.test(id) || !sender || !body || extra)
    throw new Error('Invalid pairing data');
  const secret = diffieHellman({
    privateKey: createPrivateKey({
      key: Buffer.from(privateKey, 'base64url'),
      format: 'der',
      type: 'pkcs8',
    }),
    publicKey: createPublicKey({
      key: Buffer.from(sender, 'base64url'),
      format: 'der',
      type: 'spki',
    }),
  });
  return JSON.parse(
    open(Buffer.from(hkdfSync('sha256', secret, id, 'rust-bot-pair-v1', 32)), body, id),
  );
}

export class CredentialVault {
  private key: Buffer;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    this.key = readFileSync(path);
    if (this.key.length !== 32) throw new Error('Invalid credentials.key; restore it from backup.');
  }
  encrypt(value: unknown, context: string): string {
    return seal(this.key, JSON.stringify(value), context);
  }
  decrypt(value: string, context: string): unknown {
    return JSON.parse(open(this.key, value, context));
  }
}
