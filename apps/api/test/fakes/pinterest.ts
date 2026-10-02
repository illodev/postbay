import type { FastifyReply, FastifyRequest } from 'fastify';
import { FakeServer, readAll, type Call } from './base.js';

/**
 * A stand-in for Pinterest's v5 API: sign-in with Basic client authentication, boards with pagination, pins (picture, carousel
 * and video), the video upload to an address of its own with the parameters that must come first in the form, and pin analytics
 * limited to 90 days. Written from the documentation, not from the real service.
 */
export class FakePinterest extends FakeServer {
  clientId = 'pid';
  clientSecret = 'psecret';
  username = 'lumencoffee';
  boards: { id: string; name: string; privacy: string }[] = [{ id: 'b1', name: 'Spring menu', privacy: 'PUBLIC' }, { id: 'b2', name: 'Behind the bar', privacy: 'PUBLIC' }];
  pageSize = 100;
  accessTokens = new Set<string>(['tok']);
  tokenSeq = 0;
  revoked = false;
  media = new Map<string, { status: string; polls: number; uploaded: boolean; fieldsBeforeFile: boolean }>();
  videoPolls = 1;
  failVideo = false;
  pins = new Map<string, any>();
  loseNextPinAnswer = false;
  /** The bytes each video upload delivered as its file. */
  uploadedFiles = new Map<string, Buffer>();
  lifetime: Record<string, number> = { IMPRESSION: 800, PIN_CLICK: 20, SAVE: 33, OUTBOUND_CLICK: 9, VIDEO_MRC_VIEW: 300, VIDEO_AVG_WATCH_TIME: 12500 };
  private n = 0;

  async handle(c: Call, req: FastifyRequest, reply: FastifyReply) {
    const body = (c.body ?? {}) as Record<string, any>;
    const err = (status: number, message: string, code = status) => reply.code(status).send({ code, message });

    if (c.path === '/v5/oauth/token') {
      const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      if (c.headers.authorization !== `Basic ${basic}`) return reply.code(401).send({ code: 2, message: 'Authentication failed.' });
      if (body.grant_type === 'authorization_code') {
        if (body.code === 'bad') return reply.code(400).send({ error: 'invalid_grant', error_description: 'Invalid authorization code' });
        const t = `tok-${++this.tokenSeq}`;
        this.accessTokens.add(t);
        return reply.send({ access_token: t, refresh_token: 'pref-1', token_type: 'bearer', expires_in: 2592000, refresh_token_expires_in: 5184000, scope: 'boards:read,pins:read,pins:write,user_accounts:read' });
      }
      if (body.grant_type === 'refresh_token') {
        if (this.revoked || body.refresh_token !== 'pref-1') return reply.code(400).send({ error: 'invalid_grant', error_description: 'Invalid refresh token' });
        const t = `tok-${++this.tokenSeq}`;
        this.accessTokens.add(t);
        return reply.send({ access_token: t, token_type: 'bearer', expires_in: 2592000, refresh_token: 'pref-1', refresh_token_expires_in: 5184000 });
      }
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    }

    // The video upload address takes no bearer token: its parameters are the credential.
    let m = /^\/upload\/(.+)$/.exec(c.path);
    if (m && c.method === 'POST') {
      // The upload address is S3's form upload: it wants the length up front (no chunked body), the fields first and the file last.
      if (!c.headers['content-length'] || /chunked/i.test(String(c.headers['transfer-encoding'] ?? ''))) {
        await readAll(req);
        return reply.code(411).send('<Error><Code>MissingContentLength</Code><Message>You must provide the Content-Length HTTP header.</Message></Error>');
      }
      const buf = await readAll(req);
      if (buf.length !== Number(c.headers['content-length'])) return err(400, 'The body did not match its Content-Length');
      const raw = buf.toString('latin1');
      const mm = this.media.get(m[1]!);
      if (!mm) return err(404, 'No such upload');
      const fileAt = raw.indexOf('name="file"');
      const keyAt = raw.indexOf('name="key"');
      mm.fieldsBeforeFile = keyAt >= 0 && fileAt > keyAt;
      if (!mm.fieldsBeforeFile) return err(400, 'The file has to be the last field of the form');
      // What arrived as the file, for the tests to compare with what was sent.
      const boundary = /boundary=(.+)$/.exec(String(c.headers['content-type']))?.[1] ?? '';
      const start = buf.indexOf('\r\n\r\n', fileAt) + 4;
      const end = buf.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
      this.uploadedFiles.set(m[1]!, buf.subarray(start, end));
      mm.uploaded = true;
      return reply.code(204).send();
    }

    const bearer = String(c.headers.authorization ?? '').replace(/^Bearer /, '');
    if (this.revoked || !this.accessTokens.has(bearer)) {
      await readAll(req);
      return err(401, 'Authentication failed.', 2);
    }

    if (c.path === '/v5/user_account') return reply.send({ username: this.username, account_type: 'BUSINESS' });
    if (c.path === '/v5/boards') {
      const start = Number(c.query.bookmark ?? 0);
      const items = this.boards.slice(start, start + Math.min(this.pageSize, Number(c.query.page_size ?? 25)));
      const next = start + items.length;
      return reply.send({ items, bookmark: next < this.boards.length ? String(next) : null });
    }
    if (c.path === '/v5/media' && c.method === 'POST') {
      const id = this.id('media');
      this.media.set(id, { status: 'registered', polls: 0, uploaded: false, fieldsBeforeFile: false });
      return reply.code(201).send({ media_id: id, media_type: 'video', upload_url: `${this.url}/upload/${id}`, upload_parameters: { key: `uploads/${id}`, policy: 'p', 'x-amz-signature': 's' } });
    }
    m = /^\/v5\/media\/([^/]+)$/.exec(c.path);
    if (m) {
      const mm = this.media.get(m[1]!);
      if (!mm) return err(404, 'Media not found');
      if (this.failVideo) return reply.send({ media_id: m[1], status: 'failed' });
      mm.polls++;
      mm.status = !mm.uploaded ? 'registered' : mm.polls <= this.videoPolls ? 'processing' : 'succeeded';
      return reply.send({ media_id: m[1], status: mm.status });
    }
    if (c.path === '/v5/pins' && c.method === 'POST') {
      if (!this.boards.some((b) => b.id === body.board_id)) return err(404, 'Board not found.', 40);
      if (String(body.title ?? '').length > 100) return err(400, 'Title must be 100 characters or fewer', 1);
      if (String(body.description ?? '').length > 800) return err(400, 'Description must be 800 characters or fewer', 1);
      const src = body.media_source ?? {};
      if (src.source_type === 'video_id') {
        const mm = this.media.get(src.media_id);
        if (!mm || mm.status !== 'succeeded') return err(400, 'The video is not ready', 1);
        if (!src.cover_image_url) return err(400, 'A cover image is required for video pins', 1);
      } else if (src.source_type === 'multiple_image_urls') {
        if (!Array.isArray(src.items) || src.items.length < 2 || src.items.length > 5) return err(400, 'A carousel pin takes 2 to 5 images', 1);
      } else if (src.source_type !== 'image_url' || !src.url) return err(400, 'Invalid media_source', 1);
      if (body.link && !/^https?:\/\//.test(body.link)) return err(400, 'Invalid link', 1);
      const id = `${5000 + this.pins.size + 1}`;
      const pin = { id, board_id: body.board_id, title: body.title, description: body.description, link: body.link, alt_text: body.alt_text, media_source: src, created_at: new Date(this.now()).toISOString() };
      this.pins.set(id, pin);
      if (this.loseNextPinAnswer) {
        this.loseNextPinAnswer = false;
        return reply.code(503).send({ code: 503, message: 'Service unavailable' });
      }
      return reply.code(201).send(pin);
    }
    m = /^\/v5\/boards\/([^/]+)\/pins$/.exec(c.path);
    if (m) return reply.send({ items: [...this.pins.values()].filter((p) => p.board_id === m![1]).reverse().slice(0, Number(c.query.page_size ?? 25)), bookmark: null });
    m = /^\/v5\/pins\/([^/]+)\/analytics$/.exec(c.path);
    if (m) {
      if (!this.pins.has(m[1]!)) return err(404, 'Pin not found.', 40);
      const days = (Date.parse(c.query.end_date!) - Date.parse(c.query.start_date!)) / 86_400_000;
      if (!(days >= 0) || days > 90) return err(400, 'The date range can be at most 90 days', 1);
      const wanted = String(c.query.metric_types ?? '').split(',');
      return reply.send({ all: { lifetime_metrics: Object.fromEntries(Object.entries(this.lifetime).filter(([k]) => wanted.includes(k))), daily_metrics: [] } });
    }
    m = /^\/v5\/pins\/([^/]+)$/.exec(c.path);
    if (m) return this.pins.has(m[1]!) ? reply.send(this.pins.get(m[1]!)) : err(404, 'Pin not found.', 40);
    return err(404, `no route ${c.method} ${c.path}`);
  }
}
