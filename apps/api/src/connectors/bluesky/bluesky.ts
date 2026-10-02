import { goneNote } from '../notes.js';
import { issue, networkName, validateAgainst } from '../validate.js';
import {
  ConnectorError,
  type Account, type Capabilities, type Connector, type ConnectorEnv, type Handle, type HealthResult, type Issue,
  type MediaItem, type MetricsResult, type PrepareResult, type Published, type PublishInput, type VerifyResult,
} from '../types.js';
import { didWebOf, pdsEndpointOf, tidFor, type BlueskyClient } from './client.js';
import { facetsFor, graphemes, mentionedHandles } from './richtext.js';

/**
 * Bluesky publishing through the AT Protocol. A post is a record in the account's repository; pictures are uploaded as blobs
 * first and videos go through Bluesky's video service. There is no scheduling and no way to flag AI content.
 *
 * Posts are written with a record key (a TID, as Bluesky expects for posts) made from the publication and its time, and kept in the
 * handle, so a repeated step writes the same record again instead of a second post.
 */
const CAPS: Capabilities = {
  network: 'bluesky',
  placements: [
    { id: 'images', label: 'Pictures', accepts: ['image'], items: { min: 1, max: 4 }, profiles: { image: 'bsky-image' }, nativeScheduling: false },
    {
      id: 'video', label: 'Video', accepts: ['video'], items: { min: 1, max: 1 }, durationSec: { min: 1, max: 180 },
      profiles: { video: 'bsky-video' }, nativeScheduling: false,
    },
  ],
  // 300 graphemes, not characters: see graphemes().
  text: { maxChars: 300, unit: 'graphemes', previewCutoff: 300, firstComment: true, firstCommentMaxChars: 300 },
  aiLabel: false,
  nativeScheduling: null,
  options: [
    { key: 'altText', label: 'Description of the picture (alt text)', type: 'text', maxLength: 1000, placements: ['images'], help: 'Read aloud to people who cannot see the picture. It is used for every picture of the post.' },
  ],
};

const mainOf = (input: PublishInput): MediaItem[] =>
  input.media.filter((m) => m.kind === 'video' || m.kind === 'image').sort((a, b) => a.position - b.position);

const pdsOf = (a: Account, client: BlueskyClient) => String(a.providerData.pds || client.cfg.pdsUrl).replace(/\/$/, '');
/** The post's key, and its reply's a second later (so the reply sorts after the post). */
const rkeyOf = (input: PublishInput, reply = false) =>
  tidFor(new Date(input.scheduledAt.getTime() + (reply ? 1000 : 0)), `${input.publicationId}${reply ? ':reply' : ''}`);

/**
 * The video service is a separate service with its own idea of who may call it. A refusal from it says nothing about the account's
 * own connection (the session is fine: the server gave the service token), so it must not ask for the account to be connected again.
 */
function videoServiceError(err: unknown): unknown {
  if (err instanceof ConnectorError && err.errorClass === 'auth') {
    return new ConnectorError('unsupported', `Bluesky's video service refused the upload (${err.message.replace(/ \(Bluesky no longer accepts this connection\)$/, '')}). The account's connection itself is fine; a person can post this video in Bluesky.`, { httpStatus: err.httpStatus, detail: err.detail });
  }
  return err;
}

async function readAll(env: ConnectorEnv, key: string): Promise<Buffer> {
  const { stream } = await env.open(key, 0);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

export function createBluesky(client: BlueskyClient): Connector {
  async function uploadBlob(pds: string, token: string, bytes: Buffer, mime: string): Promise<unknown> {
    const r = await client.xrpc<{ blob: unknown }>(pds, 'com.atproto.repo.uploadBlob', { token, body: bytes as unknown as BodyInit, headers: { 'content-type': mime } });
    return r.blob;
  }

  /**
   * The DID of the server the account's repository is on. bsky.social is only the entrance: each account lives on a server of its
   * own (*.host.bsky.network), named in its DID document, and that server is who the video service writes the video to.
   */
  async function repoServerDid(account: Account, pds: string, token: string): Promise<string> {
    let endpoint = account.providerData.pdsEndpoint as string | undefined;
    if (!endpoint) {
      const s = await client.xrpc<{ didDoc?: unknown }>(pds, 'com.atproto.server.getSession', { token });
      endpoint = pdsEndpointOf(s.didDoc) ?? pds;
    }
    return didWebOf(endpoint);
  }

  /**
   * A video goes to the video service with a token the account's server signs for it: the audience is the account's own repository
   * server (the service writes the video there), and the method is uploadBlob. The service answers with a job to ask about.
   */
  async function startVideoJob(account: Account, pds: string, token: string, m: MediaItem, env: ConnectorEnv): Promise<string> {
    const aud = await repoServerDid(account, pds, token);
    const exp = Math.floor(env.now().getTime() / 1000) + 30 * 60;
    const auth = await client.xrpc<{ token: string }>(pds, 'com.atproto.server.getServiceAuth', { token, query: { aud, lxm: 'com.atproto.repo.uploadBlob', exp } });
    const bytes = await readAll(env, m.key);
    try {
      const r = await client.xrpc<{ jobId: string }>(client.cfg.videoUrl, 'app.bsky.video.uploadVideo', {
        token: auth.token, query: { did: account.externalId, name: m.name }, body: bytes as unknown as BodyInit, headers: { 'content-type': m.mime }, timeoutMs: 30 * 60_000,
      });
      return r.jobId;
    } catch (err) {
      throw videoServiceError(err);
    }
  }

  const connector: Connector = {
    network: 'bluesky',
    provider: 'bluesky',

    capabilities: () => CAPS,

    defaultPlacement({ media }) {
      if (media.some((m) => m.kind === 'video')) return 'video';
      if (media.some((m) => m.kind === 'image')) return 'images';
      return null;
    },

    validate(input, account): Issue[] {
      // The shared checks count characters; Bluesky counts graphemes, so the text is checked here instead.
      const issues = validateAgainst(CAPS, { ...input, text: '', firstComment: '' });
      const n = graphemes(input.text);
      if (n > CAPS.text.maxChars) issues.push(issue('error', 'text.length', { count: String(n), network: networkName('bluesky'), max: String(CAPS.text.maxChars) }, 'text'));
      const c = graphemes(input.firstComment);
      if (c > CAPS.text.maxChars) issues.push(issue('error', 'firstComment.length', { count: String(c), network: networkName('bluesky'), max: String(CAPS.text.maxChars) }, 'firstComment'));
      if (input.placement === 'video' && account.providerData.emailConfirmed === false) {
        issues.push(issue('error', 'bluesky.email', {}, 'placement'));
      }
      return issues;
    },

    async prepare(input, account, handle: Handle, env: ConnectorEnv): Promise<PrepareResult> {
      const token = (await env.token()).accessToken;
      const pds = pdsOf(account, client);
      let h: Handle = { ...handle };
      const main = mainOf(input);

      if (input.placement === 'video') {
        const m = main[0]!;
        if (!h.blob) {
          if (!h.jobId) {
            // The daily allowance for video is asked first, so a refusal is a wait and not a failure after an upload. This question is
            // addressed to the video service itself (did:web:video.bsky.app), unlike the upload.
            const svc = await client.xrpc<{ token: string }>(pds, 'com.atproto.server.getServiceAuth', {
              token, query: { aud: didWebOf(client.cfg.videoUrl), lxm: 'app.bsky.video.getUploadLimits', exp: Math.floor(env.now().getTime() / 1000) + 600 },
            });
            let lim: { canUpload?: boolean; message?: string; error?: string };
            try {
              lim = await client.xrpc(client.cfg.videoUrl, 'app.bsky.video.getUploadLimits', { token: svc.token });
            } catch (err) {
              throw videoServiceError(err);
            }
            if (lim.canUpload === false) throw new ConnectorError('rate_limit', lim.message ?? lim.error ?? 'Bluesky will not take another video from this account today', { retryAfterSec: 3600 });
            h = { ...h, jobId: await startVideoJob(account, pds, token, m, env) };
            await env.persist(h);
          }
          let st: { jobStatus: { state: string; blob?: unknown; error?: string; message?: string } };
          try {
            st = await client.xrpc(client.cfg.videoUrl, 'app.bsky.video.getJobStatus', { query: { jobId: h.jobId as string } });
          } catch (err) {
            throw videoServiceError(err);
          }
          const s = st.jobStatus;
          if (s.state === 'JOB_STATE_FAILED') throw new ConnectorError('file_rejected', `Bluesky could not process the video: ${s.message ?? s.error ?? 'unknown reason'}`, { detail: s });
          if (s.state !== 'JOB_STATE_COMPLETED' || !s.blob) return { done: false, handle: h, retryAfterSec: 10 };
          h = { ...h, blob: s.blob };
          await env.persist(h);
        }
        return { done: true, handle: h };
      }

      const blobs: unknown[] = Array.isArray(h.blobs) ? [...h.blobs] : [];
      for (let i = blobs.length; i < main.length; i++) {
        blobs.push(await uploadBlob(pds, token, await readAll(env, main[i]!.key), main[i]!.mime));
        h = { ...h, blobs };
        await env.persist(h); // an upload is not repeated if a later one fails
      }
      return { done: true, handle: h };
    },

    async publish(input, account, handle: Handle, env: ConnectorEnv): Promise<Published> {
      const token = (await env.token()).accessToken;
      const pds = pdsOf(account, client);
      const did = account.externalId;
      let h: Handle = { ...handle };
      const main = mainOf(input);
      // The key is kept before the record is written, so whatever happens to the answer, a repeat writes the same record.
      if (!h.rkey) {
        h = { ...h, rkey: rkeyOf(input) };
        await env.persist(h);
      }
      const rkey = h.rkey as string;

      if (!h.uri) {
        const mentions: Record<string, string> = {};
        for (const handleName of mentionedHandles(input.text)) {
          try {
            const r = await client.xrpc<{ did: string }>(pds, 'com.atproto.identity.resolveHandle', { query: { handle: handleName } });
            mentions[handleName] = r.did;
          } catch {
            // A handle that does not resolve stays plain text.
          }
        }
        const alt = typeof input.options.altText === 'string' ? input.options.altText.slice(0, 1000) : '';
        const ratio = (m: MediaItem) => (m.width && m.height ? { aspectRatio: { width: m.width, height: m.height } } : {});
        const embed = input.placement === 'video'
          ? { $type: 'app.bsky.embed.video', video: h.blob, ...ratio(main[0]!), ...(alt ? { alt } : {}) }
          : { $type: 'app.bsky.embed.images', images: (h.blobs as unknown[]).map((image, i) => ({ alt, image, ...ratio(main[i]!) })) };
        const facets = facetsFor(input.text, mentions);
        const record = {
          $type: 'app.bsky.feed.post', text: input.text, createdAt: env.now().toISOString(), embed,
          ...(facets.length ? { facets } : {}),
        };
        // putRecord with the key kept for this publication: the same call twice leaves one post.
        const r = await client.xrpc<{ uri: string; cid: string }>(pds, 'com.atproto.repo.putRecord', {
          token, json: { repo: did, collection: 'app.bsky.feed.post', rkey, record, validate: true },
        });
        h = { ...h, uri: r.uri, cid: r.cid };
        await env.persist(h);
      }

      if (input.firstComment && !h.replyUri && !h.firstCommentError) {
        try {
          const facets = facetsFor(input.firstComment);
          const ref = { uri: h.uri, cid: h.cid };
          const r = await client.xrpc<{ uri: string }>(pds, 'com.atproto.repo.putRecord', {
            token, json: {
              repo: did, collection: 'app.bsky.feed.post', rkey: rkeyOf(input, true),
              record: { $type: 'app.bsky.feed.post', text: input.firstComment, createdAt: env.now().toISOString(), reply: { root: ref, parent: ref }, ...(facets.length ? { facets } : {}) },
            },
          });
          h = { ...h, replyUri: r.uri };
        } catch (err) {
          h = { ...h, firstCommentError: (err as Error).message };
          env.log.warn({ err: String(err) }, 'could not post the Bluesky reply');
        }
      }
      await env.persist(h);
      const handleName = String(account.providerData.handle ?? did);
      return { externalId: h.uri as string, url: `https://bsky.app/profile/${handleName}/post/${rkey}` };
    },

    async verify(account, externalId, _handle, env): Promise<VerifyResult> {
      const token = (await env.token()).accessToken;
      const r = await client.xrpc<{ posts?: { uri: string }[] }>(pdsOf(account, client), 'app.bsky.feed.getPosts', { token, query: { uris: externalId } });
      const handleName = String(account.providerData.handle ?? account.externalId);
      const rkey = externalId.split('/').pop();
      if (!r.posts?.length) return { visibility: 'unknown', ...goneNote('bluesky', 'post') };
      return { visibility: 'public', url: `https://bsky.app/profile/${handleName}/post/${rkey}` };
    },

    async health(account, env): Promise<HealthResult> {
      const t = await env.token();
      await client.xrpc(pdsOf(account, client), 'com.atproto.server.getSession', { token: t.accessToken });
      return { valid: true };
    },

    async fetchMetrics(account, externalId, _handle, env): Promise<MetricsResult> {
      const token = (await env.token()).accessToken;
      const r = await client.xrpc<{ posts?: { likeCount?: number; replyCount?: number; repostCount?: number; quoteCount?: number }[] }>(
        pdsOf(account, client), 'app.bsky.feed.getPosts', { token, query: { uris: externalId } });
      const p = r.posts?.[0];
      if (!p) throw new ConnectorError('file_rejected', 'Bluesky does not return this post any more');
      return {
        common: { likes: p.likeCount ?? 0, comments: p.replyCount ?? 0, shares: (p.repostCount ?? 0) + (p.quoteCount ?? 0) },
        raw: r,
        note: 'Bluesky gives no view or reach figures',
      };
    },
  };
  return connector;
}
