import { english, msg, type Localized } from '../../i18n/index.js';
import { validateAgainst } from '../validate.js';
import {
  ConnectorError,
  type Account, type Capabilities, type Connector, type ConnectorEnv, type Handle, type HealthResult, type Issue,
  type MediaItem, type MetricsResult, type NetworkComment, type PrepareResult, type Published, type PublishInput, type VerifyResult,
} from '../types.js';
import type { MetaClient } from './client.js';
import { describeSubscription, subscribe, unsubscribe } from './webhooks.js';

/**
 * Facebook Page publishing through the Graph API with a Page token.
 *
 * Unlike Instagram, Facebook can hold a post and publish it by itself at a chosen time (10 minutes to 29 days ahead),
 * so everything is created ahead of time as a scheduled post and goes out even if this app is down at that hour.
 * When there is too little lead time left for that (the app was late), the post is made and published at once instead.
 *
 * As with the other connectors, the figures come from the public documentation.
 *
 * Commenting as the Page (the first comment) needs pages_manage_engagement; a refusal is kept and said in the post's history.
 * Photos of a scheduled album are uploaded as temporary (published=false, temporary=true), as Meta requires for photos used in a
 * scheduled post. Numbers come from each kind of object's own insights: a post's, a video's (total_video_*), a Reel's
 * (fb_reels_total_plays, post_impressions_unique, post_video_avg_time_watched…); a Video node has no `shares` field.
 */
const CAPS: Capabilities = {
  network: 'facebook',
  placements: [
    { id: 'photo', label: 'Photo post', accepts: ['image'], items: { min: 1, max: 1 }, profiles: { image: 'fb-photo' }, nativeScheduling: true },
    { id: 'photos', label: 'Photo album post', accepts: ['image'], items: { min: 2, max: 10 }, profiles: { image: 'fb-photo' }, nativeScheduling: true },
    { id: 'video', label: 'Video post', accepts: ['video'], items: { min: 1, max: 1 }, profiles: { video: 'fb-video' }, nativeScheduling: true },
    {
      id: 'reel', label: 'Reel', accepts: ['video'], items: { min: 1, max: 1 },
      aspect: { min: 0.3, max: 1.8 }, recommendedAspect: { min: 0.5, max: 0.6 }, durationSec: { min: 3, max: 90 },
      safeZones: { top: 0.1, bottom: 0.22, left: 0.05, right: 0.15 },
      profiles: { video: 'fb-reel' }, nativeScheduling: true,
    },
  ],
  text: { maxChars: 63206, previewCutoff: 477, firstComment: true, firstCommentMaxChars: 8000 },
  aiLabel: false,
  nativeScheduling: { minLeadMinutes: 10, maxLeadDays: 29 },
};

const MIN_NATIVE_LEAD_MS = 11 * 60_000; // a minute of margin over Meta's 10-minute minimum
const MAX_NATIVE_LEAD_MS = 29 * 86_400_000;

const mainOf = (input: PublishInput): MediaItem[] =>
  input.media.filter((m) => m.kind === 'video' || m.kind === 'image').sort((a, b) => a.position - b.position);

const absolute = (link?: string) => (link ? (link.startsWith('http') ? link : `https://www.facebook.com${link}`) : undefined);

type InsightsAnswer = { data?: { name: string; values?: { value: unknown }[]; total_value?: { value: unknown } }[] };
/** Each metric's lifetime value. Some are numbers, some (a Reel's social actions) are objects broken down by kind. */
const valuesOf = (r: InsightsAnswer): Record<string, unknown> => Object.fromEntries((r.data ?? []).map((m) => [m.name, m.values?.[0]?.value ?? m.total_value?.value]));
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : undefined);

export function createFacebook(client: MetaClient): Connector {
  /** Makes the post, either held for `when` (native scheduling) or live at once. Resumable step by step through the handle. */
  async function create(input: PublishInput, account: Account, h: Handle, env: ConnectorEnv, token: string, when: Date | null): Promise<Handle> {
    const page = account.externalId;
    const live = when === null;
    const unix = when ? Math.floor(when.getTime() / 1000) : undefined;
    const main = mainOf(input);
    const hold = live ? { published: true } : { published: false, scheduled_publish_time: unix, unpublished_content_type: 'SCHEDULED' };
    const save = async () => env.persist(h);

    switch (input.placement) {
      case 'photo': {
        if (!h.objectId) {
          const r = await client.post<{ id: string; post_id?: string }>(`${page}/photos`, token, { url: main[0]!.url, caption: input.text, ...hold });
          h = { ...h, objectId: r.post_id ?? r.id, objectType: 'post' };
          await save();
        }
        break;
      }
      case 'photos': {
        if (!h.photoIds) {
          const ids: string[] = [];
          // Unpublished photos to attach to the post. Meta: "If the photo is used in a scheduled post, temporary=true must be used."
          for (const m of main) ids.push((await client.post<{ id: string }>(`${page}/photos`, token, { url: m.url, published: false, ...(live ? {} : { temporary: true }) })).id);
          h = { ...h, photoIds: ids };
          await save();
        }
        if (!h.objectId) {
          const attached = Object.fromEntries((h.photoIds as string[]).map((id, i) => [`attached_media[${i}]`, JSON.stringify({ media_fbid: id })]));
          const r = await client.post<{ id: string }>(`${page}/feed`, token, { message: input.text, ...attached, ...hold });
          h = { ...h, objectId: r.id, objectType: 'post' };
          await save();
        }
        break;
      }
      case 'video': {
        if (!h.objectId) {
          const r = await client.post<{ id: string }>(`${page}/videos`, token, {
            file_url: main[0]!.url, description: input.text, title: typeof input.options.title === 'string' ? input.options.title : undefined, ...hold,
          });
          h = { ...h, objectId: r.id, objectType: 'video' };
          await save();
        }
        break;
      }
      case 'reel': {
        // Reels go in three phases: open an upload, tell Facebook where to fetch the file, then finish with the publishing state.
        if (!h.objectId) {
          const start = await client.post<{ video_id: string; upload_url: string }>(`${page}/video_reels`, token, { upload_phase: 'start' });
          h = { ...h, objectId: start.video_id, objectType: 'video', uploadUrl: start.upload_url };
          await save();
        }
        if (!h.reelUploaded) {
          await client.raw(h.uploadUrl as string, token, { file_url: main[0]!.url });
          h = { ...h, reelUploaded: true };
          await save();
        }
        if (!h.reelFinished) {
          await client.post(`${page}/video_reels`, token, {
            upload_phase: 'finish', video_id: h.objectId, description: input.text,
            video_state: live ? 'PUBLISHED' : 'SCHEDULED', scheduled_publish_time: live ? undefined : unix,
          });
          h = { ...h, reelFinished: true };
          await save();
        }
        break;
      }
      default:
        throw new ConnectorError('unsupported', `Facebook cannot publish "${input.placement}"`);
    }
    return h;
  }

  async function videoReady(id: string, token: string): Promise<'ready' | 'pending'> {
    const s = await client.get<{ status?: { video_status?: string } }>(id, token, { fields: 'status' });
    const st = s.status?.video_status;
    if (st === 'error') throw new ConnectorError('file_rejected', 'Facebook could not process the video', { detail: s });
    return st === undefined || st === 'ready' ? 'ready' : 'pending';
  }

  const connector: Connector = {
    network: 'facebook',
    provider: 'meta',

    capabilities: () => CAPS,

    defaultPlacement({ pieceKind, format, media }) {
      if (pieceKind === 'story') return null; // Page Stories are not supported by this connector yet: a person posts them
      if (media.some((m) => m.kind === 'pdf')) return null;
      if (format === 'carousel') return media.every((m) => m.kind === 'image' || m.kind === 'cover') ? 'photos' : null;
      if (media.some((m) => m.kind === 'video')) return format === '9:16' ? 'reel' : 'video';
      if (media.some((m) => m.kind === 'image')) return 'photo';
      return null;
    },

    validate(input): Issue[] {
      return validateAgainst(CAPS, input);
    },

    async prepare(input, account, handle: Handle, env: ConnectorEnv): Promise<PrepareResult> {
      const token = (await env.token()).accessToken;
      let h: Handle = { ...handle };
      if (!h.mode) {
        const lead = input.scheduledAt.getTime() - env.now().getTime();
        h = { ...h, mode: lead >= MIN_NATIVE_LEAD_MS && lead <= MAX_NATIVE_LEAD_MS ? 'native' : 'immediate', firstComment: input.firstComment || undefined };
        await env.persist(h);
      }
      if (h.mode === 'immediate') return { done: true, handle: h }; // too late to hold it: it is made and published in one go
      h = await create(input, account, h, env, token, input.scheduledAt);
      if (h.objectType === 'video' && (await videoReady(h.objectId as string, token)) === 'pending') {
        return { done: false, handle: h, retryAfterSec: 15 };
      }
      return { done: true, handle: h, nativeScheduled: true };
    },

    async publish(input, account, handle: Handle, env: ConnectorEnv): Promise<Published> {
      const token = (await env.token()).accessToken;
      let h: Handle = { ...handle };
      if (h.mode === 'immediate') {
        h = await create(input, account, h, env, token, null);
      }
      let url: string | undefined = h.permalink;
      if (!url) {
        try {
          const r = await client.get<{ permalink_url?: string }>(h.objectId as string, token, { fields: 'permalink_url' });
          url = absolute(r.permalink_url);
          h = { ...h, permalink: url };
        } catch (err) {
          env.log.warn({ err: String(err) }, 'could not read the Facebook permalink');
        }
      }
      await env.persist(h);
      return { externalId: h.objectId as string, url };
    },

    async verify(_account, externalId, handle: Handle, env: ConnectorEnv): Promise<VerifyResult> {
      const token = (await env.token()).accessToken;
      const isVideo = handle.objectType === 'video';
      const o = await client.get<{ is_published?: boolean; published?: boolean; scheduled_publish_time?: number; permalink_url?: string; status?: { video_status?: string } }>(
        externalId, token, { fields: isVideo ? 'published,scheduled_publish_time,permalink_url,status' : 'is_published,scheduled_publish_time,permalink_url' });
      const url = absolute(o.permalink_url);
      if (isVideo && o.status?.video_status === 'error') throw new ConnectorError('file_rejected', 'Facebook could not process the video', { detail: o });
      const live = isVideo ? o.published : o.is_published;
      if (!live) {
        if (isVideo && o.status?.video_status && o.status.video_status !== 'ready') return { visibility: 'processing', url };
        return { visibility: o.scheduled_publish_time ? 'scheduled' : 'private', url };
      }
      // Now it is live, post the first comment (a post that was held cannot take comments before this). Commenting as the Page
      // needs pages_manage_engagement: a refusal does not undo the post, but it is said, in the history, in words a person can act on.
      let next: Handle | undefined;
      let note: string | undefined;
      let noteText: Localized | undefined;
      if (handle.firstComment && !handle.commentId && !handle.firstCommentError) {
        try {
          const c = await client.post<{ id: string }>(`${externalId}/comments`, token, { message: handle.firstComment });
          next = { ...handle, commentId: c.id };
        } catch (err) {
          const permission = err instanceof ConnectorError && (err.errorClass === 'auth' || /permission|pages_manage_engagement/i.test(err.message));
          const said = (err as Error).message;
          noteText = permission ? msg('pub.firstComment.fbPermission', { error: said }) : msg('pub.firstComment.refused', { network: msg('network.facebook'), error: said });
          const message = english(noteText);
          next = { ...handle, firstCommentError: message, firstCommentErrorText: noteText };
          note = message;
          env.log.warn({ err: String(err) }, 'could not post the Facebook first comment');
        }
      }
      return { visibility: 'public', url, handle: next, ...(note ? { note, noteText } : {}) };
    },

    async discard(_account, handle, env): Promise<void> {
      const token = (await env.token()).accessToken;
      const ids = [handle.objectId, ...((handle.photoIds as string[] | undefined) ?? [])].filter((x): x is string => !!x);
      for (const id of ids) {
        try {
          await client.delete(id, token);
        } catch (err) {
          // Already gone is what we wanted.
          if (err instanceof ConnectorError && err.errorClass === 'file_rejected') continue;
          throw err;
        }
      }
    },

    /** The top-level comments on a post or video made after `since`, oldest first. */
    async listComments(_account, externalId, _handle, env, since): Promise<NetworkComment[]> {
      const token = (await env.token()).accessToken;
      const out: NetworkComment[] = [];
      let after: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await client.get<{ data?: { id: string; message?: string; created_time: string; from?: { id: string; name?: string } }[]; paging?: { cursors?: { after?: string }; next?: string } }>(
          `${externalId}/comments`, token, { fields: 'id,message,created_time,from{id,name}', filter: 'toplevel', order: 'reverse_chronological', limit: 50, ...(after ? { after } : {}) });
        let reachedOlder = false;
        for (const c of r.data ?? []) {
          if (new Date(c.created_time).getTime() <= since.getTime()) { reachedOlder = true; continue; }
          out.push({ id: c.id, authorId: c.from?.id ?? '', authorName: c.from?.name ?? '', text: c.message ?? '', createdAt: new Date(c.created_time).toISOString() });
        }
        after = r.paging?.cursors?.after;
        if (reachedOlder || !r.paging?.next || !after) break;
      }
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    /** One private message to the author of a comment on the Page's post, sent as the Page. */
    async privateReply(account, commentId, text, env) {
      const token = (await env.token()).accessToken;
      const r = await client.postJson<{ message_id?: string }>(`${account.externalId}/messages`, token, { recipient: { comment_id: commentId }, message: { text } });
      return { messageId: r.message_id };
    },

    async fetchMetrics(_account, externalId, handle, env, post): Promise<MetricsResult> {
      const token = (await env.token()).accessToken;
      const isVideo = handle.objectType === 'video';
      if (!isVideo) {
        // A photo post: its reactions, comments and shares, and the views of its media.
        const counts = await client.get<{ reactions?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } }; shares?: { count?: number } }>(
          externalId, token, { fields: 'reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares' });
        const insights = await client.get<InsightsAnswer>(`${externalId}/insights`, token, { metric: 'post_media_view' });
        const v = valuesOf(insights);
        return {
          // A post that nobody has shared has no `shares` at all: that is a real zero.
          common: { views: num(v.post_media_view), likes: counts.reactions?.summary?.total_count, comments: counts.comments?.summary?.total_count, shares: counts.shares?.count ?? 0 },
          raw: { counts, insights },
          note: 'Facebook is withdrawing impression figures, so views are the views of the post; likes are all reactions',
        };
      }
      // A video or a Reel is a Video node: it has likes and comments (and no `shares` field, nor reactions), and insights of its own
      // kind. A Reel's are not a video's: asking a Reel for total_video_views, or a video for a Reel's plays, fails the whole call.
      const reel = post.placement === 'reel';
      const counts = await client.get<{ likes?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } } }>(
        externalId, token, { fields: 'likes.summary(total_count).limit(0),comments.summary(total_count).limit(0)' });
      const metric = reel
        ? 'fb_reels_total_plays,post_impressions_unique,post_video_avg_time_watched,post_video_social_actions'
        : 'total_video_views,total_video_impressions_unique,total_video_avg_time_watched';
      const insights = await client.get<InsightsAnswer>(`${externalId}/video_insights`, token, { metric });
      const v = valuesOf(insights);
      const avgMs = num(reel ? v.post_video_avg_time_watched : v.total_video_avg_time_watched);
      const social = v.post_video_social_actions;
      const shares = social && typeof social === 'object' ? num((social as Record<string, unknown>).SHARE ?? (social as Record<string, unknown>).share) : undefined;
      return {
        common: {
          views: num(reel ? v.fb_reels_total_plays : v.total_video_views),
          reach: num(reel ? v.post_impressions_unique : v.total_video_impressions_unique),
          likes: counts.likes?.summary?.total_count,
          comments: counts.comments?.summary?.total_count,
          ...(shares !== undefined ? { shares } : {}),
          ...(avgMs !== undefined ? { avgWatchSeconds: avgMs / 1000 } : {}),
        },
        raw: { counts, insights },
        note: reel
          ? 'A Reel counts every play, replays included, as a view; reach is the people who saw it. Likes are likes, not every reaction'
          : 'Views are plays of 3 seconds or more; reach is the people who saw it. Facebook gives no share count for a video',
      };
    },

    async health(account, env): Promise<HealthResult> {
      const token = (await env.token()).accessToken;
      await client.get(account.externalId, token, { fields: 'id,name' });
      return { valid: true, expiresAt: account.providerData.dataAccessExpiresAt as string | undefined, note: await describeSubscription(client, account.externalId, token, 'feed') };
    },

    // A Page's comments reach the webhook only once the app is subscribed to its "feed" events.
    eventFields: ['feed'],
    async subscribeEvents(account, env) {
      const t = await env.token();
      return subscribe(client, account.externalId, t.accessToken, ['feed'], t.scopes);
    },
    async unsubscribeEvents(account, env, keep) {
      await unsubscribe(client, account.externalId, (await env.token()).accessToken, keep);
    },
  };
  return connector;
}
