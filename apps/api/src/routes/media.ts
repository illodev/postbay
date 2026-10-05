import type { FastifyInstance } from 'fastify';
import { lookup } from './mime.js';
import type { Ctx } from '../context.js';
import { LocalStorage } from '../storage/index.js';

/**
 * Signed media URLs for the local storage driver, answered at the media domain. With S3 the browser talks to the bucket
 * directly and none of this is used. CORS is limited to the app's own origin.
 */
export async function mediaRoutes(app: FastifyInstance, ctx: Ctx) {
  const storage = ctx.storage;
  if (!(storage instanceof LocalStorage)) return;
  const origin = new URL(ctx.config.APP_URL).origin;

  // The body of an upload is the file itself: hand it over as a raw stream, whatever its content type.
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  app.addHook('onRequest', async (req, reply) => {
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    if (req.method === 'OPTIONS') {
      reply
        .header('access-control-allow-methods', 'GET, PUT, OPTIONS')
        .header('access-control-allow-headers', 'content-type, range')
        .header('access-control-max-age', '600')
        .code(204)
        .send();
    }
  });

  const keyOf = (params: unknown) =>
    ((params as { '*': string })['*'] ?? '').split('/').map(decodeURIComponent).join('/');

  // The preflight of a browser upload from the app's origin. The hook above answers it, but only for a route of this plugin:
  // without one, Fastify gives the app's 404 and the browser refuses the upload.
  app.options('/media/*', async () => undefined);

  app.put('/media/*', async (req, reply) => {
    const r = await storage.receive(keyOf(req.params), req.query as Record<string, string>, req.raw);
    return reply.code(r.status).send(r.error ? { error: r.error } : undefined);
  });

  app.get('/media/*', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const r = await storage.serve(keyOf(req.params), q);
    if (r.status !== 200) return reply.code(r.status).send({ error: r.error });
    reply.header('accept-ranges', 'bytes').header('content-type', lookup(keyOf(req.params))).header('cache-control', 'private, max-age=3600');
    if (r.filename) reply.header('content-disposition', `attachment; filename="${r.filename.replace(/["\r\n]/g, '')}"`);
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, r.size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), r.size - 1) : r.size - 1;
      if (start > end || start >= r.size) return reply.code(416).header('content-range', `bytes */${r.size}`).send();
      return reply
        .code(206)
        .header('content-range', `bytes ${start}-${end}/${r.size}`)
        .header('content-length', end - start + 1)
        .send(r.stream({ start, end }));
    }
    return reply.header('content-length', r.size).send(r.stream());
  });
}
