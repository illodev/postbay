import Fastify, { type FastifyInstance } from 'fastify';

/**
 * A stand-in for Google's OAuth token endpoint and the YouTube Data API, including the resumable upload protocol
 * (session address in `Location`, `Content-Range`, 308 with `Range` when asked how far an upload got).
 * As with the Meta fake, it proves our logic, not that the real service still behaves this way.
 */
export interface VideoRecord {
  id: string;
  snippet: Record<string, any>;
  status: Record<string, any>;
  bytes: number;
  uploaded: boolean;
}

export class FakeGoogle {
  app!: FastifyInstance;
  url = '';
  calls: { method: string; path: string; query: Record<string, string>; headers: Record<string, any> }[] = [];
  now = () => Date.now();
  channels = [{ id: 'UC-lumen', title: 'Lumen Coffee TV' }];
  /** Until Google audits the project, videos are forced private whatever is asked. */
  audited = false;
  revoked = false;
  statistics: Record<string, number> = { viewCount: 1234, likeCount: 56, commentCount: 7, favoriteCount: 0 };
  /** When it went up, as the Data API says it in a video's snippet. */
  publishedAt = '2026-09-01T10:00:00Z';
  /** What the YouTube Analytics API reports for each video, once it has any. */
  analytics = new Map<string, { estimatedMinutesWatched: number; averageViewDuration: number; views: number }>();
  /** Turn off to answer the way Google does for a token that was never given the Analytics permission. */
  analyticsAllowed = true;
  /** What the person agreed to when connecting. Google repeats this list in every token answer, the refreshes included. */
  grantedScope = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly';
  /** When set, every video reports being rejected for this reason. */
  rejection: string | null = null;
  /** How long after its publishAt YouTube actually makes a scheduled video public: it is not at the second. */
  publishDelayMs = 0;
  accessTokens = new Set<string>();
  refreshTokens = new Set<string>(['refresh-1']);
  videos = new Map<string, VideoRecord>();
  private sessions = new Map<string, { size: number; received: number; chunks: Buffer[]; meta: { snippet: any; status: any }; contentType: string }>();
  /** Drop the connection after this many bytes of the next upload body, to exercise resuming. */
  dropAfterBytes: number | null = null;
  failures: { match: (path: string, method: string) => boolean; status: number; body: unknown; times: number }[] = [];
  private seq = 0;
  tokenSeq = 0;

  async start(): Promise<this> {
    this.app = Fastify({ logger: false, bodyLimit: 512 * 1024 * 1024 });
    this.app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    this.app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
    this.app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error); }
    });
    this.app.all('/*', async (req, reply) => this.handle(req, reply));
    await this.app.listen({ port: 0, host: '127.0.0.1' });
    this.url = `http://127.0.0.1:${(this.app.server.address() as { port: number }).port}`;
    return this;
  }

  async stop() {
    await this.app.close();
  }

  fail(match: (path: string, method: string) => boolean, body: unknown, status = 403, times = 1) {
    this.failures.push({ match, body, status, times });
  }

  quotaError = () => ({ error: { code: 403, message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }] } });

  private newAccessToken() {
    const t = `access-${++this.tokenSeq}`;
    this.accessTokens.add(t);
    return t;
  }

  private async handle(req: any, reply: any) {
    const path = String(req.url).split('?')[0]!;
    this.calls.push({ method: req.method, path, query: req.query ?? {}, headers: req.headers });
    const f = this.failures.find((x) => x.times > 0 && x.match(path, req.method));
    if (f) {
      f.times--;
      if (req.body && typeof req.body.resume === 'function') req.body.resume();
      return reply.code(f.status).send(f.body);
    }

    if (path === '/token') {
      const b = req.body as Record<string, string>;
      if (b.grant_type === 'authorization_code') {
        if (b.code === 'bad') return reply.code(400).send({ error: 'invalid_grant', error_description: 'Bad Request' });
        return reply.send({ access_token: this.newAccessToken(), refresh_token: b.code === 'norefresh' ? undefined : 'refresh-1', expires_in: 3600, scope: this.grantedScope, token_type: 'Bearer' });
      }
      if (b.grant_type === 'refresh_token') {
        if (this.revoked || !this.refreshTokens.has(b.refresh_token ?? '')) return reply.code(400).send({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        return reply.send({ access_token: this.newAccessToken(), expires_in: 3600, scope: this.grantedScope, token_type: 'Bearer' });
      }
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    }

    // Resumable upload bytes: the session address itself is the credential, as with the real service.
    let m = /^\/upload\/session\/(.+)$/.exec(path);
    if (m && req.method === 'PUT') return this.receiveUpload(m[1]!, req, reply);

    const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!this.accessTokens.has(auth)) {
      if (req.body && typeof req.body.resume === 'function') req.body.resume();
      return reply.code(401).send({ error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } });
    }

    if (path === '/v2/reports') return this.report(req, reply);
    if (path === '/youtube/v3/channels') {
      return reply.send({ items: this.channels.map((c) => ({ id: c.id, snippet: { title: c.title } })) });
    }
    if (path === '/upload/youtube/v3/videos' && req.method === 'POST' && req.query.uploadType === 'resumable') {
      const body = req.body as { snippet: any; status: any };
      // The Data API's own rules for the text: no < or > in either, a title of up to 100 characters, a description of up to 5,000 bytes.
      const title = String(body.snippet?.title ?? '');
      const description = String(body.snippet?.description ?? '');
      if (!title.trim() || title.length > 100 || /[<>]/.test(title)) {
        return reply.code(400).send({ error: { code: 400, message: 'The request metadata specifies an invalid or empty video title.', errors: [{ reason: 'invalidTitle', domain: 'youtube.video' }] } });
      }
      if (/[<>]/.test(description) || Buffer.byteLength(description, 'utf8') > 5000) {
        return reply.code(400).send({ error: { code: 400, message: 'The request metadata specifies an invalid video description.', errors: [{ reason: 'invalidDescription', domain: 'youtube.video' }] } });
      }
      if (body.status?.publishAt && body.status?.privacyStatus !== 'private') {
        return reply.code(400).send({ error: { code: 400, message: 'A video can be scheduled only while it is private.', errors: [{ reason: 'invalidPublishAt', domain: 'youtube.video' }] } });
      }
      const id = `sess-${++this.seq}`;
      this.sessions.set(id, { size: Number(req.headers['x-upload-content-length']), received: 0, chunks: [], meta: body, contentType: String(req.headers['x-upload-content-type']) });
      reply.header('location', `${this.url}/upload/session/${id}`);
      return reply.send('');
    }
    if (path === '/upload/youtube/v3/thumbnails/set') {
      if (req.body && typeof req.body.resume === 'function') req.body.resume();
      return reply.send({ items: [{}] });
    }
    if (path === '/youtube/v3/videos' && req.method === 'DELETE') {
      const existed = this.videos.delete(String(req.query.id));
      return existed ? reply.code(204).send() : reply.code(404).send({ error: { code: 404, message: 'Video not found', errors: [{ reason: 'videoNotFound' }] } });
    }
    if (path === '/youtube/v3/videos' && req.method === 'GET') {
      const v = this.videos.get(String(req.query.id));
      if (!v) return reply.send({ items: [] });
      // Counts come back as strings, as the real API sends them.
      const stats = String(req.query.part ?? '').includes('statistics') ? { statistics: Object.fromEntries(Object.entries(this.statistics).map(([k, n]) => [k, String(n)])) } : {};
      const snippet = String(req.query.part ?? '').includes('snippet') ? { snippet: { publishedAt: this.publishedAt } } : {};
      return reply.send({ items: [{ id: v.id, status: this.statusOf(v), ...stats, ...snippet }] });
    }
    return reply.code(404).send({ error: { code: 404, message: `Unknown path ${path}`, errors: [{ reason: 'notFound' }] } });
  }

  /**
   * The Analytics API's report, strict about what it is asked the way the real one is: the channel must be MINE, a video report is filtered to
   * one video and has the video dimension, dates are days and do not run backwards, and only known metrics are offered. Without the permission
   * it answers 403 insufficientPermissions. Rows come back as numbers, after the columns that name them.
   */
  private report(req: any, reply: any) {
    const q = req.query as Record<string, string>;
    const bad = (message: string) => reply.code(400).send({ error: { code: 400, message, errors: [{ reason: 'badRequest' }] } });
    if (!this.analyticsAllowed) return reply.code(403).send({ error: { code: 403, message: 'Insufficient Permission: Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } });
    if (q.ids !== 'channel==MINE') return bad('ids must be channel==MINE');
    const filter = /^video==([\w-]+)$/.exec(q.filters ?? '');
    if (!filter) return bad('filters must name one video: video==ID');
    if (q.dimensions !== 'video') return bad('a video report needs dimensions=video');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.startDate ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(q.endDate ?? '')) return bad('startDate and endDate are days: YYYY-MM-DD');
    if (q.startDate! > q.endDate!) return bad('startDate is after endDate');
    const metrics = String(q.metrics ?? '').split(',');
    const known = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained'];
    if (!metrics.every((m) => known.includes(m))) return bad('unknown metric');
    const a = this.analytics.get(filter[1]!);
    return reply.send({
      kind: 'youtubeAnalytics#resultTable',
      columnHeaders: [{ name: 'video', columnType: 'DIMENSION', dataType: 'STRING' }, ...metrics.map((name) => ({ name, columnType: 'METRIC', dataType: 'INTEGER' }))],
      rows: a ? [[filter[1], ...metrics.map((m) => (a as Record<string, number>)[m] ?? 0)]] : [],
    });
  }

  private statusOf(v: VideoRecord) {
    if (this.rejection) return { uploadStatus: 'rejected', rejectionReason: this.rejection, privacyStatus: 'private' };
    const s: Record<string, any> = { ...v.status, uploadStatus: v.uploaded ? 'processed' : 'uploaded' };
    // Not audited: always private. Audited: private until publishAt, then public.
    if (!this.audited) return { ...s, privacyStatus: 'private' };
    if (s.publishAt && new Date(s.publishAt).getTime() + this.publishDelayMs <= this.now()) return { ...s, privacyStatus: 'public', publishAt: undefined };
    return s;
  }

  private async receiveUpload(id: string, req: any, reply: any) {
    const s = this.sessions.get(id);
    if (!s) return reply.code(404).send({ error: { code: 404, message: 'Session not found' } });
    const range = String(req.headers['content-range'] ?? '');
    // "How far did you get?" — no body, Content-Range: bytes */total
    if (/^bytes \*\//.test(range)) {
      if (req.body && typeof req.body.resume === 'function') req.body.resume();
      if (s.received >= s.size) return reply.code(200).send(this.complete(id));
      if (s.received === 0) return reply.code(308).send('');
      return reply.code(308).header('range', `bytes=0-${s.received - 1}`).send('');
    }
    const start = (/^bytes (\d+)-/.exec(range)?.[1] ? Number(/^bytes (\d+)-/.exec(range)![1]) : 0);
    if (start !== s.received) return reply.code(400).send({ error: { code: 400, message: `Expected offset ${s.received}, got ${start}` } });
    const stream = req.body as NodeJS.ReadableStream;
    let dropped = false;
    const limit = this.dropAfterBytes;
    this.dropAfterBytes = null;
    await new Promise<void>((resolve) => {
      let got = 0;
      stream.on('data', (chunk: Buffer) => {
        s.chunks.push(chunk);
        s.received += chunk.length;
        got += chunk.length;
        if (limit !== null && got >= limit && !dropped) {
          dropped = true;
          req.raw.destroy(); // the connection dies mid-upload
          resolve();
        }
      });
      stream.on('end', () => resolve());
      stream.on('error', () => resolve());
      stream.on('close', () => resolve());
    });
    if (dropped) return;
    if (s.received >= s.size) return reply.code(200).send(this.complete(id));
    return reply.code(308).header('range', `bytes=0-${s.received - 1}`).send('');
  }

  private complete(sessionId: string) {
    const s = this.sessions.get(sessionId)!;
    const existing = [...this.videos.values()].find((v) => (v as any).session === sessionId);
    if (existing) return { id: existing.id, snippet: existing.snippet, status: existing.status };
    const id = `yt-${++this.seq}`;
    const rec = { id, snippet: s.meta.snippet, status: s.meta.status, bytes: s.received, uploaded: true, session: sessionId } as VideoRecord & { session: string };
    this.videos.set(id, rec);
    return { id, snippet: rec.snippet, status: rec.status };
  }
}
