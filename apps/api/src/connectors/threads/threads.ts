import { goneNote } from '../notes.js';
import { msg } from '../../i18n/index.js';
import { validateAgainst } from '../validate.js';
import {
  ConnectorError,
  type Capabilities, type Connector, type ConnectorEnv, type Handle, type HealthResult, type Issue,
  type MediaItem, type MetricsResult, type PrepareResult, type Published, type PublishInput, type VerifyResult,
} from '../types.js';
import type { ThreadsClient } from './client.js';

/**
 * Threads publishing: like Instagram, a container is made from a file Threads downloads from a URL, then published. A
 * carousel is one container per item and one for the carousel. Text is limited to 500 characters; 250 posts a day.
 *
 * Every version in this app is made of files, so there is no "text only" placement: a post here always carries a picture
 * or a video.
 */
const CAPS: Capabilities = {
  network: 'threads',
  placements: [
    { id: 'image', label: 'Picture', accepts: ['image'], items: { min: 1, max: 1 }, profiles: { image: 'th-image' }, nativeScheduling: false },
    {
      id: 'video', label: 'Video', accepts: ['video'], items: { min: 1, max: 1 }, durationSec: { min: 1, max: 300 },
      profiles: { video: 'th-video' }, nativeScheduling: false,
    },
    { id: 'carousel', label: 'Carousel', accepts: ['image', 'video'], items: { min: 2, max: 20 }, profiles: { image: 'th-image', video: 'th-video' }, nativeScheduling: false },
  ],
  // The first comment is a reply to one's own post.
  text: { maxChars: 500, previewCutoff: 250, firstComment: true, firstCommentMaxChars: 500 },
  aiLabel: false,
  nativeScheduling: null,
};

const mainOf = (input: PublishInput): MediaItem[] =>
  input.media.filter((m) => m.kind === 'video' || m.kind === 'image').sort((a, b) => a.position - b.position);

export function createThreads(client: ThreadsClient): Connector {
  async function containerState(id: string, token: string): Promise<'ready' | 'pending' | 'expired'> {
    const s = await client.get<{ status?: string; error_message?: string }>(id, token, { fields: 'status,error_message' });
    switch (s.status) {
      case undefined:
      case 'FINISHED':
      case 'PUBLISHED':
        return 'ready';
      case 'IN_PROGRESS':
        return 'pending';
      case 'EXPIRED':
        return 'expired';
      default:
        throw new ConnectorError('file_rejected', `Threads could not process the media: ${s.error_message ?? s.status}`, { detail: s });
    }
  }

  const connector: Connector = {
    network: 'threads',
    provider: 'threads',

    capabilities: () => CAPS,

    defaultPlacement({ format, media }) {
      if (format === 'carousel' && media.filter((m) => m.kind === 'image' || m.kind === 'video').length > 1) return 'carousel';
      if (media.some((m) => m.kind === 'video')) return 'video';
      if (media.some((m) => m.kind === 'image')) return 'image';
      return null;
    },

    validate(input): Issue[] {
      return validateAgainst(CAPS, input);
    },

    async prepare(input, account, handle: Handle, env: ConnectorEnv): Promise<PrepareResult> {
      const token = (await env.token()).accessToken;
      const uid = account.externalId;
      let h: Handle = { ...handle };
      const save = () => env.persist(h);

      if (!h.quotaChecked) {
        const q = await client.get<{ data?: { quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }[] }>(
          `${uid}/threads_publishing_limit`, token, { fields: 'quota_usage,config' });
        const row = q.data?.[0];
        if (row?.config?.quota_total !== undefined && (row.quota_usage ?? 0) >= row.config.quota_total) {
          throw new ConnectorError('rate_limit',
            `This Threads account has used its publishing limit (${row.quota_usage} of ${row.config.quota_total} in ${Math.round((row.config.quota_duration ?? 86400) / 3600)} h)`,
            { retryAfterSec: row.config.quota_duration ?? 3600, detail: q });
        }
        h = { ...h, quotaChecked: true };
        await save();
      }

      const main = mainOf(input);
      const text = input.text || undefined;
      if (input.placement === 'carousel') {
        if (!h.children) {
          const ids: string[] = [];
          for (const m of main) {
            const r = await client.post<{ id: string }>(`${uid}/threads`, token, m.kind === 'video'
              ? { media_type: 'VIDEO', video_url: m.url, is_carousel_item: true }
              : { media_type: 'IMAGE', image_url: m.url, is_carousel_item: true });
            ids.push(r.id);
          }
          h = { ...h, children: ids };
          await save();
        }
        if (!h.childrenReady) {
          for (const id of h.children as string[]) {
            const s = await containerState(id, token);
            if (s === 'expired') { h = { quotaChecked: true }; await save(); return { done: false, handle: h, retryAfterSec: 1 }; }
            if (s === 'pending') return { done: false, handle: h, retryAfterSec: 10 };
          }
          h = { ...h, childrenReady: true };
          await save();
        }
        if (!h.containerId) {
          const r = await client.post<{ id: string }>(`${uid}/threads`, token, { media_type: 'CAROUSEL', children: (h.children as string[]).join(','), text });
          h = { ...h, containerId: r.id };
          await save();
        }
      } else if (!h.containerId) {
        const m = main[0]!;
        const r = await client.post<{ id: string }>(`${uid}/threads`, token, m.kind === 'video'
          ? { media_type: 'VIDEO', video_url: m.url, text }
          : { media_type: 'IMAGE', image_url: m.url, text });
        h = { ...h, containerId: r.id };
        await save();
      }

      const s = await containerState(h.containerId as string, token);
      if (s === 'expired') return { done: false, handle: { quotaChecked: true }, retryAfterSec: 1 };
      if (s === 'pending') return { done: false, handle: h, retryAfterSec: input.placement === 'image' ? 3 : 10 };
      return { done: true, handle: h };
    },

    async publish(input, account, handle: Handle, env: ConnectorEnv): Promise<Published> {
      const token = (await env.token()).accessToken;
      const uid = account.externalId;
      let h: Handle = { ...handle };
      let mediaId: string = h.mediaId;
      if (!mediaId) {
        // Written down BEFORE the call: if its answer is lost, the next try knows the post may exist, and `find` looks for it.
        if (!h.publishAttemptedAt) {
          h = { ...h, publishAttemptedAt: env.now().toISOString() };
          await env.persist(h);
        }
        const r = await client.post<{ id: string }>(`${uid}/threads_publish`, token, { creation_id: h.containerId });
        mediaId = r.id;
        h = { ...h, mediaId };
        await env.persist(h); // from here on a retry must not publish a second time
      }
      let url: string | undefined = h.permalink;
      if (!url) {
        try {
          const m = await client.get<{ permalink?: string }>(mediaId, token, { fields: 'permalink' });
          url = m.permalink;
          h = { ...h, permalink: url };
        } catch (err) {
          env.log.warn({ err: String(err) }, 'could not read the Threads permalink');
        }
      }
      // Best effort, like Instagram's: the post is live, so a refused reply must not turn into a failure.
      if (input.firstComment && !h.replyId && !h.firstCommentError) {
        try {
          const c = await client.post<{ id: string }>(`${uid}/threads`, token, { media_type: 'TEXT', text: input.firstComment, reply_to_id: mediaId });
          const p = await client.post<{ id: string }>(`${uid}/threads_publish`, token, { creation_id: c.id });
          h = { ...h, replyId: p.id };
        } catch (err) {
          h = { ...h, firstCommentError: (err as Error).message };
          env.log.warn({ err: String(err) }, 'could not post the Threads reply');
        }
      }
      await env.persist(h);
      return { externalId: mediaId, url };
    },

    /**
     * Whether an earlier `threads_publish` went through although its answer was lost: the container's status is PUBLISHED once it
     * has been. Threads does not say which post it became, so that is looked for among the account's latest threads: made since a
     * minute before the attempt, with the same text.
     */
    async find(input, account, handle: Handle, env: ConnectorEnv): Promise<Handle | null> {
      if (handle.mediaId) return handle;
      if (!handle.containerId) return null;
      const token = (await env.token()).accessToken;
      const c = await client.get<{ status?: string }>(handle.containerId as string, token, { fields: 'status' });
      if (c.status !== 'PUBLISHED') return null;
      const since = new Date(String(handle.publishAttemptedAt ?? new Date(input.scheduledAt.getTime() - 3600_000).toISOString())).getTime() - 60_000;
      const r = await client.get<{ data?: { id: string; text?: string; timestamp: string; permalink?: string }[] }>(`${account.externalId}/threads`, token, {
        fields: 'id,text,timestamp,permalink', limit: 25,
      });
      const found = (r.data ?? [])
        .filter((p) => new Date(p.timestamp).getTime() >= since && (p.text ?? '') === input.text)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0];
      if (!found) {
        throw new ConnectorError('unknown', "Threads says this post was published, but it is not among the account's latest posts yet: it is looked for again before anything is sent.", {
          text: msg('connector.threads.publishedNotFound'),
        });
      }
      return { ...handle, mediaId: found.id, ...(found.permalink ? { permalink: found.permalink } : {}), recovered: true };
    },

    async verify(_account, externalId, _handle, env): Promise<VerifyResult> {
      const token = (await env.token()).accessToken;
      try {
        const m = await client.get<{ id: string; permalink?: string }>(externalId, token, { fields: 'id,permalink' });
        return { visibility: 'public', url: m.permalink };
      } catch (err) {
        if (err instanceof ConnectorError && err.errorClass === 'file_rejected') return { visibility: 'unknown', ...goneNote('threads', 'post') };
        throw err;
      }
    },

    async health(account, env): Promise<HealthResult> {
      const t = await env.token();
      await client.get('me', t.accessToken, { fields: 'id,username' });
      return { valid: true, expiresAt: t.expiresAt };
    },

    async fetchMetrics(_account, externalId, _handle, env): Promise<MetricsResult> {
      const token = (await env.token()).accessToken;
      const r = await client.get<{ data?: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(
        `${externalId}/insights`, token, { metric: 'views,likes,replies,reposts,quotes,shares' });
      const v: Record<string, number> = {};
      for (const m of r.data ?? []) v[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
      return {
        common: {
          views: v.views, likes: v.likes, comments: v.replies,
          // Threads counts reposts and quotes apart from shares: together they are how far the post was passed on.
          shares: (v.shares ?? 0) + (v.reposts ?? 0) + (v.quotes ?? 0),
        },
        raw: r,
        note: 'Threads gives no reach figure',
      };
    },
  };
  return connector;
}

