import { msg } from '../../i18n/index.js';
import { issue, validateAgainst } from '../validate.js';
import {
  ConnectorError,
  type Account, type Capabilities, type Connector, type ConnectorEnv, type Handle, type HealthResult, type Issue,
  type MediaItem, type MetricsResult, type NetworkComment, type PrepareResult, type Published, type PublishInput, type VerifyResult,
} from '../types.js';
import type { MetaClient } from './client.js';
import { describeSubscription, subscribe, unsubscribe } from './webhooks.js';

/**
 * Instagram publishing through the Instagram Graph API (the Facebook Login flavour).
 * Publishing is two calls: create a "container" from a file Meta downloads from a URL, then publish it.
 * Containers expire after 24 hours, so they are made shortly before the hour (see the brand's prepare lead).
 *
 * The limits here are the ones in Meta's public documentation (the IG User Media reference, checked 2026-10-02): Reels 3 s to
 * 15 min, up to 300 MB, 23 to 60 fps, MOV or MP4 with the moov atom at the front (the file profile sees to the last three);
 * Stories 3 to 60 s, up to 100 MB; carousels up to 10 items, pictures and videos mixed; pictures JPEG only. Meta's own pages
 * disagree with each other in places, so the daily cap is read from the account (content_publishing_limit) instead of assumed.
 *
 * `is_ai_generated` (a self-disclosure of AI use) is a documented parameter of the container, "not available for carousel
 * children": it is sent on the Reel, the feed photo and the carousel itself, never on its items.
 *
 * A container's status is asked about at most once a minute, as Meta recommends ("once per minute, for no more than 5
 * minutes"); a video still processing after five looks is asked about every five minutes after that.
 */
const CAPS: Capabilities = {
  network: 'instagram',
  placements: [
    {
      id: 'reel', label: 'Reel', accepts: ['video'], items: { min: 1, max: 1 },
      aspect: { min: 0.1, max: 10 }, recommendedAspect: { min: 0.5, max: 0.6 }, durationSec: { min: 3, max: 900 },
      safeZones: { top: 0.1, bottom: 0.2, left: 0.05, right: 0.15 },
      profiles: { video: 'ig-reel' }, nativeScheduling: false,
    },
    {
      id: 'feed_image', label: 'Feed photo', accepts: ['image'], items: { min: 1, max: 1 },
      aspect: { min: 0.8, max: 1.91 }, safeZones: { top: 0.04, bottom: 0.04, left: 0, right: 0 },
      profiles: { image: 'ig-feed-image' }, nativeScheduling: false,
    },
    {
      // Meta's reference gives no length for a video in a carousel: it is held to a Reel's (3 s to 15 min) and validate() warns
      // past the 60 seconds feed videos were limited to.
      id: 'carousel', label: 'Carousel', accepts: ['image', 'video'], items: { min: 2, max: 10 },
      aspect: { min: 0.8, max: 1.91 }, durationSec: { min: 3, max: 900 }, profiles: { image: 'ig-feed-image', video: 'ig-reel' }, nativeScheduling: false,
    },
    {
      id: 'story', label: 'Story', accepts: ['image', 'video'], items: { min: 1, max: 1 },
      aspect: { min: 0.1, max: 10 }, recommendedAspect: { min: 0.5, max: 0.6 }, durationSec: { min: 3, max: 60 },
      safeZones: { top: 0.14, bottom: 0.2, left: 0.05, right: 0.05 },
      profiles: { image: 'ig-story-image', video: 'ig-story-video' }, nativeScheduling: false,
    },
  ],
  text: { maxChars: 2200, maxHashtags: 30, maxMentions: 20, previewCutoff: 125, firstComment: true, firstCommentMaxChars: 2200 },
  aiLabel: true,
  nativeScheduling: null,
};

const igUserId = (a: Account): string => a.providerData.igUserId ?? a.externalId;
/** The Page the account is linked to; its token is that Page's, so `me` is the Page when the id was not kept. */
const pageOf = (a: Account): string => String(a.providerData.pageId ?? 'me');

/** Waits between looks at a container: a minute for the first five (Meta's advice), then five minutes. */
const POLL_EVERY_SEC = 60;
const POLL_SLOW_SEC = 300;
const POLL_FAST_LOOKS = 5;
const nextLook = (h: Handle) => ((h.looks as number | undefined) ?? 0) < POLL_FAST_LOOKS ? POLL_EVERY_SEC : POLL_SLOW_SEC;
const mainOf = (input: PublishInput): MediaItem[] =>
  input.media.filter((m) => m.kind === 'video' || m.kind === 'image').sort((a, b) => a.position - b.position);

/** A post as the account's media (or stories) edge lists it. */
interface IgMedia { id: string; caption?: string; timestamp: string; media_type?: string; media_product_type?: string; permalink?: string }

/** Whether a listed post is the kind a placement makes: a Reel, a feed photo, a carousel, a story. */
function sameKind(placement: string, m: IgMedia): boolean {
  switch (placement) {
    case 'reel': return m.media_product_type === 'REELS' || (!m.media_product_type && m.media_type === 'VIDEO');
    case 'carousel': return m.media_type === 'CAROUSEL_ALBUM';
    case 'story': return m.media_product_type === 'STORY' || !m.media_product_type;
    default: return m.media_type === 'IMAGE' && m.media_product_type !== 'STORY';
  }
}

export function createInstagram(client: MetaClient): Connector {
  /** Asks the container where it is. Photos are often ready at once and may not report a status at all. */
  async function status(containerId: string, token: string): Promise<{ state: 'ready' | 'pending' | 'expired'; }> {
    const s = await client.get<{ status_code?: string; status?: string }>(containerId, token, { fields: 'status_code,status' });
    switch (s.status_code) {
      case undefined:
      case 'FINISHED':
      case 'PUBLISHED':
        return { state: 'ready' };
      case 'IN_PROGRESS':
        return { state: 'pending' };
      case 'EXPIRED':
        return { state: 'expired' };
      default:
        throw new ConnectorError('file_rejected', `Instagram could not process the media: ${s.status ?? s.status_code}`, { detail: s });
    }
  }

  async function createChild(ig: string, token: string, m: MediaItem): Promise<string> {
    const r = await client.post<{ id: string }>(`${ig}/media`, token, m.kind === 'video'
      ? { is_carousel_item: true, media_type: 'VIDEO', video_url: m.url }
      : { is_carousel_item: true, image_url: m.url });
    return r.id;
  }

  const connector: Connector = {
    network: 'instagram',
    provider: 'meta',

    capabilities: () => CAPS,

    defaultPlacement({ pieceKind, format, media }) {
      if (media.some((m) => m.kind === 'pdf')) return null;
      if (pieceKind === 'story') return 'story';
      if (format === 'carousel') return 'carousel';
      if (media.some((m) => m.kind === 'video')) return 'reel';
      if (media.some((m) => m.kind === 'image')) return 'feed_image';
      return null;
    },

    validate(input): Issue[] {
      const issues = validateAgainst(CAPS, input);
      if (input.placement === 'story' && input.text.trim()) {
        issues.push(issue('warning', 'story.text', {}, 'text'));
      }
      if (input.placement === 'carousel') {
        for (const m of mainOf(input)) {
          if (m.kind === 'video' && m.durationMs && m.durationMs > 60_000) {
            issues.push(issue('warning', 'carousel.video.length', { name: m.name, seconds: String(Math.round(m.durationMs / 1000)) }, 'media'));
          }
        }
      }
      return issues;
    },

    async prepare(input, account, handle: Handle, env: ConnectorEnv): Promise<PrepareResult> {
      const token = (await env.token()).accessToken;
      const ig = igUserId(account);
      let h: Handle = { ...handle };
      const save = async () => env.persist(h);

      // The daily cap is read from the account, because Meta's pages quote two different numbers.
      if (!h.quotaChecked) {
        const q = await client.get<{ data?: { quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }[] }>(
          `${ig}/content_publishing_limit`, token, { fields: 'quota_usage,config' });
        const row = q.data?.[0];
        if (row?.config?.quota_total !== undefined && (row.quota_usage ?? 0) >= row.config.quota_total) {
          throw new ConnectorError('rate_limit',
            `This Instagram account has used its publishing limit (${row.quota_usage} of ${row.config.quota_total} in ${Math.round((row.config.quota_duration ?? 86400) / 3600)} h)`,
            { retryAfterSec: row.config.quota_duration ?? 3600, detail: q });
        }
        h = { ...h, quotaChecked: true };
        await save();
      }

      const main = mainOf(input);
      const cover = input.media.find((m) => m.kind === 'cover');
      const caption = input.text;
      const ai = input.aiGenerated ? { is_ai_generated: true } : {};

      // Step 1: make the container (for a carousel, one per item and then one for the carousel).
      if (input.placement === 'carousel') {
        if (!h.children) {
          const ids: string[] = [];
          for (const m of main) ids.push(await createChild(ig, token, m));
          h = { ...h, children: ids };
          await save();
        }
        if (!h.childrenReady) {
          for (const id of h.children as string[]) {
            const s = await status(id, token);
            if (s.state === 'expired') { h = { quotaChecked: true }; await save(); return { done: false, handle: h, retryAfterSec: 1 }; }
            if (s.state === 'pending') {
              const wait = nextLook(h);
              h = { ...h, looks: ((h.looks as number | undefined) ?? 0) + 1 };
              await save();
              return { done: false, handle: h, retryAfterSec: wait };
            }
          }
          h = { ...h, looks: 0 };
          h = { ...h, childrenReady: true };
          await save();
        }
        if (!h.containerId) {
          // The AI disclosure goes on the carousel itself: Meta does not take it on the items.
          const r = await client.post<{ id: string }>(`${ig}/media`, token, { media_type: 'CAROUSEL', children: (h.children as string[]).join(','), caption, ...ai });
          h = { ...h, containerId: r.id };
          await save();
        }
      } else if (!h.containerId) {
        const m = main[0]!;
        let form: Record<string, string | number | boolean | undefined>;
        if (input.placement === 'reel') {
          form = { media_type: 'REELS', video_url: m.url, caption, share_to_feed: input.options.shareToFeed !== false, cover_url: cover?.url, ...ai };
        } else if (input.placement === 'story') {
          form = m.kind === 'video' ? { media_type: 'STORIES', video_url: m.url } : { media_type: 'STORIES', image_url: m.url };
        } else {
          form = { image_url: m.url, caption, ...ai };
        }
        const r = await client.post<{ id: string }>(`${ig}/media`, token, form);
        h = { ...h, containerId: r.id };
        await save();
      }

      // Step 2: wait for Instagram to finish processing it. Videos take a while; the engine asks again later, no more than once a
      // minute (Meta's advice), and every five minutes once five looks have not been enough.
      const s = await status(h.containerId as string, token);
      if (s.state === 'expired') return { done: false, handle: { quotaChecked: true }, retryAfterSec: 1 };
      if (s.state === 'pending') {
        const wait = nextLook(h);
        h = { ...h, looks: ((h.looks as number | undefined) ?? 0) + 1 };
        await save();
        return { done: false, handle: h, retryAfterSec: wait };
      }
      return { done: true, handle: h };
    },

    async publish(input, account, handle: Handle, env: ConnectorEnv): Promise<Published> {
      const token = (await env.token()).accessToken;
      let h: Handle = { ...handle };
      let mediaId: string = h.mediaId;
      if (!mediaId) {
        // Written down BEFORE the call: if its answer is lost, the next try knows the post may exist, and `find` looks for it.
        if (!h.publishAttemptedAt) {
          h = { ...h, publishAttemptedAt: env.now().toISOString() };
          await env.persist(h);
        }
        const r = await client.post<{ id: string }>(`${igUserId(account)}/media_publish`, token, { creation_id: h.containerId });
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
          env.log.warn({ err: String(err) }, 'could not read the Instagram permalink');
        }
      }
      // The first comment is best effort: the post is already live, so a refused comment must not turn into a failure.
      if (input.firstComment && !h.commentId && !h.firstCommentError) {
        try {
          const c = await client.post<{ id: string }>(`${mediaId}/comments`, token, { message: input.firstComment });
          h = { ...h, commentId: c.id };
        } catch (err) {
          h = { ...h, firstCommentError: (err as Error).message };
          env.log.warn({ err: String(err) }, 'could not post the Instagram first comment');
        }
      }
      await env.persist(h);
      return { externalId: mediaId, url };
    },

    /**
     * Whether an earlier `media_publish` went through although its answer was lost. The container says so itself: its status_code
     * is PUBLISHED once it has been published, and FINISHED while it has not. Meta does not say which media it became, so that is
     * looked for among the account's latest posts (its stories, for a story): the same kind of post, made since a minute before the
     * attempt, with the same caption.
     */
    async find(input, account, handle: Handle, env: ConnectorEnv): Promise<Handle | null> {
      if (handle.mediaId) return handle;
      if (!handle.containerId) return null;
      const token = (await env.token()).accessToken;
      const c = await client.get<{ status_code?: string }>(handle.containerId as string, token, { fields: 'status_code' });
      if (c.status_code !== 'PUBLISHED') return null;
      const since = new Date(String(handle.publishAttemptedAt ?? new Date(input.scheduledAt.getTime() - 3600_000).toISOString())).getTime() - 60_000;
      const story = input.placement === 'story';
      const r = await client.get<{ data?: IgMedia[] }>(`${igUserId(account)}/${story ? 'stories' : 'media'}`, token, {
        fields: 'id,caption,timestamp,media_type,media_product_type,permalink', limit: 25,
      });
      const found = (r.data ?? [])
        .filter((m) => new Date(m.timestamp).getTime() >= since && sameKind(input.placement, m) && (story || (m.caption ?? '') === input.text))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0];
      if (!found) {
        throw new ConnectorError('unknown', "Instagram says this post was published, but it is not among the account's latest posts yet: it is looked for again before anything is sent.", {
          text: msg('connector.ig.publishedNotFound'),
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
        if (err instanceof ConnectorError && err.errorClass === 'file_rejected') return { visibility: 'unknown', note: 'Instagram does not return this post any more' };
        throw err;
      }
    },

    /** The top-level comments on a post made after `since`, oldest first (Instagram lists them newest first, in pages). */
    async listComments(_account, externalId, _handle, env, since): Promise<NetworkComment[]> {
      const token = (await env.token()).accessToken;
      const out: NetworkComment[] = [];
      let after: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await client.get<{ data?: { id: string; text?: string; timestamp: string; username?: string; from?: { id: string; username?: string }; parent_id?: string }[]; paging?: { cursors?: { after?: string }; next?: string } }>(
          `${externalId}/comments`, token, { fields: 'id,text,timestamp,username,from{id,username},parent_id', limit: 50, ...(after ? { after } : {}) });
        let reachedOlder = false;
        for (const c of r.data ?? []) {
          if (new Date(c.timestamp).getTime() <= since.getTime()) { reachedOlder = true; continue; }
          if (c.parent_id) continue; // a reply to a comment, not a comment on the post
          out.push({ id: c.id, authorId: c.from?.id ?? c.username ?? '', authorName: c.from?.username ?? c.username ?? '', text: c.text ?? '', createdAt: c.timestamp });
        }
        after = r.paging?.cursors?.after;
        if (reachedOlder || !r.paging?.next || !after) break;
      }
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    /** One private message to the author of a comment, in reply to it. Instagram allows one per comment, within 7 days of it. */
    async privateReply(account, commentId, text, env) {
      const token = (await env.token()).accessToken;
      const r = await client.postJson<{ message_id?: string }>(`${igUserId(account)}/messages`, token, { recipient: { comment_id: commentId }, message: { text } });
      return { messageId: r.message_id };
    },

    async fetchMetrics(_account, externalId, _handle, env, post): Promise<MetricsResult> {
      const token = (await env.token()).accessToken;
      // Each kind of post offers its own metrics, and one it does not offer fails the whole call: ask only for what it has.
      const metric = post.placement === 'reel' ? 'views,reach,likes,comments,saved,shares,ig_reels_avg_watch_time'
        : post.placement === 'story' ? 'views,reach,replies,shares,navigation'
        : 'views,reach,likes,comments,saved,shares';
      const r = await client.get<{ data?: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(`${externalId}/insights`, token, { metric });
      const v: Record<string, number> = {};
      for (const m of r.data ?? []) v[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
      return {
        common: {
          views: v.views, reach: v.reach, likes: v.likes, comments: v.comments ?? v.replies, shares: v.shares, saves: v.saved,
          ...(v.ig_reels_avg_watch_time !== undefined ? { avgWatchSeconds: v.ig_reels_avg_watch_time / 1000 } : {}),
        },
        raw: r,
        note: post.placement === 'story' ? "A story's figures can only be read for 24 hours" : 'Instagram can be up to 48 hours behind, and gives nothing per item of a carousel',
      };
    },

    async health(account, env): Promise<HealthResult> {
      const token = (await env.token()).accessToken;
      await client.get(igUserId(account), token, { fields: 'id,username' });
      const exp = account.providerData.dataAccessExpiresAt as string | undefined;
      return { valid: true, expiresAt: exp, note: await describeSubscription(client, pageOf(account), token, 'comments') };
    },

    // An Instagram account's comments reach the webhook only once the app is subscribed, through the Page it is linked to (its
    // token is the Page's), to the "comments" field.
    eventFields: ['comments'],
    async subscribeEvents(account, env) {
      const t = await env.token();
      return subscribe(client, pageOf(account), t.accessToken, ['comments'], t.scopes);
    },
    async unsubscribeEvents(account, env, keep) {
      await unsubscribe(client, pageOf(account), (await env.token()).accessToken, keep);
    },
  };
  return connector;
}
