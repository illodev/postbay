import type { FastifyReply, FastifyRequest } from 'fastify';
import { FakeServer, type Call } from './base.js';

/**
 * A stand-in for the Threads API: sign-in with the short-lived to long-lived token exchange and refresh, containers that are
 * published in a second call, a daily publishing limit, insights. Written from the documentation, not from the real service.
 */
interface Container {
  id: string;
  media_type: string;
  text?: string;
  image_url?: string;
  video_url?: string;
  children?: string[];
  is_carousel_item: boolean;
  reply_to_id?: string;
  polls: number;
}

const graphError = (message: string, code: number, extra: Record<string, unknown> = {}) => ({ error: { message, type: 'OAuthException', code, ...extra } });

export class FakeThreads extends FakeServer {
  users = [{ id: '90001', username: 'lumen.coffee', name: 'Lumen Coffee' }];
  tokens = new Set<string>();
  tokenSeq = 0;
  containers = new Map<string, Container>();
  posts = new Map<string, Container & { permalink: string; publishedAt: number }>();
  /** How many times a video container reports IN_PROGRESS before it is finished. */
  processingPolls = 1;
  quota = { usage: 0, total: 250 };
  insights: Record<string, number> = { views: 120, likes: 9, replies: 2, reposts: 1, quotes: 1, shares: 3 };
  /** Containers whose processing fails, with the reason. */
  rejectVideoWith: string | null = null;
  revoked = false;

  private newToken() {
    const t = `long-${++this.tokenSeq}`;
    this.tokens.add(t);
    return t;
  }

  handle(c: Call, _req: FastifyRequest, reply: FastifyReply) {
    const body = (c.body ?? {}) as Record<string, string>;
    const q = c.query;

    if (c.path === '/oauth/access_token') {
      if (body.code === 'bad') return reply.code(400).send(graphError('Invalid authorization code', 100));
      return reply.send({ access_token: 'short-1', user_id: Number(this.users[0]!.id) });
    }
    if (c.path === '/access_token' && q.grant_type === 'th_exchange_token') {
      if (q.access_token !== 'short-1') return reply.code(400).send(graphError('Invalid short-lived token', 190));
      return reply.send({ access_token: this.newToken(), token_type: 'bearer', expires_in: 5184000 });
    }
    if (c.path === '/refresh_access_token') {
      if (this.revoked || !this.tokens.has(q.access_token ?? '')) return reply.code(400).send(graphError('Error validating access token', 190));
      return reply.send({ access_token: this.newToken(), token_type: 'bearer', expires_in: 5184000 });
    }

    // Everything below needs a valid token, in the query (GET) or the form (POST).
    const token = q.access_token ?? body.access_token ?? '';
    if (this.revoked || !this.tokens.has(token)) return reply.code(401).send(graphError('Error validating access token: the session has been invalidated', 190));

    if (c.path === '/v1.0/me') {
      const u = this.users[0]!;
      return reply.send({ id: u.id, username: u.username, name: u.name });
    }
    let m = /^\/v1\.0\/([^/]+)\/threads_publishing_limit$/.exec(c.path);
    if (m) return reply.send({ data: [{ quota_usage: this.quota.usage, config: { quota_total: this.quota.total, quota_duration: 86400 } }] });

    m = /^\/v1\.0\/([^/]+)\/threads$/.exec(c.path);
    if (m && c.method === 'POST') {
      const id = this.id('container');
      const children = body.children ? body.children.split(',') : undefined;
      this.containers.set(id, {
        id, media_type: body.media_type ?? 'TEXT', text: body.text, image_url: body.image_url, video_url: body.video_url, children,
        is_carousel_item: body.is_carousel_item === 'true', reply_to_id: body.reply_to_id, polls: 0,
      });
      return reply.send({ id });
    }
    m = /^\/v1\.0\/([^/]+)\/threads_publish$/.exec(c.path);
    if (m && c.method === 'POST') {
      const cont = this.containers.get(body.creation_id ?? '');
      if (!cont) return reply.code(400).send(graphError('Invalid creation_id', 100));
      if (cont.media_type === 'CAROUSEL' && (cont.children?.length ?? 0) < 2) return reply.code(400).send(graphError('A carousel needs at least 2 items', 100));
      const id = this.id('post');
      this.posts.set(id, { ...cont, permalink: `https://www.threads.net/@${this.users[0]!.username}/post/${id}`, publishedAt: this.now() });
      this.quota.usage++;
      return reply.send({ id });
    }
    m = /^\/v1\.0\/([^/]+)\/insights$/.exec(c.path);
    if (m) {
      if (!this.posts.has(m[1]!)) return reply.code(404).send(graphError('Unsupported get request', 100));
      const wanted = String(q.metric ?? '').split(',');
      return reply.send({ data: wanted.filter((n) => n in this.insights).map((name) => ({ name, period: 'lifetime', values: [{ value: this.insights[name] }] })) });
    }
    m = /^\/v1\.0\/([^/]+)$/.exec(c.path);
    if (m) {
      const cont = this.containers.get(m[1]!);
      if (cont) {
        cont.polls++;
        const isVideo = cont.media_type === 'VIDEO';
        if (isVideo && this.rejectVideoWith) return reply.send({ id: cont.id, status: 'ERROR', error_message: this.rejectVideoWith });
        if (isVideo && cont.polls <= this.processingPolls) return reply.send({ id: cont.id, status: 'IN_PROGRESS' });
        return reply.send({ id: cont.id, status: 'FINISHED' });
      }
      const post = this.posts.get(m[1]!);
      if (post) return reply.send({ id: post.id, permalink: post.permalink });
      return reply.code(400).send(graphError('Unsupported get request. Object does not exist', 100));
    }
    return reply.code(404).send(graphError(`no route ${c.method} ${c.path}`, 100));
  }
}
