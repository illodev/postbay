import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { FakeServer, readAll, type Call } from './base.js';

/**
 * A stand-in for the X API v2: OAuth 2.0 with PKCE and rotating renewal tokens, media upload (one call for pictures, pieces
 * for video), posting with X's refusal of duplicate content, and public/organic metrics. Written from the documentation.
 */
export class FakeX extends FakeServer {
  user = { id: '4242', username: 'lumencoffee', name: 'Lumen Coffee' };
  clientId = 'xid';
  clientSecret = 'xsecret';
  /** What the sign-in page was given; the token call must come back with a verifier that matches it. */
  expectChallenge: string | null = null;
  accessTokens = new Set<string>();
  refreshTokens = new Set<string>();
  revoked = false;
  media = new Map<string, { bytes: number; category?: string; segments: number[]; finalized: boolean; polls: number; total?: number }>();
  videoPolls = 1;
  rejectVideoWith: string | null = null;
  posts = new Map<string, { id: string; text: string; media: string[]; reply_to?: string; created_at: string }>();
  /** The next post is created but the answer is lost (a 503): what a dropped connection looks like to the caller. */
  loseNextPostAnswer = false;
  metrics = { impression_count: 900, like_count: 31, reply_count: 4, retweet_count: 3, quote_count: 1, bookmark_count: 5 };
  organic: Record<string, number> | null = { impression_count: 1000, like_count: 31, reply_count: 4, retweet_count: 3, quote_count: 1, bookmark_count: 5 };
  altTexts: Record<string, string> = {};
  private n = 0;

  private issue() {
    const access = `acc-${++this.n}`;
    const refresh = `ref-${++this.n}`;
    this.accessTokens.add(access);
    this.refreshTokens.add(refresh);
    return { token_type: 'bearer', access_token: access, refresh_token: refresh, expires_in: 7200, scope: 'tweet.read tweet.write users.read offline.access media.write' };
  }

  async handle(c: Call, req: FastifyRequest, reply: FastifyReply) {
    const body = (c.body ?? {}) as Record<string, any>;
    const bearer = String(c.headers.authorization ?? '').replace(/^Bearer /, '');
    const err = (status: number, title: string, detail: string) => reply.code(status).send({ title, detail, status, type: 'about:blank' });

    if (c.path === '/2/oauth2/token') {
      const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      if (c.headers.authorization !== `Basic ${basic}`) return reply.code(401).send({ error: 'invalid_client', error_description: 'Client authentication failed' });
      if (body.grant_type === 'authorization_code') {
        if (body.code === 'bad') return reply.code(400).send({ error: 'invalid_grant', error_description: 'Value passed for the authorization code was invalid.' });
        const challenge = createHash('sha256').update(String(body.code_verifier ?? '')).digest('base64url');
        if (this.expectChallenge && challenge !== this.expectChallenge) return reply.code(400).send({ error: 'invalid_grant', error_description: 'Value passed for the code verifier was invalid.' });
        return reply.send(this.issue());
      }
      if (body.grant_type === 'refresh_token') {
        if (this.revoked || !this.refreshTokens.has(body.refresh_token)) return reply.code(400).send({ error: 'invalid_grant', error_description: 'Value passed for the refresh token was invalid.' });
        this.refreshTokens.delete(body.refresh_token); // renewal tokens are single use
        return reply.send(this.issue());
      }
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    }

    if (this.revoked || !this.accessTokens.has(bearer)) {
      await readAll(req);
      return err(401, 'Unauthorized', 'Unauthorized');
    }

    if (c.path === '/2/users/me') return reply.send({ data: this.user });

    let m = /^\/2\/users\/([^/]+)\/tweets$/.exec(c.path);
    if (m) return reply.send({ data: [...this.posts.values()].reverse().slice(0, Number(c.query.max_results ?? 10)).map((p) => ({ id: p.id, text: p.text, created_at: p.created_at })) });

    if (c.path === '/2/media/upload' && c.method === 'POST') {
      const raw = (await readAll(req)).toString('latin1');
      const id = this.id('media');
      this.media.set(id, { bytes: raw.length, category: /name="media_category"\r\n\r\n(\w+)/.exec(raw)?.[1], segments: [], finalized: true, polls: 0 });
      return reply.send({ data: { id, media_key: `3_${id}` } });
    }
    if (c.path === '/2/media/upload' && c.method === 'GET') {
      const mm = this.media.get(c.query.media_id ?? '');
      if (!mm) return err(404, 'Not Found Error', 'Media not found');
      mm.polls++;
      if (this.rejectVideoWith) return reply.send({ data: { id: c.query.media_id, processing_info: { state: 'failed', error: { message: this.rejectVideoWith } } } });
      if (mm.polls <= this.videoPolls) return reply.send({ data: { id: c.query.media_id, processing_info: { state: 'in_progress', check_after_secs: 1 } } });
      return reply.send({ data: { id: c.query.media_id, processing_info: { state: 'succeeded' } } });
    }
    if (c.path === '/2/media/upload/initialize') {
      const id = this.id('video');
      this.media.set(id, { bytes: 0, category: body.media_category, segments: [], finalized: false, polls: 0, total: body.total_bytes });
      return reply.send({ data: { id, expires_after_secs: 86400 } });
    }
    m = /^\/2\/media\/upload\/([^/]+)\/append$/.exec(c.path);
    if (m) {
      const mm = this.media.get(m[1]!);
      const raw = await readAll(req);
      if (!mm) return err(404, 'Not Found Error', 'Media not found');
      const idx = Number(/name="segment_index"\r\n\r\n(\d+)/.exec(raw.toString('latin1'))?.[1]);
      if (idx !== mm.segments.length) return err(400, 'Invalid Request', `Segment ${idx} out of order`);
      mm.segments.push(idx);
      mm.bytes += raw.length;
      return reply.code(204).send();
    }
    m = /^\/2\/media\/upload\/([^/]+)\/finalize$/.exec(c.path);
    if (m) {
      const mm = this.media.get(m[1]!);
      if (!mm) return err(404, 'Not Found Error', 'Media not found');
      mm.finalized = true;
      return reply.send({ data: { id: m[1], processing_info: { state: 'pending', check_after_secs: 1 } } });
    }
    if (c.path === '/2/media/metadata') {
      this.altTexts[body.id] = body.metadata?.alt_text?.text;
      return reply.send({ data: { id: body.id } });
    }

    if (c.path === '/2/tweets' && c.method === 'POST') {
      const text = String(body.text ?? '');
      if (!text.trim() && !body.media) return err(400, 'Invalid Request', 'A post needs text or media');
      if (text.length > 560) return err(400, 'Invalid Request', 'Your Post text is too long');
      const mediaIds: string[] = body.media?.media_ids ?? [];
      for (const id of mediaIds) {
        const mm = this.media.get(id);
        if (!mm || !mm.finalized) return err(400, 'Invalid Request', `Media ${id} is not ready`);
      }
      if ([...this.posts.values()].some((p) => p.text === text)) return err(403, 'Forbidden', 'You are not allowed to create a Tweet with duplicate content.');
      const id = `${1000 + this.posts.size + 1}`;
      this.posts.set(id, { id, text, media: mediaIds, reply_to: body.reply?.in_reply_to_tweet_id, created_at: new Date(this.now()).toISOString() });
      if (this.loseNextPostAnswer) {
        this.loseNextPostAnswer = false;
        return reply.code(503).send({ title: 'Service Unavailable', detail: 'Service Unavailable', status: 503 });
      }
      return reply.code(201).send({ data: { id, text } });
    }
    m = /^\/2\/tweets\/([^/]+)$/.exec(c.path);
    if (m) {
      const p = this.posts.get(m[1]!);
      if (!p) return err(404, 'Not Found Error', `Could not find tweet with id: [${m[1]}].`);
      const wants = String(c.query['tweet.fields'] ?? '');
      return reply.send({ data: { id: p.id, text: p.text, ...(wants.includes('public_metrics') ? { public_metrics: this.metrics } : {}), ...(wants.includes('organic_metrics') && this.organic ? { organic_metrics: this.organic } : {}) } });
    }
    return err(404, 'Not Found', `no route ${c.method} ${c.path}`);
  }
}
