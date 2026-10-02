import type { FastifyReply, FastifyRequest } from 'fastify';
import { FakeServer, type Call } from './base.js';

/** A stand-in for Slack's incoming webhooks: it keeps what was posted, and can be told to refuse the way Slack does. */
export class FakeSlack extends FakeServer {
  posts: { path: string; text: string }[] = [];
  /** Paths Slack no longer knows: it answers 404 "no_service". */
  gone = new Set<string>();

  handle(c: Call, _req: FastifyRequest, reply: FastifyReply) {
    if (c.method !== 'POST') return reply.code(405).send('method not allowed');
    if (this.gone.has(c.path)) return reply.code(404).type('text/plain').send('no_service');
    const body = (c.body ?? {}) as { text?: string };
    if (typeof body.text !== 'string' || !body.text) return reply.code(400).type('text/plain').send('no_text');
    this.posts.push({ path: c.path, text: body.text });
    return reply.type('text/plain').send('ok');
  }
}
