import { validateAgainst } from '../validate.js';
import {
  ConnectorError,
  type Capabilities, type Connector, type ConnectorEnv, type Handle, type HealthResult, type Issue,
  type MediaItem, type MetricsResult, type PrepareResult, type Published, type PublishInput, type VerifyResult,
} from '../types.js';
import { isDuplicate, type XClient } from './client.js';
import { hasLink, weightedLength } from './text.js';

/**
 * X publishing through the v2 API. Pictures are uploaded in one call, a video in pieces (start, append, finish, then wait
 * for X to process it); the post is then one call with the ids of what was uploaded.
 *
 * X is pay-per-use: a post costs 0.015 USD, and 0.20 USD if it carries a link (13 times more), so a link in the text is a
 * warning that points at the first comment (a reply of the account's own) or the bio. Every read of one's own data costs
 * 0.001 USD too, which is why metrics are only read at the four fixed ages.
 *
 * X has no idempotency key. A repeated post of the same text is refused as a duplicate, which is how a lost answer is
 * told apart from a new post: see publish().
 */
const CAPS: Capabilities = {
  network: 'x',
  placements: [
    { id: 'images', label: 'Pictures', accepts: ['image'], items: { min: 1, max: 4 }, profiles: { image: 'x-image' }, nativeScheduling: false },
    {
      id: 'video', label: 'Video', accepts: ['video'], items: { min: 1, max: 1 }, durationSec: { min: 1, max: 140 },
      aspect: { min: 0.34, max: 3 }, profiles: { video: 'x-video' }, nativeScheduling: false,
    },
  ],
  text: { maxChars: 280, previewCutoff: 280, firstComment: true, firstCommentMaxChars: 280 },
  aiLabel: false,
  nativeScheduling: null,
  options: [
    { key: 'altText', label: 'Description of the picture (alt text)', type: 'text', maxLength: 1000, placements: ['images'], help: 'Read aloud to people who cannot see the picture. It is used for every picture of the post.' },
  ],
};

const COST_POST = 0.015;
const COST_LINK = 0.2;

const mainOf = (input: PublishInput): MediaItem[] =>
  input.media.filter((m) => m.kind === 'video' || m.kind === 'image').sort((a, b) => a.position - b.position);

const blob = (b: Buffer, type: string) => new Blob([new Uint8Array(b)], { type });

/** `length` bytes of a stored file from `start`, without reading the rest of it. */
async function readRange(env: ConnectorEnv, key: string, start: number, length: number): Promise<Buffer> {
  const { stream } = await env.open(key, start);
  const chunks: Buffer[] = [];
  let got = 0;
  for await (const c of stream) {
    const b = Buffer.from(c as Buffer);
    chunks.push(b);
    got += b.length;
    if (got >= length) break;
  }
  stream.destroy();
  return Buffer.concat(chunks).subarray(0, length);
}

export interface XOptions {
  /** Size of each piece of a video upload. */
  chunkBytes?: number;
}

export function createX(client: XClient, opts: XOptions = {}): Connector {
  const CHUNK = opts.chunkBytes ?? 4 * 1024 * 1024;
  const form = (fields: Record<string, string | Blob>, filename?: string) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === 'string') f.set(k, v);
      else f.set(k, v, filename);
    }
    return f;
  };

  async function uploadImage(token: string, m: MediaItem, env: ConnectorEnv): Promise<string> {
    const bytes = await readRange(env, m.key, 0, m.bytes + 1);
    const r = await client.request<{ data: { id: string } }>('/2/media/upload', token, {
      method: 'POST', body: form({ media: blob(bytes, m.mime), media_category: 'tweet_image' }, m.name),
    });
    return r.data.id;
  }

  async function userPostsContaining(token: string, userId: string, text: string, since: Date): Promise<string | null> {
    const r = await client.request<{ data?: { id: string; text: string; created_at?: string }[] }>(`/2/users/${userId}/tweets`, token, {
      query: { max_results: 10, 'tweet.fields': 'created_at' },
    });
    const found = (r.data ?? []).find((t) => t.text.trim() === text.trim() && (!t.created_at || new Date(t.created_at).getTime() >= since.getTime() - 60_000));
    return found?.id ?? null;
  }

  const connector: Connector = {
    network: 'x',
    provider: 'x',

    capabilities: () => CAPS,

    defaultPlacement({ media }) {
      if (media.some((m) => m.kind === 'video')) return 'video';
      if (media.some((m) => m.kind === 'image')) return 'images';
      return null;
    },

    validate(input): Issue[] {
      const issues = validateAgainst(CAPS, { ...input, text: '', firstComment: '' });
      const n = weightedLength(input.text);
      if (n > 280) issues.push({ severity: 'error', code: 'text.length', field: 'text', message: `X counts this text as ${n} of 280 (an address counts 23, and some characters, emoji among them, count two)` });
      const c = weightedLength(input.firstComment);
      if (c > 280) issues.push({ severity: 'error', code: 'firstComment.length', field: 'firstComment', message: `X counts the first comment as ${c} of 280` });
      if (hasLink(input.text)) {
        issues.push({
          severity: 'warning', code: 'x.link.cost', field: 'text',
          message: `A post with a link costs ${COST_LINK.toFixed(2)} USD on X instead of ${COST_POST.toFixed(3)} USD, 13 times more. Put the link in the first comment, or leave it for the bio.`,
        });
      }
      return issues;
    },

    async prepare(input, _account, handle: Handle, env: ConnectorEnv): Promise<PrepareResult> {
      const token = (await env.token()).accessToken;
      let h: Handle = { ...handle };
      const main = mainOf(input);
      const save = () => env.persist(h);

      if (input.placement === 'video') {
        const m = main[0]!;
        if (!h.mediaId) {
          if (!h.upload) {
            const r = await client.request<{ data: { id: string } }>('/2/media/upload/initialize', token, {
              method: 'POST', json: { media_type: m.mime, total_bytes: m.bytes, media_category: 'tweet_video' },
            });
            h = { ...h, upload: { id: r.data.id, next: 0 } };
            await save();
          }
          const up = h.upload as { id: string; next: number; finalized?: boolean };
          if (!up.finalized) {
            // Pieces are sent in order and counted as they are accepted, so a failure resumes from the first one not yet sent.
            const total = Math.ceil(m.bytes / CHUNK);
            for (let i = up.next; i < total; i++) {
              const piece = await readRange(env, m.key, i * CHUNK, CHUNK);
              await client.request(`/2/media/upload/${up.id}/append`, token, { method: 'POST', body: form({ media: blob(piece, m.mime), segment_index: String(i) }, m.name) });
              h = { ...h, upload: { ...up, next: i + 1 } };
              await save();
            }
            const fin = await client.request<{ data: { id: string; processing_info?: { state: string } } }>(`/2/media/upload/${up.id}/finalize`, token, { method: 'POST' });
            h = { ...h, upload: { ...up, next: total, finalized: true }, processing: fin.data.processing_info?.state ?? 'succeeded' };
            await save();
          }
          if (h.processing !== 'succeeded') {
            const st = await client.request<{ data: { processing_info?: { state: string; check_after_secs?: number; error?: { message?: string } } } }>('/2/media/upload', token, {
              query: { command: 'STATUS', media_id: (h.upload as { id: string }).id },
            });
            const p = st.data.processing_info;
            if (p?.state === 'failed') throw new ConnectorError('file_rejected', `X could not process the video: ${p.error?.message ?? 'unknown reason'}`, { detail: st });
            if (p && p.state !== 'succeeded') return { done: false, handle: h, retryAfterSec: p.check_after_secs ?? 5 };
            h = { ...h, processing: 'succeeded' };
          }
          h = { ...h, mediaId: (h.upload as { id: string }).id };
          await save();
        }
        return { done: true, handle: h };
      }

      const ids: string[] = Array.isArray(h.mediaIds) ? [...h.mediaIds] : [];
      for (let i = ids.length; i < main.length; i++) {
        ids.push(await uploadImage(token, main[i]!, env));
        h = { ...h, mediaIds: ids };
        await save(); // a picture already uploaded is not uploaded again if a later one fails
      }
      const alt = typeof input.options.altText === 'string' ? input.options.altText.slice(0, 1000) : '';
      if (alt && !h.altDone) {
        for (const id of ids) {
          try {
            await client.request('/2/media/metadata', token, { method: 'POST', json: { id, metadata: { alt_text: { text: alt } } } });
          } catch (err) {
            env.log.warn({ err: String(err) }, 'could not set the X alt text'); // the picture is still fine to post
          }
        }
        h = { ...h, altDone: true };
        await save();
      }
      return { done: true, handle: h };
    },

    async publish(input, account, handle: Handle, env: ConnectorEnv): Promise<Published> {
      const token = (await env.token()).accessToken;
      let h: Handle = { ...handle };
      const username = String(account.providerData.username ?? account.externalId);

      if (!h.postId) {
        // Written down BEFORE the call: if the answer is lost, the next try knows a post may already exist.
        if (!h.attemptedAt) {
          h = { ...h, attemptedAt: env.now().toISOString() };
          await env.persist(h);
        }
        const mediaIds = input.placement === 'video' ? [h.mediaId as string] : (h.mediaIds as string[]);
        try {
          const r = await client.request<{ data: { id: string } }>('/2/tweets', token, { method: 'POST', json: { text: input.text, media: { media_ids: mediaIds } } });
          h = { ...h, postId: r.data.id };
        } catch (err) {
          if (!isDuplicate(err)) throw err;
          // "Duplicate content" right after our own attempt can only mean that the first try went through.
          const found = await userPostsContaining(token, account.externalId, input.text, new Date(h.attemptedAt as string));
          if (!found) throw err;
          h = { ...h, postId: found, recovered: true };
        }
        await env.persist(h); // from here on a retry must not post a second time
      }

      if (input.firstComment && !h.replyId && !h.firstCommentError) {
        try {
          const r = await client.request<{ data: { id: string } }>('/2/tweets', token, { method: 'POST', json: { text: input.firstComment, reply: { in_reply_to_tweet_id: h.postId } } });
          h = { ...h, replyId: r.data.id };
        } catch (err) {
          h = { ...h, firstCommentError: (err as Error).message };
          env.log.warn({ err: String(err) }, 'could not post the X reply');
        }
        await env.persist(h);
      }
      return { externalId: h.postId as string, url: `https://x.com/${username}/status/${h.postId}` };
    },

    async verify(account, externalId, _handle, env): Promise<VerifyResult> {
      const token = (await env.token()).accessToken;
      const username = String(account.providerData.username ?? account.externalId);
      const url = `https://x.com/${username}/status/${externalId}`;
      try {
        const r = await client.request<{ data?: { id: string }; errors?: unknown[] }>(`/2/tweets/${externalId}`, token);
        return r.data?.id ? { visibility: 'public', url } : { visibility: 'unknown', note: 'X does not return this post any more' };
      } catch (err) {
        if (err instanceof ConnectorError && err.errorClass === 'file_rejected') return { visibility: 'unknown', note: 'X does not return this post any more' };
        throw err;
      }
    },

    async health(_account, env): Promise<HealthResult> {
      const t = await env.token();
      await client.request('/2/users/me', t.accessToken);
      return { valid: true };
    },

    async fetchMetrics(_account, externalId, _handle, env): Promise<MetricsResult> {
      const token = (await env.token()).accessToken;
      const r = await client.request<{ data?: { public_metrics?: Record<string, number>; organic_metrics?: Record<string, number> } }>(`/2/tweets/${externalId}`, token, {
        query: { 'tweet.fields': 'public_metrics,organic_metrics' },
      });
      const p = r.data?.public_metrics;
      if (!p) throw new ConnectorError('file_rejected', 'X does not return this post any more');
      const o = r.data?.organic_metrics;
      return {
        common: {
          views: o?.impression_count ?? p.impression_count, likes: p.like_count, comments: p.reply_count,
          shares: (p.retweet_count ?? 0) + (p.quote_count ?? 0), saves: p.bookmark_count,
        },
        raw: r,
        note: 'X counts impressions as views. Each read of a post costs 0.001 USD.',
      };
    },
  };
  return connector;
}

