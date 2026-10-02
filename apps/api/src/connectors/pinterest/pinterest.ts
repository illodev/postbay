import { call } from '../http.js';
import { validateAgainst } from '../validate.js';
import {
  ConnectorError,
  type Capabilities, type Connector, type ConnectorEnv, type Handle, type HealthResult, type Issue,
  type MediaItem, type MetricsResult, type PrepareResult, type Published, type PublishInput, type VerifyResult,
} from '../types.js';
import type { PinterestClient } from './client.js';

/**
 * Pinterest publishing: a pin on a board (the account is the board). A picture pin needs no upload, Pinterest downloads it
 * from a URL; a video pin is uploaded first, processed, and needs a cover picture.
 *
 * Until Pinterest approves the app for Standard access ("Trial"), a pin can only be seen by whoever made it. The app treats
 * that like YouTube's unaudited state: published, but private, said plainly, until an admin flips the account's audit flag.
 *
 * There is no idempotency key. A pin whose answer was lost is found again on the board before a second one is made.
 */
const CAPS: Capabilities = {
  network: 'pinterest',
  placements: [
    {
      id: 'image_pin', label: 'Pin', accepts: ['image'], items: { min: 1, max: 1 }, recommendedAspect: { min: 0.5, max: 0.8 },
      profiles: { image: 'pin-image' }, nativeScheduling: false,
    },
    {
      id: 'carousel_pin', label: 'Carousel pin', accepts: ['image'], items: { min: 2, max: 5 }, recommendedAspect: { min: 0.5, max: 1 },
      profiles: { image: 'pin-image' }, nativeScheduling: false,
    },
    {
      id: 'video_pin', label: 'Video pin', accepts: ['video'], items: { min: 1, max: 1 }, durationSec: { min: 4, max: 900 }, recommendedAspect: { min: 0.5, max: 1 },
      profiles: { video: 'pin-video' }, nativeScheduling: false,
    },
  ],
  text: { maxChars: 800, previewCutoff: 50, firstComment: false },
  aiLabel: false,
  nativeScheduling: null,
  options: [
    { key: 'title', label: 'Pin title', type: 'text', maxLength: 100, help: 'The title of the piece is used if this is empty.' },
    { key: 'link', label: 'Destination link', type: 'url', maxLength: 2000, help: 'Where a click on the pin goes.' },
    { key: 'altText', label: 'Description of the picture (alt text)', type: 'text', maxLength: 500, placements: ['image_pin', 'carousel_pin'] },
  ],
};

const mainOf = (input: PublishInput): MediaItem[] =>
  input.media.filter((m) => m.kind === 'video' || m.kind === 'image').sort((a, b) => a.position - b.position);
const titleOf = (input: PublishInput) => String(typeof input.options.title === 'string' && input.options.title.trim() ? input.options.title : input.title).slice(0, 100);
const linkOf = (input: PublishInput) => (typeof input.options.link === 'string' && input.options.link.trim() ? input.options.link.trim() : undefined);
const today = (d: Date) => d.toISOString().slice(0, 10);

async function readAll(env: ConnectorEnv, key: string): Promise<Buffer> {
  const { stream } = await env.open(key, 0);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

export function createPinterest(client: PinterestClient): Connector {
  const connector: Connector = {
    network: 'pinterest',
    provider: 'pinterest',

    capabilities: () => CAPS,

    defaultPlacement({ format, media }) {
      if (media.some((m) => m.kind === 'video')) return 'video_pin';
      const images = media.filter((m) => m.kind === 'image').length;
      if (images > 1 || (format === 'carousel' && images > 1)) return 'carousel_pin';
      return images === 1 ? 'image_pin' : null;
    },

    validate(input, account): Issue[] {
      const issues = validateAgainst(CAPS, input);
      if (titleOf(input).length === 0) issues.push({ severity: 'error', code: 'title.missing', field: 'text', message: 'A pin needs a title: give the piece one, or write one under the pin options' });
      const link = linkOf(input);
      if (link) {
        try {
          const u = new URL(link);
          if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
        } catch {
          issues.push({ severity: 'error', code: 'link.invalid', field: 'text', message: `"${link}" is not a web address Pinterest can use as the pin's link` });
        }
      }
      if (input.placement === 'video_pin' && !input.media.some((m) => m.kind === 'cover')) {
        issues.push({ severity: 'error', code: 'cover.missing', field: 'media', message: 'A video pin needs a cover picture: add one to this version' });
      }
      if (account.providerData.audited !== true) {
        issues.push({
          severity: 'warning', code: 'pinterest.trial', field: 'schedule',
          message: 'This Pinterest app is on Trial access: the pin will be created, but only you can see it until Pinterest approves the app for Standard access.',
        });
      }
      return issues;
    },

    async prepare(input, _account, handle: Handle, env: ConnectorEnv): Promise<PrepareResult> {
      if (input.placement !== 'video_pin') return { done: true, handle }; // Pinterest downloads pictures from their address
      const token = (await env.token()).accessToken;
      const m = mainOf(input)[0]!;
      let h: Handle = { ...handle };
      if (!h.mediaId) {
        const reg = await client.request<{ media_id: string; upload_url: string; upload_parameters: Record<string, string> }>('/v5/media', token, { method: 'POST', json: { media_type: 'video' } });
        h = { ...h, mediaId: reg.media_id, uploadUrl: reg.upload_url, uploadParameters: reg.upload_parameters };
        await env.persist(h);
      }
      if (!h.uploaded) {
        // The video goes to the address Pinterest gave back, with the fields it asked for first and the file last.
        const form = new FormData();
        for (const [k, v] of Object.entries((h.uploadParameters ?? {}) as Record<string, string>)) form.set(k, v);
        form.set('file', new Blob([new Uint8Array(await readAll(env, m.key))], { type: m.mime }), m.name);
        const r = await call(h.uploadUrl as string, { method: 'POST', body: form, timeoutMs: 30 * 60_000 });
        if (r.status >= 500) throw new ConnectorError('transient', `The video upload answered ${r.status}`, { httpStatus: r.status });
        if (!r.ok) throw new ConnectorError('file_rejected', `Pinterest refused the video upload (${r.status})`, { httpStatus: r.status });
        h = { ...h, uploaded: true };
        await env.persist(h);
      }
      const st = await client.request<{ status: string }>(`/v5/media/${h.mediaId}`, token);
      if (st.status === 'failed') throw new ConnectorError('file_rejected', 'Pinterest could not process the video', { detail: st });
      if (st.status !== 'succeeded') return { done: false, handle: h, retryAfterSec: 10 };
      return { done: true, handle: h };
    },

    async publish(input, account, handle: Handle, env: ConnectorEnv): Promise<Published> {
      const token = (await env.token()).accessToken;
      let h: Handle = { ...handle };
      const title = titleOf(input);

      if (!h.pinId) {
        // A try that may have gone through is looked for on the board before another is made.
        if (h.attemptedAt) {
          const recent = await client.request<{ items?: { id: string; title?: string; created_at?: string }[] }>(`/v5/boards/${account.externalId}/pins`, token, { query: { page_size: 25 } });
          const since = new Date(h.attemptedAt as string).getTime() - 60_000;
          const found = (recent.items ?? []).find((p) => p.title === title && (!p.created_at || new Date(p.created_at).getTime() >= since));
          if (found) h = { ...h, pinId: found.id, recovered: true };
        }
        if (!h.pinId) {
          h = { ...h, attemptedAt: env.now().toISOString() };
          await env.persist(h);
          const main = mainOf(input);
          const alt = typeof input.options.altText === 'string' ? input.options.altText.slice(0, 500) : undefined;
          const cover = input.media.find((m) => m.kind === 'cover');
          const link = linkOf(input);
          const media_source =
            input.placement === 'video_pin' ? { source_type: 'video_id', media_id: h.mediaId, cover_image_url: cover?.url }
            : input.placement === 'carousel_pin' ? { source_type: 'multiple_image_urls', items: main.map((m) => ({ url: m.url, title, description: input.text, ...(link ? { link } : {}) })), index: 0 }
            : { source_type: 'image_url', url: main[0]!.url };
          const r = await client.request<{ id: string }>('/v5/pins', token, {
            method: 'POST',
            json: { board_id: account.externalId, title, description: input.text, ...(link ? { link } : {}), ...(alt ? { alt_text: alt } : {}), media_source },
          });
          h = { ...h, pinId: r.id };
        }
        await env.persist(h);
      }
      return { externalId: h.pinId as string, url: `https://www.pinterest.com/pin/${h.pinId}/` };
    },

    async verify(account, externalId, _handle, env): Promise<VerifyResult> {
      const token = (await env.token()).accessToken;
      const url = `https://www.pinterest.com/pin/${externalId}/`;
      try {
        await client.request(`/v5/pins/${externalId}`, token);
      } catch (err) {
        if (err instanceof ConnectorError && err.errorClass === 'file_rejected') return { visibility: 'unknown', note: 'Pinterest does not return this pin any more' };
        throw err;
      }
      if (account.providerData.audited !== true) {
        return { visibility: 'private', url, note: 'The pin is on Pinterest, but only its creator can see it until Pinterest approves the app for Standard access' };
      }
      return { visibility: 'public', url };
    },

    async health(_account, env): Promise<HealthResult> {
      const t = await env.token();
      await client.request('/v5/user_account', t.accessToken);
      return { valid: true, expiresAt: t.expiresAt };
    },

    async fetchMetrics(_account, externalId, _handle, env, post): Promise<MetricsResult> {
      const token = (await env.token()).accessToken;
      const now = env.now();
      // Pinterest answers for at most 90 days back.
      const start = new Date(Math.max(post.publishedAt.getTime(), now.getTime() - 89 * 86_400_000));
      const r = await client.request<{ all?: { lifetime_metrics?: Record<string, number> } }>(`/v5/pins/${externalId}/analytics`, token, {
        query: { start_date: today(start), end_date: today(now), metric_types: 'IMPRESSION,PIN_CLICK,SAVE,OUTBOUND_CLICK,VIDEO_MRC_VIEW,VIDEO_AVG_WATCH_TIME' },
      });
      const m = r.all?.lifetime_metrics;
      if (!m) throw new ConnectorError('file_rejected', 'Pinterest returned no figures for this pin');
      return {
        common: {
          views: m.IMPRESSION, saves: m.SAVE,
          ...(m.VIDEO_AVG_WATCH_TIME !== undefined ? { avgWatchSeconds: m.VIDEO_AVG_WATCH_TIME / 1000 } : {}),
        },
        raw: r,
        note: 'Pinterest counts impressions and saves, and clicks; it has no likes. Clicks are in the full response.',
      };
    },
  };
  return connector;
}

