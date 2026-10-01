import Fastify, { type FastifyInstance } from 'fastify';

/**
 * A stand-in for the Meta Graph API: Facebook Login, Pages, Instagram containers and publishing, scheduled Page posts,
 * Reels. It is written from how the API is documented to behave, so it proves OUR logic (the order of calls, retries,
 * error handling) but cannot prove that the real API still behaves this way. Anything it does not know answers 404.
 */
export interface FakePage {
  id: string;
  name: string;
  token: string;
  ig?: { id: string; username: string };
}

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
}

interface Failure {
  match: (c: Call) => boolean;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  times: number;
}

export class FakeMeta {
  app!: FastifyInstance;
  url = '';
  calls: Call[] = [];
  pages: FakePage[] = [{ id: '111', name: 'Lumen Coffee', token: 'page-token-111', ig: { id: '222', username: 'lumen.coffee' } }];
  grantedScopes = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'];
  /** Containers stay IN_PROGRESS for this many status reads before FINISHED. */
  processingPolls = 1;
  igQuota = { usage: 0, total: 50 };
  /** The clock scheduled Page posts are judged against. */
  now = () => Date.now();
  failures: Failure[] = [];
  private seq = 0;
  containers = new Map<string, { params: Record<string, string>; polls: number; state: string; ig: string }>();
  media = new Map<string, { params: Record<string, string>; comments: string[]; kind: 'ig' }>();
  posts = new Map<string, { page: string; kind: 'post' | 'video'; params: Record<string, string>; comments: string[] }>();
  reels = new Map<string, { page: string; fileUrl?: string; finished?: Record<string, string>; processingPolls: number }>();

  async start(): Promise<this> {
    this.app = Fastify({ logger: false });
    this.app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    this.app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
    this.app.all('/*', async (req, reply) => this.handle(req, reply));
    await this.app.listen({ port: 0, host: '127.0.0.1' });
    this.url = `http://127.0.0.1:${(this.app.server.address() as { port: number }).port}`;
    return this;
  }

  async stop() {
    await this.app.close();
  }

  /** Makes the next matching call(s) fail with the given response. */
  fail(match: (c: Call) => boolean, body: unknown, status = 400, times = 1, headers?: Record<string, string>) {
    this.failures.push({ match, body, status, times, headers });
  }

  err = (code: number, message: string, extra: Record<string, unknown> = {}) => ({ error: { message, type: 'OAuthException', code, ...extra } });

  callsTo(re: RegExp, method?: string) {
    return this.calls.filter((c) => re.test(c.path) && (!method || c.method === method));
  }

  private id(prefix: string) {
    return `${prefix}${++this.seq}`;
  }

  private tokenOk(token: string | undefined) {
    return !!token && (token === 'long-user' || this.pages.some((p) => p.token === token));
  }

  private async handle(req: any, reply: any) {
    const path = String(req.url).split('?')[0]!.replace(/^\/v[\d.]+\//, '').replace(/^\//, '');
    const body: Record<string, string> = req.body && typeof req.body === 'object' && !('pipe' in req.body) ? req.body : {};
    const call: Call = { method: req.method, path, query: req.query ?? {}, body, headers: req.headers };
    this.calls.push(call);

    const f = this.failures.find((x) => x.times > 0 && x.match(call));
    if (f) {
      f.times--;
      for (const [k, v] of Object.entries(f.headers ?? {})) reply.header(k, v);
      return reply.code(f.status).send(f.body);
    }
    const out = this.route(call, req);
    if (out && typeof out === 'object' && 'error' in (out as object) && !(out as any).data) return reply.code(400).send(out);
    return reply.send(out ?? { error: { message: `Unknown path ${path}`, code: 2500 } });
  }

  private param(c: Call, k: string) {
    return c.body[k] ?? c.query[k];
  }

  private route(c: Call, req: any): unknown {
    const token = this.param(c, 'access_token') ?? String(req.headers.authorization ?? '').replace(/^OAuth /, '');

    if (c.path === 'oauth/access_token') {
      if (this.param(c, 'grant_type') === 'fb_exchange_token') return { access_token: 'long-user', token_type: 'bearer', expires_in: 5184000 };
      if (!this.param(c, 'code') || this.param(c, 'code') === 'bad') return this.err(100, 'Invalid verification code format.');
      return { access_token: `short-${this.param(c, 'code')}`, token_type: 'bearer' };
    }
    if (c.path === 'debug_token') {
      return { data: { is_valid: true, scopes: this.grantedScopes, data_access_expires_at: Math.floor(this.now() / 1000) + 90 * 86400 } };
    }
    if (!this.tokenOk(token)) return this.err(190, 'Error validating access token: Session has expired');

    if (c.path === 'me/accounts') {
      return {
        data: this.pages.map((p) => ({
          id: p.id, name: p.name, access_token: p.token, tasks: ['CREATE_CONTENT', 'MANAGE'],
          ...(p.ig ? { instagram_business_account: { id: p.ig.id, username: p.ig.username } } : {}),
        })),
      };
    }

    let m: RegExpExecArray | null;
    // ── Instagram ──
    if ((m = /^(\d+)\/content_publishing_limit$/.exec(c.path))) {
      return { data: [{ quota_usage: this.igQuota.usage, config: { quota_total: this.igQuota.total, quota_duration: 86400 } }] };
    }
    if ((m = /^(\d+)\/media$/.exec(c.path)) && c.method === 'POST') {
      const id = this.id('c-');
      this.containers.set(id, { params: c.body, polls: 0, state: 'IN_PROGRESS', ig: m[1]! });
      return { id };
    }
    if ((m = /^(\d+)\/media_publish$/.exec(c.path))) {
      const cont = this.containers.get(c.body.creation_id ?? '');
      if (!cont) return this.err(100, 'Invalid creation_id');
      const id = this.id('m-');
      this.media.set(id, { params: cont.params, comments: [], kind: 'ig' });
      this.igQuota.usage++;
      return { id };
    }
    if ((m = /^(c-\d+)$/.exec(c.path))) {
      const cont = this.containers.get(m[1]!);
      if (!cont) return this.err(100, 'Unsupported get request');
      cont.polls++;
      const state = cont.state === 'IN_PROGRESS' && cont.polls > this.processingPolls ? 'FINISHED' : cont.state;
      return { id: m[1], status_code: state, status: state === 'ERROR' ? 'Error: Media upload has failed with error code 2207026' : state };
    }
    if ((m = /^(m-\d+)$/.exec(c.path))) {
      const med = this.media.get(m[1]!);
      return med ? { id: m[1], permalink: `https://www.instagram.com/p/${m[1]}/`, media_type: 'VIDEO' } : this.err(100, 'Object does not exist');
    }
    if ((m = /^(m-\d+)\/comments$/.exec(c.path))) {
      this.media.get(m[1]!)?.comments.push(c.body.message ?? '');
      return { id: this.id('cm-') };
    }
    // ── Facebook Pages ──
    if (c.method === 'DELETE' && (m = /^([\d_]+|v-\d+|ph-\d+)$/.exec(c.path))) {
      const existed = this.posts.delete(m[1]!);
      this.reels.delete(m[1]!);
      return existed ? { success: true } : this.err(100, 'Object does not exist', { error_subcode: 33 });
    }
    if ((m = /^(\d+)\/photos$/.exec(c.path))) {
      const id = this.id('ph-');
      const postId = `${m[1]}_${this.seq}`;
      this.posts.set(postId, { page: m[1]!, kind: 'post', params: c.body, comments: [] });
      return { id, post_id: postId };
    }
    if ((m = /^(\d+)\/feed$/.exec(c.path))) {
      const id = `${m[1]}_${this.id('')}`;
      this.posts.set(id, { page: m[1]!, kind: 'post', params: c.body, comments: [] });
      return { id };
    }
    if ((m = /^(\d+)\/videos$/.exec(c.path))) {
      const id = this.id('v-');
      this.posts.set(id, { page: m[1]!, kind: 'video', params: c.body, comments: [] });
      return { id };
    }
    if ((m = /^(\d+)\/video_reels$/.exec(c.path))) {
      if (c.body.upload_phase === 'start') {
        const id = this.id('v-');
        this.reels.set(id, { page: m[1]!, processingPolls: 1 });
        return { video_id: id, upload_url: `${this.url}/rupload/video-upload/v23.0/${id}` };
      }
      if (c.body.upload_phase === 'finish') {
        const r = this.reels.get(c.body.video_id ?? '');
        if (!r?.fileUrl) return this.err(100, 'Reel was not uploaded yet');
        r.finished = c.body;
        this.posts.set(c.body.video_id!, { page: m[1]!, kind: 'video', params: { ...c.body, file_url: r.fileUrl, published: c.body.video_state === 'PUBLISHED' ? 'true' : 'false' }, comments: [] });
        return { success: true };
      }
    }
    if ((m = /^rupload\/video-upload\/v[\d.]+\/(v-\d+)$/.exec(c.path))) {
      const r = this.reels.get(m[1]!);
      if (!r) return this.err(100, 'No such upload');
      r.fileUrl = String(req.headers.file_url ?? '');
      return { success: true };
    }
    if ((m = /^([\d_]+|v-\d+|ph-\d+)\/comments$/.exec(c.path))) {
      this.posts.get(m[1]!)?.comments.push(c.body.message ?? '');
      return { id: this.id('cm-') };
    }
    if ((m = /^(v-\d+|\d+_\d+)$/.exec(c.path))) {
      const p = this.posts.get(m[1]!);
      if (!p) return this.err(100, 'Object does not exist');
      const scheduled = Number(p.params.scheduled_publish_time ?? 0) * 1000;
      const live = p.params.published === 'true' || (scheduled > 0 && scheduled <= this.now());
      const reel = this.reels.get(m[1]!);
      let videoStatus = 'ready';
      if (p.kind === 'video' && reel && reel.processingPolls > 0) { reel.processingPolls--; videoStatus = 'processing'; }
      return {
        id: m[1], is_published: live, published: live, permalink_url: `/${p.page}/posts/${m[1]}`,
        ...(scheduled > 0 ? { scheduled_publish_time: scheduled / 1000 } : {}),
        status: { video_status: videoStatus },
      };
    }
    if (/^\d+$/.test(c.path)) {
      const ig = this.pages.find((p) => p.ig?.id === c.path);
      if (ig) return { id: c.path, username: ig.ig!.username };
      const page = this.pages.find((p) => p.id === c.path);
      if (page) return { id: c.path, name: page.name };
    }
    return null;
  }
}
