import { validateAgainst } from '../validate.js';
import {
  ConnectorError,
  type Account, type Capabilities, type Connector, type ConnectorEnv, type Handle, type HealthResult, type Issue,
  type MediaItem, type PrepareResult, type Published, type PublishInput, type VerifyResult,
} from '../types.js';
import type { MetaClient } from './client.js';

/**
 * Facebook Page publishing through the Graph API with a Page token.
 *
 * Unlike Instagram, Facebook can hold a post and publish it by itself at a chosen time (10 minutes to 29 days ahead),
 * so everything is created ahead of time as a scheduled post and goes out even if this app is down at that hour.
 * When there is too little lead time left for that (the app was late), the post is made and published at once instead.
 *
 * As with the other connectors, the figures come from the public documentation as the specification recorded it.
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

export function createFacebook(client: MetaClient): Connector {
  /** Makes the post, either held for `when` (native scheduling) or live at once. Resumable step by step through the handle. */
  async function create(input: PublishInput, account: Account, h: Handle, env: ConnectorEnv, token: string, when: Date | null): Promise<Handle> {
    const page = account.externalId;
    const live = when === null;
    const unix = when ? Math.floor(when.getTime() / 1000) : undefined;
    const main = mainOf(input);
    const hold = live ? { published: true } : { published: false, scheduled_publish_time: unix };
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
          for (const m of main) ids.push((await client.post<{ id: string }>(`${page}/photos`, token, { url: m.url, published: false })).id);
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
      // Now it is live, post the first comment (a post that was held cannot take comments before this).
      let next: Handle | undefined;
      if (handle.firstComment && !handle.commentId && !handle.firstCommentError) {
        try {
          const c = await client.post<{ id: string }>(`${externalId}/comments`, token, { message: handle.firstComment });
          next = { ...handle, commentId: c.id };
        } catch (err) {
          next = { ...handle, firstCommentError: (err as Error).message };
          env.log.warn({ err: String(err) }, 'could not post the Facebook first comment');
        }
      }
      return { visibility: 'public', url, handle: next };
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

    async health(account, env): Promise<HealthResult> {
      const token = (await env.token()).accessToken;
      await client.get(account.externalId, token, { fields: 'id,name' });
      return { valid: true, expiresAt: account.providerData.dataAccessExpiresAt as string | undefined };
    },
  };
  return connector;
}
