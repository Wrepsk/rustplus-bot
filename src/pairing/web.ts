import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
import { encryptPairing } from './crypto';
import { registerCompanion, type Registration } from './registration';
import { page, script, styles } from './web-page';
import { listenerSchema } from './schema';
import { extensionZip } from './extension';

interface Session {
  code: string;
  csrf: string;
  callback: string;
  expires: number;
  attempts: number;
  busy: boolean;
  command?: string;
}
class WebError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const startSchema = z.object({ code: z.string().min(1).max(200) }).strict();
const completeSchema = z
  .object({ address: z.string().min(1).max(12000), csrf: z.string().max(64) })
  .strict();

export function parseSteamReturn(address: string, expected: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new WebError(400, 'Paste the complete localhost address from the Steam login tab.');
  }
  if (url.origin === 'https://rust.facepunch.com' && /^\/companion\/?$/.test(url.pathname))
    throw new WebError(
      400,
      'Facepunch redirected to the official app page without returning a Rust+ token. Install or reload the website pairing extension, refresh this page, and start a new login. Changing DNS or Nginx will not fix this login handoff.',
    );
  const callback = new URL(expected);
  if (
    url.origin !== callback.origin ||
    url.pathname !== callback.pathname ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll('token').length !== 1 ||
    url.searchParams.getAll('steamId').length !== 1 ||
    !/^\d{17}$/.test(url.searchParams.get('steamId') || '')
  )
    throw new WebError(
      400,
      'That address does not belong to this login attempt. Open Steam sign-in from this page again.',
    );
  const token = url.searchParams.get('token') || '';
  if (!/^[A-Za-z0-9._~-]{20,10000}$/.test(token))
    throw new WebError(
      400,
      'The login address has no valid Rust+ token. Complete the Steam login first.',
    );
  return token;
}

export class PairingWeb {
  private sessions = new Map<string, Session>();
  private controllers = new Set<AbortController>();
  private attempts: number[] = [];
  private stopped = false;
  private pruneTimer?: NodeJS.Timeout;
  private archive?: Buffer;
  private server = createServer((request, response) => {
    void this.handle(request, response);
  });
  constructor(
    private origin: string,
    private active: (code: string) => boolean,
    private register: Registration = registerCompanion,
  ) {
    this.origin = new URL(origin).origin;
    this.server.requestTimeout = 15000;
    this.server.headersTimeout = 10000;
    this.server.keepAliveTimeout = 5000;
    this.server.maxConnections = 100;
    this.server.maxRequestsPerSocket = 100;
  }
  async start(port = 3080, host = '127.0.0.1'): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.pruneTimer = setInterval(() => this.prune(), 60000);
    this.pruneTimer.unref();
  }
  get port(): number {
    const address = this.server.address();
    return address && typeof address !== 'string' ? address.port : 0;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    for (const controller of this.controllers) controller.abort();
    this.sessions.clear();
    if (!this.server.listening) return;
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
  }
  private async body(request: IncomingMessage): Promise<unknown> {
    if (request.headers['content-type'] !== 'application/json')
      throw new WebError(415, 'Use JSON requests.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk);
      if (size > 16384) throw new WebError(413, 'Request too large.');
      chunks.push(Buffer.from(chunk));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new WebError(400, 'Invalid request.');
    }
  }
  private prune(): void {
    for (const [id, session] of this.sessions)
      if (session.expires <= Date.now() || !this.active(session.code)) this.sessions.delete(id);
    this.attempts = this.attempts.filter((time) => time > Date.now() - 3600000);
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      if (this.stopped) throw new WebError(503, 'Pairing is restarting. Try again shortly.');
      if (request.method === 'GET' && request.url === '/pairing-extension.zip') {
        this.archive ??= extensionZip(this.origin);
        response.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="Rust-Base-Pairing-Extension.zip"',
          'Content-Length': this.archive.length,
        });
        response.end(this.archive);
        return;
      }
      const assets: Record<string, [string, string]> = {
        '/': ['text/html', page],
        '/pair.js': ['text/javascript', script],
        '/pair.css': ['text/css', styles],
      };
      if (request.method === 'GET' && request.url && assets[request.url]) {
        const [type, content] = assets[request.url];
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        response.end(content);
        return;
      }
      if (request.method !== 'POST' || !['/api/start', '/api/complete'].includes(request.url || ''))
        throw new WebError(404, 'Page not found.');
      if (request.headers.origin !== this.origin)
        throw new WebError(403, 'Open the pairing page using the link from Discord.');
      const body = await this.body(request);
      this.prune();
      if (request.url === '/api/start') {
        const parsed = startSchema.safeParse(body);
        if (!parsed.success || !this.active(parsed.data.code))
          throw new WebError(
            400,
            'Pairing code expired or invalid. Run /pair start in Discord for a new link.',
          );
        const previous = [...this.sessions.entries()].find(([, s]) => s.code === parsed.data.code);
        if (previous?.[1].busy) throw new WebError(409, 'Registration is already running.');
        if (this.sessions.size >= 50 && !previous)
          throw new WebError(429, 'Pairing is busy. Try again shortly.');
        if (previous) this.sessions.delete(previous[0]);
        const id = randomBytes(32).toString('hex'),
          csrf = randomBytes(32).toString('hex');
        const callback = `http://localhost:${randomInt(49152, 65536)}/callback/${randomBytes(16).toString('hex')}`;
        this.sessions.set(id, {
          code: parsed.data.code,
          csrf,
          callback,
          expires: Date.now() + 15 * 60000,
          attempts: 0,
          busy: false,
        });
        response.setHeader(
          'Set-Cookie',
          `pair_session=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900`,
        );
        send(200, {
          csrf,
          loginUrl: `https://companion-rust.facepunch.com/login?returnUrl=${encodeURIComponent(callback)}`,
        });
        return;
      }
      const parsed = completeSchema.safeParse(body);
      const id = /(?:^|;\s*)pair_session=([a-f0-9]{64})(?:;|$)/.exec(
        request.headers.cookie || '',
      )?.[1];
      const session = id ? this.sessions.get(id) : undefined;
      if (!parsed.success || !session || session.csrf !== parsed.data.csrf)
        throw new WebError(
          403,
          'Pairing session expired. Start again using /pair start in Discord.',
        );
      if (session.command) {
        send(200, { command: session.command });
        return;
      }
      if (session.busy) throw new WebError(409, 'Registration is already running. Please wait.');
      const token = parseSteamReturn(parsed.data.address, session.callback);
      if (session.attempts >= 3 || this.attempts.length >= 30 || this.controllers.size >= 2)
        throw new WebError(
          429,
          'Pairing limit reached. Wait before retrying or ask the bot owner.',
        );
      session.busy = true;
      session.attempts++;
      this.attempts.push(Date.now());
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        const credentials = listenerSchema.parse(await this.register(token, controller.signal));
        if (this.stopped || !this.active(session.code))
          throw new WebError(400, 'Your Discord code expired. Run /pair start again.');
        session.command = `/pair import data:${encryptPairing(session.code, credentials)}`;
        send(200, { command: session.command });
      } finally {
        session.busy = false;
        this.controllers.delete(controller);
      }
    } catch (error) {
      // Never log a request body, pasted address, upstream exception or auth token.
      send(error instanceof WebError ? error.status : 502, {
        error:
          error instanceof WebError
            ? error.message
            : 'Rust+ registration failed or timed out. Start Steam sign-in again. If it persists, ask the bot owner to check outbound connectivity and registration services.',
      });
    }
  }
}
