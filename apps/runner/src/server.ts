import http from 'node:http';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import type { Queue } from './queue.js';
import { verifySignature } from './signature.js';

const MAX_BODY = 1024 * 1024;

export interface ServerDeps {
  config: Config;
  queue: Queue;
  log: Logger;
  now?: () => number;
  /** Told when something was queued, so the worker does not wait for its next look. */
  wake?: () => void;
}

function readBody(req: http.IncomingMessage): Promise<string | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve('too-large');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Receives the studio's webhooks at /webhooks/<brand>. A delivery is accepted only if its signature checks out; an
 * event for which the brand has a template is written to the queue before the answer goes back, because the studio
 * treats a 2xx as "handled" and will not send it again.
 */
export function createServer(deps: ServerDeps): http.Server {
  const { config, queue, log } = deps;
  const now = deps.now ?? Date.now;
  const send = (res: http.ServerResponse, status: number, body: Record<string, unknown>) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://runner');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, queued: queue.list().length });

      const m = /^\/webhooks\/([^/]+)$/.exec(url.pathname);
      if (!m) return send(res, 404, { error: 'not found' });
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const key = decodeURIComponent(m[1]!);
      const brand = Object.hasOwn(config.brands, key) ? config.brands[key] : undefined;
      if (!brand) return send(res, 404, { error: 'unknown brand' });

      const body = await readBody(req);
      if (body === 'too-large') return send(res, 413, { error: 'body too large' });

      const secrets = Array.isArray(brand.webhookSecret) ? brand.webhookSecret : [brand.webhookSecret];
      const verdict = verifySignature(secrets, req.headers, body, now());
      if (!verdict.ok) {
        log.warn({ brand: key, reason: verdict.reason }, 'webhook refused');
        return send(res, 401, { error: 'invalid signature' });
      }

      let event: { id?: unknown; type?: unknown; data?: unknown; created_at?: unknown };
      try {
        event = JSON.parse(body);
      } catch {
        return send(res, 400, { error: 'not JSON' });
      }
      if (typeof event.id !== 'string' || typeof event.type !== 'string' || typeof event.data !== 'object' || event.data === null) {
        return send(res, 400, { error: 'not an event' });
      }
      if (event.type === 'ping') return send(res, 200, { ok: true, pong: true });
      if (!brand.templates[event.type]) return send(res, 200, { ok: true, ignored: true });

      let added: boolean;
      try {
        added = queue.add({ id: event.id, brand: key, type: event.type, receivedAt: new Date(now()).toISOString(), payload: event });
      } catch {
        return send(res, 400, { error: 'bad event id' });
      }
      if (!added) return send(res, 200, { ok: true, duplicate: true });
      log.info({ brand: key, event: event.id, type: event.type }, 'event accepted');
      deps.wake?.();
      return send(res, 202, { ok: true, queued: true });
    } catch (err) {
      log.error({ err: String(err) }, 'webhook handler failed');
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    }
  });
}
