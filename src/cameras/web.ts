import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Cameras } from './service';
import { CameraError } from './registry';
import { cameraPage, cameraScript, cameraStyles } from './page';

const openSchema = z.object({ ticket: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const inputSchema = z.object({ action: z.string().max(20) }).strict();
export class CameraWeb {
  constructor(
    private origin: string,
    private cameras: Cameras,
  ) {
    this.origin = new URL(origin).origin;
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = request.url || '';
    if (!path.startsWith('/camera')) return false;
    const send = (status: number, data: unknown) => {
      if (!response.destroyed) {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(data));
      }
    };
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    try {
      const assets: Record<string, [string, string]> = {
        '/camera': ['text/html', cameraPage],
        '/camera.js': ['text/javascript', cameraScript],
        '/camera.css': ['text/css', cameraStyles],
      };
      if (request.method === 'GET' && assets[path]) {
        response.writeHead(200, { 'Content-Type': assets[path][0] + '; charset=utf-8' });
        response.end(assets[path][1]);
        return true;
      }
      let body: unknown;
      if (request.method === 'POST') {
        if (
          request.headers.origin !== this.origin ||
          request.headers['content-type'] !== 'application/json'
        ) {
          send(403, { error: 'Use the original HTTPS viewer page.' });
          return true;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += Buffer.byteLength(chunk);
          if (size > 1024) {
            send(413, { error: 'Request too large.' });
            return true;
          }
          chunks.push(Buffer.from(chunk));
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          send(400, { error: 'Invalid JSON.' });
          return true;
        }
      }
      if (path === '/camera/api/open' && request.method === 'POST') {
        const parsed = openSchema.safeParse(body);
        if (!parsed.success) throw new CameraError('Invalid link. Run /camera watch again.');
        const session = await this.cameras.redeem(parsed.data.ticket);
        const slot = randomBytes(12).toString('hex');
        if (response.destroyed) {
          this.cameras.close(session);
          return true;
        }
        // Separate cookie paths let one browser view different servers concurrently.
        response.setHeader(
          'Set-Cookie',
          `camera_session=${session}; HttpOnly; Secure; SameSite=Strict; Path=/camera/api/${slot}; Max-Age=600`,
        );
        send(200, { slot });
        return true;
      }
      const route = /^\/camera\/api\/[a-f0-9]{24}\/(status|frame|input|stop)$/.exec(path);
      if (!route) {
        send(404, { error: 'Page not found.' });
        return true;
      }
      const id = /(?:^|;\s*)camera_session=([a-f0-9]{64})(?:;|$)/.exec(
        request.headers.cookie || '',
      )?.[1];
      if (!id) throw new CameraError('Viewer expired. Run /camera watch again.');
      const action = route[1];
      if (request.method === 'GET' && action === 'status') send(200, this.cameras.status(id));
      else if (request.method === 'GET' && action === 'frame') {
        const png = this.cameras.frame(id);
        response.writeHead(png ? 200 : 204, { 'Content-Type': 'image/png' });
        response.end(png);
      } else if (request.method === 'POST' && action === 'input') {
        const parsed = inputSchema.safeParse(body);
        if (!parsed.success) throw new CameraError('Invalid camera control.');
        await this.cameras.input(id, parsed.data.action);
        send(200, { ok: true });
      } else if (request.method === 'POST' && action === 'stop') {
        this.cameras.close(id);
        send(200, { ok: true });
      } else send(405, { error: 'Method not allowed.' });
    } catch (error) {
      // Never return upstream exception strings, credentials or request bodies.
      send(400, {
        error:
          error instanceof CameraError
            ? error.message
            : 'Camera request failed. Open a fresh viewer from Discord.',
      });
    }
    return true;
  }
}
