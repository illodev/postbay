import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

/**
 * What the stand-ins for the networks have in common: a local HTTP server that logs every call, answers JSON, form and raw
 * bodies, and can be told to fail the next calls that match something. Each network's own behaviour goes in `handle`.
 *
 * Like the Meta and Google fakes, these prove OUR logic (the calls we make, in what order, and what we do with the answers). They are
 * written from how each API is documented to behave; they cannot prove the real service still behaves that way.
 */
export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, any>;
  body: any;
}

export interface Failure {
  match: (c: Call) => boolean;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  times: number;
}

export abstract class FakeServer {
  app!: FastifyInstance;
  url = '';
  calls: Call[] = [];
  failures: Failure[] = [];
  now = () => Date.now();
  private seq = 0;

  protected id(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  abstract handle(c: Call, req: FastifyRequest, reply: FastifyReply): Promise<unknown> | unknown;

  async start(): Promise<this> {
    this.app = Fastify({ logger: false, bodyLimit: 512 * 1024 * 1024 });
    this.app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    this.app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
    this.app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error); }
    });
    this.app.all('/*', async (req, reply) => {
      const path = String(req.url).split('?')[0]!;
      const call: Call = { method: req.method, path, query: (req.query ?? {}) as Record<string, string>, headers: req.headers, body: req.body };
      this.calls.push(call);
      const f = this.failures.find((x) => x.times > 0 && x.match(call));
      if (f) {
        f.times--;
        drain(req);
        for (const [k, v] of Object.entries(f.headers ?? {})) reply.header(k, v);
        return reply.code(f.status).send(f.body);
      }
      return this.handle(call, req, reply);
    });
    await this.app.listen({ port: 0, host: '127.0.0.1' });
    this.url = `http://127.0.0.1:${(this.app.server.address() as { port: number }).port}`;
    return this;
  }

  async stop() {
    await this.app.close();
  }

  /** Fail the next `times` calls for which `match` is true. */
  fail(match: (c: Call) => boolean, body: unknown, status = 400, times = 1, headers?: Record<string, string>) {
    this.failures.push({ match, body, status, times, headers });
  }

  reset() {
    this.calls.length = 0;
    this.failures.length = 0;
  }

  callsTo(path: string | RegExp, method?: string): Call[] {
    return this.calls.filter((c) => (typeof path === 'string' ? c.path === path : path.test(c.path)) && (!method || c.method === method));
  }
}

/** Reads and discards an unread request body, so the connection can be answered cleanly. */
export function drain(req: FastifyRequest) {
  const b = req.body as { resume?: () => void } | undefined;
  if (b && typeof b.resume === 'function') b.resume();
}

/** The raw bytes of a body sent as a stream (an upload). */
export async function readAll(req: FastifyRequest): Promise<Buffer> {
  const b = req.body as any;
  if (Buffer.isBuffer(b)) return b;
  if (b && typeof b[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const c of b) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }
  return Buffer.alloc(0);
}
