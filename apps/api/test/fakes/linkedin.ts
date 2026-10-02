import type { FastifyReply, FastifyRequest } from 'fastify';
import { FakeServer, readAll, type Call } from './base.js';

/**
 * A stand-in for LinkedIn's Community Management API: the versioned header, organization lookup, the three upload flows
 * (picture, document, video in parts), posts with the markup rules of the commentary, refusal of repeated content, and share
 * statistics. Written from the documentation, not from the real service.
 */
export class FakeLinkedIn extends FakeServer {
  version = '202604';
  orgs = [{ id: '5001', localizedName: 'Lumen Coffee', vanityName: 'lumen-coffee' }];
  accessTokens = new Set<string>(['tok']);
  tokenSeq = 0;
  /** Whether sign-in also gives a renewal token (only for approved partners). */
  partner = false;
  revoked = false;
  partSize = 4000;
  videoPolls = 1;
  failVideoProcessing = false;
  uploads = new Map<string, { bytes: number; parts: number[] }>();
  etags: string[] = [];
  posts = new Map<string, { id: string; commentary: string; content: any; createdAt: number; lifecycleState: string }>();
  comments: { post: string; text: string }[] = [];
  loseNextPostAnswer = false;
  stats = { impressionCount: 1500, uniqueImpressionsCount: 1100, clickCount: 40, likeCount: 55, commentCount: 6, shareCount: 3, engagement: 0.07 };
  private polls = new Map<string, number>();
  private n = 0;

  async handle(c: Call, req: FastifyRequest, reply: FastifyReply) {
    const body = (c.body ?? {}) as Record<string, any>;
    const err = (status: number, message: string, extra: Record<string, unknown> = {}) => reply.code(status).send({ status, message, ...extra });

    if (c.path === '/oauth/token') {
      if (body.code === 'bad') return reply.code(400).send({ error: 'invalid_grant', error_description: 'The provided authorization grant is invalid, expired or revoked' });
      if (body.grant_type === 'refresh_token') {
        if (this.revoked) return reply.code(400).send({ error: 'invalid_grant', error_description: 'The refresh token is invalid' });
        const t = `tok-${++this.tokenSeq}`;
        this.accessTokens.add(t);
        return reply.send({ access_token: t, expires_in: 5184000, refresh_token: `lref-${this.tokenSeq}`, refresh_token_expires_in: 31536000 });
      }
      const t = `tok-${++this.tokenSeq}`;
      this.accessTokens.add(t);
      return reply.send({ access_token: t, expires_in: 5184000, scope: 'w_organization_social,r_organization_social,rw_organization_admin', ...(this.partner ? { refresh_token: 'lref-0', refresh_token_expires_in: 31536000 } : {}) });
    }

    const bearer = String(c.headers.authorization ?? '').replace(/^Bearer /, '');
    if (this.revoked || !this.accessTokens.has(bearer)) {
      await readAll(req);
      return err(401, 'Invalid access token', { serviceErrorCode: 65601, code: 'REVOKED_ACCESS_TOKEN' });
    }

    // Upload addresses are complete as given: no version header, but the same token.
    let m = /^\/upload\/([^/]+)$/.exec(c.path);
    if (m && c.method === 'PUT') {
      const bytes = (await readAll(req)).length;
      const u = this.uploads.get(m[1]!) ?? { bytes: 0, parts: [] };
      u.bytes += bytes;
      u.parts.push(bytes);
      this.uploads.set(m[1]!, u);
      const etag = `"etag-${++this.n}"`;
      this.etags.push(etag);
      reply.header('etag', etag);
      return reply.code(201).send('');
    }

    if (c.headers['linkedin-version'] !== this.version || c.headers['x-restli-protocol-version'] !== '2.0.0') {
      await readAll(req);
      return err(426, `Requested version ${c.headers['linkedin-version'] ?? '(none)'} is not active`, { code: 'NONEXISTENT_VERSION' });
    }

    if (c.path === '/rest/organizationAcls') return reply.send({ elements: this.orgs.map((o) => ({ organization: `urn:li:organization:${o.id}`, role: 'ADMINISTRATOR', state: 'APPROVED' })) });
    m = /^\/rest\/organizations\/(\d+)$/.exec(c.path);
    if (m) {
      const o = this.orgs.find((x) => x.id === m![1]);
      return o ? reply.send(o) : err(404, 'Organization not found');
    }

    for (const kind of ['images', 'documents', 'videos'] as const) {
      if (c.path === `/rest/${kind}` && c.query.action === 'initializeUpload') {
        const id = `${++this.n}`;
        const urnOf = `urn:li:${kind.slice(0, -1)}:${id}`;
        if (kind === 'videos') {
          const size = Number(body.initializeUploadRequest?.fileSizeBytes ?? 0);
          const count = Math.max(1, Math.ceil(size / this.partSize));
          const instructions = Array.from({ length: count }, (_, i) => ({ uploadUrl: `${this.url}/upload/vid-${id}-${i}`, firstByte: i * this.partSize, lastByte: Math.min(size, (i + 1) * this.partSize) - 1 }));
          this.uploads.set(urnOf, { bytes: size, parts: [] });
          return reply.send({ value: { video: urnOf, uploadToken: 'utok', uploadInstructions: instructions, uploadUrlsExpireAt: Date.now() + 3600_000 } });
        }
        this.uploads.set(urnOf, { bytes: 0, parts: [] });
        return reply.send({ value: { uploadUrl: `${this.url}/upload/${kind}-${id}`, [kind === 'images' ? 'image' : 'document']: urnOf, uploadUrlExpiresAt: Date.now() + 3600_000 } });
      }
    }
    if (c.path === '/rest/videos' && c.query.action === 'finalizeUpload') {
      const f = body.finalizeUploadRequest ?? {};
      const up = this.uploads.get(f.video);
      if (!up) return err(404, 'Unknown video');
      const expected = Math.max(1, Math.ceil(up.bytes / this.partSize));
      if ((f.uploadedPartIds ?? []).length !== expected || (f.uploadedPartIds as string[]).some((e) => !e)) return err(400, `Expected ${expected} part ids, got ${(f.uploadedPartIds ?? []).length}`);
      return reply.code(200).send('');
    }
    m = /^\/rest\/(videos|documents)\/(.+)$/.exec(c.path);
    if (m) {
      const id = decodeURIComponent(m[2]!);
      if (!this.uploads.has(id)) return err(404, 'Not found');
      const n = (this.polls.get(id) ?? 0) + 1;
      this.polls.set(id, n);
      if (this.failVideoProcessing) return reply.send({ id, status: 'PROCESSING_FAILED' });
      return reply.send({ id, status: n <= (m[1] === 'videos' ? this.videoPolls : 0) ? 'PROCESSING' : 'AVAILABLE' });
    }

    if (c.path === '/rest/posts' && c.method === 'POST') {
      const text = String(body.commentary ?? '');
      if (/(?<!\\)[|{}@[\]()<>*_~]/.test(text)) return err(400, 'Commentary contains unescaped reserved characters');
      if (text.length > 3000) return err(422, 'Commentary is too long');
      const content = body.content ?? {};
      const ids: string[] = content.multiImage ? content.multiImage.images.map((i: any) => i.id) : content.media ? [content.media.id] : [];
      for (const id of ids) if (!this.uploads.has(id)) return err(422, `Media ${id} does not exist`);
      const dup = [...this.posts.values()].find((p) => p.commentary === text);
      if (dup) return err(422, `Content is a duplicate of ${dup.id}`);
      const id = `urn:li:share:${7000 + this.posts.size + 1}`;
      this.posts.set(id, { id, commentary: text, content, createdAt: this.now(), lifecycleState: 'PUBLISHED' });
      reply.header('x-restli-id', id);
      if (this.loseNextPostAnswer) {
        this.loseNextPostAnswer = false;
        return reply.code(503).send({ status: 503, message: 'Service unavailable' });
      }
      return reply.code(201).send('');
    }
    m = /^\/rest\/posts\/(.+)$/.exec(c.path);
    if (m) {
      const p = this.posts.get(decodeURIComponent(m[1]!));
      return p ? reply.send({ id: p.id, lifecycleState: p.lifecycleState, createdAt: p.createdAt, commentary: p.commentary }) : err(404, 'Post not found');
    }
    m = /^\/rest\/socialActions\/(.+)\/comments$/.exec(c.path);
    if (m && c.method === 'POST') {
      this.comments.push({ post: decodeURIComponent(m[1]!), text: body.message?.text });
      return reply.code(201).send({ id: `comment-${this.comments.length}` });
    }
    if (c.path === '/rest/organizationalEntityShareStatistics') {
      const raw = String(c.query.shares ?? c.query.ugcPosts ?? '');
      const target = decodeURIComponent(/^List\((.*)\)$/.exec(raw)?.[1] ?? '');
      if (!this.posts.has(target)) return reply.send({ elements: [] });
      return reply.send({ elements: [{ share: target, totalShareStatistics: this.stats }] });
    }
    return err(404, `no route ${c.method} ${c.path}`);
  }
}
