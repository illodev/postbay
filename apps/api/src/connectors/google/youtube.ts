import { Readable } from 'node:stream';
import { call } from '../http.js';
import { validateAgainst } from '../validate.js';
import {
  ConnectorError,
  type Account, type Capabilities, type CommonMetrics, type Connector, type ConnectorEnv, type Handle, type HealthResult, type Issue,
  type MediaItem, type MetricsResult, type PrepareResult, type Published, type PublishInput, type VerifyResult,
} from '../types.js';
import { classifyGoogle, type GoogleClient } from './client.js';
import { ANALYTICS_SCOPE } from './oauth.js';

/**
 * YouTube publishing through the Data API: a resumable upload of the video, set to private with a `publishAt` time.
 * YouTube itself then makes it public at that time, so it goes out even if this app is down.
 *
 * Until Google's compliance audit of the project passes, every video uploaded through the API is forced private whatever
 * is asked. The app treats that as a normal state ("published, private") and tells the approvers a person has to make
 * the video public in YouTube Studio. The audit status is set on the account (providerData.audited).
 *
 * A Short is not a separate kind of upload: YouTube decides from the shape (vertical or square) and the length (up to 3
 * minutes). The "short" placement exists so the review screen can show where YouTube's own interface covers the frame.
 */
/** YouTube's declaration that a video is, or is not, made for children (COPPA). Required of every channel; nobody is chosen for. */
const MADE_FOR_KIDS = [
  { value: 'no', label: "No, it's not made for kids" },
  { value: 'yes', label: "Yes, it's made for kids" },
];

const CAPS: Capabilities = {
  network: 'youtube',
  placements: [
    { id: 'video', label: 'Video', accepts: ['video'], items: { min: 1, max: 1 }, profiles: { video: 'yt-video' }, nativeScheduling: true },
    {
      id: 'short', label: 'Short', accepts: ['video'], items: { min: 1, max: 1 },
      aspect: { min: 0.1, max: 1 }, durationSec: { min: 1, max: 180 },
      safeZones: { top: 0.12, bottom: 0.25, left: 0.05, right: 0.15 },
      profiles: { video: 'yt-video' }, nativeScheduling: true,
    },
  ],
  // YouTube counts the description in bytes (5,000 of UTF-8), which validate() checks: an accent takes two, an emoji four.
  text: { maxChars: 5000, maxHashtags: 60, previewCutoff: 100, firstComment: false },
  aiLabel: true,
  nativeScheduling: { minLeadMinutes: 1, maxLeadDays: 3650 },
  options: [
    {
      key: 'madeForKids', label: 'Is this video made for kids?', type: 'select', required: true, choices: MADE_FOR_KIDS,
      help: "YouTube requires this declaration for every video (children's privacy law, COPPA). The channel's default is filled in when one is set in Settings → Accounts.",
    },
  ],
};

/**
 * How long after its publishAt a video may still be private before that counts as YouTube holding it back: the switch is not instant.
 * Under the publisher's hour of looks at a post that is still processing, so it is this that concludes, with the right words.
 */
const PUBLISH_GRACE_MS = 45 * 60_000;
const DESCRIPTION_MAX_BYTES = 5000;
const utf8 = new TextEncoder();
const bytesOf = (s: string) => utf8.encode(s).length;

/** YouTube refuses < and > in a description; each becomes the nearest look-alike, so "a > b" still reads the same. */
export const cleanDescription = (s: string) => s.replace(/</g, '‹').replace(/>/g, '›');

/** The description as it is sent: cleaned, then cut to whole characters within YouTube's 5,000 bytes. */
export function descriptionOf(text: string): string {
  const clean = cleanDescription(text);
  if (bytesOf(clean) <= DESCRIPTION_MAX_BYTES) return clean;
  let out = '';
  let n = 0;
  for (const seg of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(clean)) {
    const b = bytesOf(seg.segment);
    if (n + b > DESCRIPTION_MAX_BYTES) break;
    out += seg.segment;
    n += b;
  }
  return out;
}

/** The made-for-kids declaration for this video: the publication's own, or the channel's default. Undefined when nobody made one. */
function madeForKidsOf(input: PublishInput, account?: Account): boolean | undefined {
  const v = input.options.madeForKids;
  if (v === 'yes' || v === true) return true;
  if (v === 'no' || v === false) return false;
  const d = account?.providerData.madeForKids;
  return typeof d === 'boolean' ? d : undefined;
}

/** What the YouTube Analytics API answers: the names of the columns, then a row of numbers for each video asked about. */
interface AnalyticsReport {
  columnHeaders?: { name: string }[];
  rows?: (string | number)[][];
}

const TITLE_MAX = 100;
const mainVideo = (input: PublishInput): MediaItem | undefined => input.media.find((m) => m.kind === 'video');
const titleOf = (input: PublishInput) => String(typeof input.options.title === 'string' && input.options.title.trim() ? input.options.title : input.title).replace(/[<>]/g, '');

export function createYouTube(client: GoogleClient, uploadUrl: (path: string) => string): Connector {
  /** Opens an upload session. YouTube answers with the address to send the bytes to, in the Location header. */
  async function openSession(input: PublishInput, account: Account, token: string, size: number, mime: string, now: Date): Promise<{ url: string; status: Record<string, unknown> }> {
    const lead = input.scheduledAt.getTime() - now.getTime();
    const kids = madeForKidsOf(input, account);
    // Held for the scheduled time, unless there is no time left to hold it for. The made-for-kids declaration is sent only when a
    // person made one; otherwise YouTube applies the channel's own setting (the app never declares it for them).
    const status: Record<string, unknown> = {
      privacyStatus: lead > 120_000 ? 'private' : 'public',
      ...(lead > 120_000 ? { publishAt: input.scheduledAt.toISOString() } : {}),
      ...(kids === undefined ? {} : { selfDeclaredMadeForKids: kids }),
      ...(input.aiGenerated ? { containsSyntheticMedia: true } : {}),
    };
    const tags = Array.isArray(input.options.tags) ? input.options.tags.filter((t): t is string => typeof t === 'string').slice(0, 30) : undefined;
    const r = await call(uploadUrl('/upload/youtube/v3/videos'), {
      method: 'POST',
      query: { uploadType: 'resumable', part: 'snippet,status' },
      headers: { authorization: `Bearer ${token}`, 'x-upload-content-length': String(size), 'x-upload-content-type': mime },
      json: {
        snippet: {
          title: titleOf(input).slice(0, TITLE_MAX),
          description: descriptionOf(input.text),
          ...(tags ? { tags } : {}),
          categoryId: typeof input.options.categoryId === 'string' ? input.options.categoryId : '22',
        },
        status,
      },
    });
    const err = classifyGoogle(r);
    if (err) throw err;
    const location = r.headers.get('location');
    if (!location) throw new ConnectorError('transient', 'YouTube did not return an upload address', { httpStatus: r.status });
    return { url: location, status };
  }

  /**
   * Sends the bytes, and if the connection drops asks YouTube how far it got and carries on from there.
   * Returns the created video.
   */
  async function upload(env: ConnectorEnv, key: string, sessionUrl: string, mime: string): Promise<{ id: string }> {
    let offset = 0;
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const { stream, size } = await env.open(key, offset);
      try {
        const r = await call(sessionUrl, {
          method: 'PUT',
          headers: {
            'content-type': mime,
            'content-length': String(size - offset),
            ...(offset > 0 ? { 'content-range': `bytes ${offset}-${size - 1}/${size}` } : {}),
          },
          body: Readable.toWeb(stream) as unknown as BodyInit,
          duplex: 'half',
          timeoutMs: 4 * 3600_000,
        });
        if (r.status === 200 || r.status === 201) return r.body;
        if (r.status < 500) {
          const err = classifyGoogle(r);
          throw err ?? new ConnectorError('unknown', `YouTube answered ${r.status} to the upload`, { httpStatus: r.status });
        }
        lastError = new ConnectorError('transient', `YouTube answered ${r.status} during the upload`, { httpStatus: r.status });
      } catch (err) {
        if (err instanceof ConnectorError && err.errorClass !== 'transient') throw err;
        lastError = err;
      }
      // Ask how much arrived.
      const probe = await call(sessionUrl, { method: 'PUT', headers: { 'content-length': '0', 'content-range': `bytes */${(await env.open(key, 0)).size}` } });
      if (probe.status === 200 || probe.status === 201) return probe.body;
      if (probe.status === 308) {
        const range = probe.headers.get('range'); // "bytes=0-12345"
        const m = range ? /bytes=0-(\d+)/.exec(range) : null;
        offset = m ? Number(m[1]) + 1 : 0;
        continue;
      }
      if (probe.status === 404 || probe.status === 410) {
        throw new ConnectorError('transient', 'The YouTube upload session expired', { httpStatus: probe.status, detail: { restartSession: true } });
      }
    }
    throw lastError instanceof ConnectorError ? lastError : new ConnectorError('transient', `The YouTube upload kept failing: ${String(lastError)}`);
  }

  const connector: Connector = {
    network: 'youtube',
    provider: 'google',

    /** The channel's made-for-kids default, when one was set, is what the declaration starts from. */
    capabilities(account) {
      const d = account?.providerData.madeForKids;
      if (typeof d !== 'boolean') return CAPS;
      return { ...CAPS, options: CAPS.options!.map((o) => (o.key === 'madeForKids' ? { ...o, default: d ? 'yes' : 'no' } : o)) };
    },

    defaultPlacement({ pieceKind, format, media }) {
      if (pieceKind === 'story' || !media.some((m) => m.kind === 'video')) return null;
      return format === '9:16' || format === '1:1' ? 'short' : 'video';
    },

    validate(input, account): Issue[] {
      const issues = validateAgainst(CAPS, input);
      if (titleOf(input).length > TITLE_MAX) {
        issues.push({ severity: 'error', code: 'title.length', field: 'text', message: `The title has ${titleOf(input).length} characters; YouTube allows ${TITLE_MAX}. Shorten the piece title.` });
      }
      const bytes = bytesOf(cleanDescription(input.text));
      if (bytes > DESCRIPTION_MAX_BYTES) {
        issues.push({
          severity: 'error', code: 'text.bytes', field: 'text',
          message: `YouTube counts the description in bytes: this one takes ${bytes} of ${DESCRIPTION_MAX_BYTES} (accented letters take two, emoji four, and each < or > is sent as ‹ or ›, three). Shorten it.`,
        });
      }
      if (/[<>]/.test(input.text)) {
        issues.push({ severity: 'warning', code: 'text.angle', field: 'text', message: 'YouTube does not allow < or > in a description: they will be sent as ‹ and ›.' });
      }
      if (madeForKidsOf(input, account) === undefined) {
        issues.push({
          severity: 'warning', code: 'youtube.made_for_kids', field: 'placement',
          message: "Nobody has said whether this video is made for kids. YouTube requires that declaration: choose it here (or set the channel's default in Settings → Accounts); otherwise YouTube applies the channel's own setting, and asks for it in YouTube Studio if there is none.",
        });
      }
      if (account.providerData.audited !== true) {
        issues.push({
          severity: 'warning', code: 'youtube.unaudited', field: 'schedule',
          message: "This YouTube project has not passed Google's compliance audit yet: the video will be uploaded as private, and a person has to make it public in YouTube Studio.",
        });
      }
      return issues;
    },

    async prepare(input, account, handle: Handle, env: ConnectorEnv): Promise<PrepareResult> {
      const video = mainVideo(input);
      if (!video) throw new ConnectorError('unsupported', 'There is no video to upload');
      let h: Handle = { ...handle };
      if (h.videoId) return { done: true, handle: h, nativeScheduled: !h.immediate };
      const token = (await env.token()).accessToken;

      if (!h.sessionUrl) {
        const s = await openSession(input, account, token, video.bytes, video.mime, env.now());
        h = { ...h, sessionUrl: s.url, immediate: s.status.privacyStatus === 'public', status: s.status };
        await env.persist(h);
      }
      let created: { id: string };
      try {
        created = await upload(env, video.key, h.sessionUrl as string, video.mime);
      } catch (err) {
        if (err instanceof ConnectorError && (err.detail as { restartSession?: boolean } | undefined)?.restartSession) {
          await env.persist({ ...h, sessionUrl: undefined });
        }
        throw err;
      }
      h = { ...h, videoId: created.id, sessionUrl: undefined };
      await env.persist(h);

      // A custom thumbnail, where YouTube allows one (not on Shorts, and only for verified channels). Never fails the upload.
      const cover = input.media.find((m) => m.kind === 'cover');
      if (cover && input.placement === 'video' && !h.thumbnailDone) {
        try {
          const { stream } = await env.open(cover.key, 0);
          const chunks: Buffer[] = [];
          for await (const c of stream) chunks.push(c as Buffer);
          const r = await call(uploadUrl('/upload/youtube/v3/thumbnails/set'), {
            method: 'POST', query: { videoId: created.id, uploadType: 'media' },
            headers: { authorization: `Bearer ${token}`, 'content-type': cover.mime }, body: Buffer.concat(chunks),
          });
          const err = classifyGoogle(r);
          if (err) throw err;
          h = { ...h, thumbnailDone: true };
        } catch (err) {
          h = { ...h, thumbnailError: (err as Error).message };
          env.log.warn({ err: String(err) }, 'could not set the YouTube thumbnail');
        }
        await env.persist(h);
      }
      return { done: true, handle: h, nativeScheduled: !h.immediate };
    },

    async publish(_input, _account, handle: Handle): Promise<Published> {
      // Nothing to send: the video is already on YouTube, waiting for its publishAt (or already public).
      return { externalId: handle.videoId as string, url: `https://www.youtube.com/watch?v=${handle.videoId}` };
    },

    async verify(account, externalId, _handle, env): Promise<VerifyResult> {
      const token = (await env.token()).accessToken;
      const r = await client.get<{ items?: { status?: { uploadStatus?: string; privacyStatus?: string; publishAt?: string; rejectionReason?: string; failureReason?: string } }[] }>(
        '/youtube/v3/videos', token, { part: 'status,processingDetails', id: externalId });
      const s = r.items?.[0]?.status;
      const url = `https://www.youtube.com/watch?v=${externalId}`;
      if (!s) return { visibility: 'unknown', url, note: 'YouTube does not return this video any more' };
      if (s.uploadStatus === 'failed' || s.uploadStatus === 'rejected') {
        throw new ConnectorError('file_rejected', `YouTube refused the video (${s.rejectionReason ?? s.failureReason ?? s.uploadStatus})`, { detail: s });
      }
      if (s.privacyStatus === 'public' || s.privacyStatus === 'unlisted') return { visibility: 'public', url };
      if (s.uploadStatus === 'uploaded') return { visibility: 'processing', url };
      // Private. With a publish time still ahead that is the plan.
      const publishAt = s.publishAt ? new Date(s.publishAt).getTime() : null;
      if (publishAt !== null && publishAt > env.now().getTime()) return { visibility: 'scheduled', url };
      // Past it, YouTube flips the video to public by itself, but not at the second: an audited project's video is given 45 minutes
      // (looked at again every minute) before "still private" is taken as YouTube holding it back.
      const audited = account.providerData.audited === true;
      if (audited && publishAt !== null && env.now().getTime() - publishAt < PUBLISH_GRACE_MS) {
        return { visibility: 'processing', url, note: 'Its time has come and YouTube has not made it public yet; it usually does within minutes' };
      }
      if (!audited) return { visibility: 'private', url, note: 'The video is private on YouTube, because the project has not passed its audit: a person has to make it public in YouTube Studio' };
      if (publishAt === null) return { visibility: 'private', url, note: 'The video is private on YouTube: a person has to make it public in YouTube Studio' };
      return { visibility: 'private', url, note: 'The video is still private on YouTube 45 minutes after its time: a person has to make it public in YouTube Studio' };
    },

    async discard(_account, handle, env): Promise<void> {
      if (!handle.videoId) return;
      const token = (await env.token()).accessToken;
      try {
        await client.delete('/youtube/v3/videos', token, { id: handle.videoId as string });
      } catch (err) {
        if (err instanceof ConnectorError && err.errorClass === 'file_rejected') return; // already gone
        throw err;
      }
    },

    async fetchMetrics(_account, externalId, _handle, env): Promise<MetricsResult> {
      const tokens = await env.token();
      const token = tokens.accessToken;
      const r = await client.get<{ items?: { snippet?: { publishedAt?: string }; statistics?: Record<string, string> }[] }>(
        '/youtube/v3/videos', token, { part: 'statistics,snippet', id: externalId },
      );
      const item = r.items?.[0];
      const s = item?.statistics;
      if (!s) throw new ConnectorError('file_rejected', 'YouTube does not return this video any more');
      const n = (k: string) => (s[k] === undefined ? undefined : Number(s[k]));
      const common: CommonMetrics = { views: n('viewCount'), likes: n('likeCount'), comments: n('commentCount') };
      if (!client.cfg.analytics) {
        return {
          common, raw: r,
          note: 'These are the figures of the Data API. Watch time comes from the YouTube Analytics API: turn on GOOGLE_ANALYTICS and connect the channel again to give this app that permission',
        };
      }
      if (tokens.scopes && !tokens.scopes.includes(ANALYTICS_SCOPE)) {
        return { common, raw: r, note: 'Watch time needs the YouTube Analytics permission, and this connection was made without it. Connect the channel again and accept it' };
      }
      // The Data API's figures stand even if Analytics cannot answer; only a failure worth trying again makes the whole reading wait.
      try {
        const report = await client.report<AnalyticsReport>('/v2/reports', token, {
          ids: 'channel==MINE',
          metrics: 'estimatedMinutesWatched,averageViewDuration,views',
          dimensions: 'video',
          filters: `video==${externalId}`,
          // From the day the video went up (YouTube's own first upload day if that is not known) to today.
          startDate: (item?.snippet?.publishedAt ?? '2005-04-23').slice(0, 10),
          endDate: env.now().toISOString().slice(0, 10),
        });
        const row = report.rows?.[0];
        if (!row) return { common, raw: { ...r, analytics: report }, note: 'YouTube Analytics has no figures for this video yet; it usually takes a day or two' };
        const at = (name: string) => {
          const i = (report.columnHeaders ?? []).findIndex((h) => h.name === name);
          return i >= 0 && typeof row[i] === 'number' ? (row[i] as number) : undefined;
        };
        const minutes = at('estimatedMinutesWatched');
        const average = at('averageViewDuration');
        return { common: { ...common, ...(minutes !== undefined ? { watchMinutes: minutes } : {}), ...(average !== undefined ? { avgWatchSeconds: average } : {}) }, raw: { ...r, analytics: report } };
      } catch (err) {
        if (err instanceof ConnectorError && (err.errorClass === 'transient' || err.errorClass === 'rate_limit')) throw err;
        if (!(err instanceof ConnectorError)) {
          // An answer in a shape this app does not know. The counts are still good, so they are kept and the gap is explained.
          env.log.warn({ err: String(err) }, 'YouTube Analytics answered in a way this app could not read');
          return { common, raw: r, note: 'Watch time is missing: YouTube Analytics answered in a way this app does not understand' };
        }
        const why = err.errorClass === 'auth' ? 'This connection is not allowed to read YouTube Analytics: connect the channel again and accept every permission' : `YouTube Analytics refused the question (${err.message})`;
        return { common, raw: r, note: `Watch time is missing. ${why}` };
      }
    },

    async health(_account, env): Promise<HealthResult> {
      const token = (await env.token()).accessToken;
      await client.get('/youtube/v3/channels', token, { part: 'id', mine: true });
      return { valid: true };
    },
  };
  return connector;
}
