import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { call } from '../http.js';
import { issue, validateAgainst } from '../validate.js';
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

/**
 * The video upload form, streamed: the fields Pinterest gave back first, then the file, read from storage as it is sent. A video can be
 * gigabytes, so it is never held in memory. The length is known in advance (the upload address is S3's, which wants it).
 */
async function uploadForm(env: ConnectorEnv, fields: Record<string, string>, m: MediaItem): Promise<{ body: ReadableStream; length: number; type: string }> {
  const boundary = `----estudio${randomBytes(12).toString('hex')}`;
  const quote = (s: string) => s.replace(/["\r\n]/g, '_');
  const head = Buffer.from(
    Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${quote(k)}"\r\n\r\n${v}\r\n`).join('')
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quote(m.name)}"\r\nContent-Type: ${m.mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const { stream, size } = await env.open(m.key, 0);
  async function* parts() {
    yield head;
    for await (const c of stream) yield c as Buffer;
    yield tail;
  }
  return { body: Readable.toWeb(Readable.from(parts())) as unknown as ReadableStream, length: head.length + size + tail.length, type: `multipart/form-data; boundary=${boundary}` };
}

export function createPinterest(client: PinterestClient): Connector {
  /** The pin with this title made on the board since a minute before `since`, if there is one: what a try whose answer was lost made. */
  async function findPin(token: string, board: string, title: string, since: Date): Promise<string | null> {
    const recent = await client.request<{ items?: { id: string; title?: string; created_at?: string }[] }>(`/v5/boards/${board}/pins`, token, { query: { page_size: 25 } });
    const from = since.getTime() - 60_000;
    return (recent.items ?? []).find((p) => p.title === title && (!p.created_at || new Date(p.created_at).getTime() >= from))?.id ?? null;
  }

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
      if (titleOf(input).length === 0) issues.push(issue('error', 'title.missing', {}, 'text'));
      const link = linkOf(input);
      if (link) {
        try {
          const u = new URL(link);
          if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
        } catch {
          issues.push(issue('error', 'link.invalid', { link }, 'text'));
        }
      }
      if (input.placement === 'video_pin' && !input.media.some((m) => m.kind === 'cover')) {
        issues.push(issue('error', 'cover.missing', {}, 'media'));
      }
      if (account.providerData.audited !== true) {
        issues.push(issue('warning', 'pinterest.trial', {}, 'schedule'));
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
        // The video goes to the address Pinterest gave back, with the fields it asked for first and the file last, streamed.
        const form = await uploadForm(env, (h.uploadParameters ?? {}) as Record<string, string>, m);
        const r = await call(h.uploadUrl as string, {
          method: 'POST', body: form.body as unknown as BodyInit, duplex: 'half', timeoutMs: 60 * 60_000,
          headers: { 'content-type': form.type, 'content-length': String(form.length) },
        });
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
          const found = await findPin(token, account.externalId, title, new Date(h.attemptedAt as string));
          if (found) h = { ...h, pinId: found, recovered: true };
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

    /** A pin an earlier try made although its answer was lost, on the board, without making another (see findPin). */
    async find(input, account, handle: Handle, env: ConnectorEnv): Promise<Handle | null> {
      if (handle.pinId) return handle;
      if (!handle.attemptedAt) return null;
      const token = (await env.token()).accessToken;
      const found = await findPin(token, account.externalId, titleOf(input), new Date(handle.attemptedAt as string));
      return found ? { ...handle, pinId: found, recovered: true } : null;
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

