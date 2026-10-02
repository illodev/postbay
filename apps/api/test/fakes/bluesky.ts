import { createHmac } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { FakeServer, readAll, type Call } from './base.js';

/**
 * A stand-in for a Bluesky server (sessions, blobs, records, posts) and its video service (served under /video). Written from
 * the AT Protocol documentation, not from the real service: it holds the rules our connector has to respect (300 graphemes,
 * blobs under about 1 MB, a service token for video, one record per key, post keys that are TIDs).
 *
 * The server signed in to is only the entrance (as bsky.social is): the account's repository lives on another server, named in the
 * DID document the session carries. The video service checks the audience of each service token the way the real one does: asking
 * about the allowance needs a token for the video service itself, sending a video needs one for the account's repository server.
 */
const jwt = (payload: Record<string, unknown>) => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b({ alg: 'HS256', typ: 'JWT' });
  const body = b(payload);
  return `${head}.${body}.${createHmac('sha256', 'fake').update(`${head}.${body}`).digest('base64url')}`;
};

export class FakeBluesky extends FakeServer {
  handle_ = 'lumen.bsky.social';
  did = 'did:plc:lumen';
  password = 'app-pass-1234';
  emailConfirmed = true;
  accessTokens = new Set<string>();
  refreshTokens = new Set<string>();
  /** Set to make the stored renewal token stop working (about two months after it was made). */
  refreshExpired = false;
  /** Set to make every session call fail as if the app password had been revoked. */
  revoked = false;
  accessLifetimeSec = 7200;
  blobs: { size: number; mime: string }[] = [];
  records = new Map<string, { uri: string; cid: string; value: any }>();
  jobs = new Map<string, { polls: number; name: string; bytes: number }>();
  videoPolls = 1;
  rejectVideoWith: string | null = null;
  canUploadVideo = true;
  known: Record<string, string> = { 'bob.bsky.social': 'did:plc:bob' };
  counts: Record<string, number> = { likeCount: 7, replyCount: 2, repostCount: 1, quoteCount: 1 };
  serviceTokens: { token: string; aud: string; lxm: string }[] = [];
  /** The account's own repository server, as its DID document names it. */
  pdsEndpoint = 'https://morel.us-east.host.bsky.network';
  private n = 0;

  /** A key the server makes up when it is not given one: a TID from the clock. */
  private tid() {
    let v = (BigInt(this.now()) * 1000n + BigInt(++this.n)) << 10n;
    let out = '';
    for (let i = 0; i < 13; i++) { out = '234567abcdefghijklmnopqrstuvwxyz'[Number(v & 31n)]! + out; v >>= 5n; }
    return out;
  }

  private didWeb(url: string) {
    return `did:web:${new URL(url).host.replace(':', '%3A')}`;
  }

  private didDoc() {
    return {
      '@context': ['https://www.w3.org/ns/did/v1'], id: this.did, alsoKnownAs: [`at://${this.handle_}`],
      service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: this.pdsEndpoint }],
    };
  }

  private session() {
    const exp = Math.floor(this.now() / 1000) + this.accessLifetimeSec;
    const accessJwt = jwt({ exp, sub: this.did, scope: 'com.atproto.appPassPrivileged', jti: String(++this.n) });
    const refreshJwt = `refresh-${++this.n}`;
    this.accessTokens.add(accessJwt);
    this.refreshTokens.add(refreshJwt);
    return { accessJwt, refreshJwt, did: this.did, didDoc: this.didDoc(), handle: this.handle_, emailConfirmed: this.emailConfirmed };
  }

  async handle(c: Call, req: FastifyRequest, reply: FastifyReply) {
    const bearer = String(c.headers.authorization ?? '').replace(/^Bearer /, '');
    const err = (status: number, error: string, message: string) => reply.code(status).send({ error, message });
    const body = (c.body ?? {}) as Record<string, any>;
    const video = c.path.startsWith('/video/');
    const nsid = c.path.replace(/^\/video/, '').replace(/^\/xrpc\//, '');

    if (nsid === 'com.atproto.server.createSession') {
      if (this.revoked || body.password !== this.password || ![this.handle_, this.did].includes(body.identifier)) {
        return err(401, 'AuthenticationRequired', 'Invalid identifier or password');
      }
      return reply.send(this.session());
    }
    if (nsid === 'com.atproto.server.refreshSession') {
      if (this.revoked || this.refreshExpired || !this.refreshTokens.has(bearer)) return err(400, 'ExpiredToken', 'Token has expired');
      this.refreshTokens.delete(bearer);
      return reply.send(this.session());
    }

    if (video) {
      // Asking about a job is public; sending a video and asking about the allowance need a token made for the video service.
      const svc = this.serviceTokens.find((t) => t.token === bearer);
      if (!svc && nsid !== 'app.bsky.video.getJobStatus') { await readAll(req); return err(401, 'AuthenticationRequired', 'Invalid service token'); }
      if (nsid === 'app.bsky.video.getUploadLimits') {
        if (svc!.aud !== this.didWeb(this.url) || svc!.lxm !== 'app.bsky.video.getUploadLimits') return err(401, 'BadJwtAudience', 'jwt audience does not match service did');
        return reply.send({ canUpload: this.canUploadVideo, remainingDailyVideos: this.canUploadVideo ? 5 : 0, remainingDailyBytes: 1e9, message: this.canUploadVideo ? undefined : 'You have uploaded the most videos allowed today' });
      }
      if (nsid === 'app.bsky.video.uploadVideo') {
        if (svc?.lxm !== 'com.atproto.repo.uploadBlob') { await readAll(req); return err(400, 'InvalidRequest', 'Wrong lxm'); }
        // The video is written to the account's repository, so the token must be made out to that server, not to the entrance.
        if (svc.aud !== this.didWeb(this.pdsEndpoint)) { await readAll(req); return err(401, 'BadJwtAudience', 'jwt audience does not match service did'); }
        const bytes = (await readAll(req)).length;
        const jobId = this.id('job');
        this.jobs.set(jobId, { polls: 0, name: c.query.name ?? '', bytes });
        return reply.send({ jobId, did: c.query.did, state: 'JOB_STATE_CREATED' });
      }
      if (nsid === 'app.bsky.video.getJobStatus') {
        const job = this.jobs.get(c.query.jobId ?? '');
        if (!job) return err(404, 'NotFound', 'No such job');
        job.polls++;
        if (this.rejectVideoWith) return reply.send({ jobStatus: { jobId: c.query.jobId, state: 'JOB_STATE_FAILED', error: 'VideoRejected', message: this.rejectVideoWith } });
        if (job.polls <= this.videoPolls) return reply.send({ jobStatus: { jobId: c.query.jobId, state: 'JOB_STATE_PROCESSING', progress: 40 } });
        return reply.send({ jobStatus: { jobId: c.query.jobId, state: 'JOB_STATE_COMPLETED', blob: { $type: 'blob', ref: { $link: `bafyvideo${job.polls}` }, mimeType: 'video/mp4', size: job.bytes } } });
      }
      return err(404, 'MethodNotImplemented', nsid);
    }

    if (nsid === 'com.atproto.identity.resolveHandle') {
      const did = this.known[c.query.handle ?? ''];
      return did ? reply.send({ did }) : err(400, 'InvalidRequest', 'Unable to resolve handle');
    }

    // Everything below needs a session.
    if (this.revoked || !this.accessTokens.has(bearer)) {
      if (req.body && typeof (req.body as any).resume === 'function') (req.body as any).resume();
      return err(401, 'InvalidToken', 'Invalid token');
    }
    if (nsid === 'com.atproto.server.getSession') return reply.send({ did: this.did, didDoc: this.didDoc(), handle: this.handle_, emailConfirmed: this.emailConfirmed });
    if (nsid === 'com.atproto.server.getServiceAuth') {
      const token = `svc-${++this.n}`;
      this.serviceTokens.push({ token, aud: c.query.aud ?? '', lxm: c.query.lxm ?? '' });
      return reply.send({ token });
    }
    if (nsid === 'com.atproto.repo.uploadBlob') {
      const bytes = await readAll(req);
      if (bytes.length > 1_000_000) return err(400, 'BlobTooLarge', 'This file is too large; the limit is 1000000 bytes');
      this.blobs.push({ size: bytes.length, mime: String(c.headers['content-type']) });
      return reply.send({ blob: { $type: 'blob', ref: { $link: `bafyblob${this.blobs.length}` }, mimeType: c.headers['content-type'], size: bytes.length } });
    }
    if (nsid === 'com.atproto.repo.putRecord' || nsid === 'com.atproto.repo.createRecord') {
      const rkey = body.rkey ?? this.tid();
      const value = body.record ?? {};
      if (body.collection === 'app.bsky.feed.post') {
        // A post's key is a TID (the lexicon's "key": "tid"): 13 characters of the sortable base32.
        if (!/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(rkey)) return err(400, 'InvalidRequest', `Invalid record key: ${rkey} is not a TID`);
        const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        if ([...seg.segment(String(value.text ?? ''))].length > 300) return err(400, 'InvalidRequest', 'Record/text must not be longer than 300 graphemes');
        for (const fct of value.facets ?? []) {
          const bytes = Buffer.from(String(value.text));
          if (fct.index.byteEnd > bytes.length || fct.index.byteStart >= fct.index.byteEnd) return err(400, 'InvalidRequest', 'Bad facet range');
        }
      }
      const uri = `at://${body.repo}/${body.collection}/${rkey}`;
      this.records.set(uri, { uri, cid: `bafycid${this.records.size + 1}`, value });
      return reply.send({ uri, cid: this.records.get(uri)!.cid });
    }
    if (nsid === 'app.bsky.feed.getPosts') {
      const uris = ([] as string[]).concat((c.query.uris as any) ?? []);
      const posts = uris.map((u) => this.records.get(u)).filter(Boolean).map((r) => ({ uri: r!.uri, cid: r!.cid, record: r!.value, ...this.counts }));
      return reply.send({ posts });
    }
    return err(404, 'MethodNotImplemented', nsid);
  }
}
