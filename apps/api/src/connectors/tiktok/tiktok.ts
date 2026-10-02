import { call } from '../http.js';
import { validateAgainst } from '../validate.js';
import {
  ConnectorError,
  type Account, type Capabilities, type Connector, type ConnectorEnv, type Handle, type HealthResult, type Issue,
  type MediaItem, type MetricsResult, type PrepareResult, type Published, type PublishInput, type VerifyResult,
} from '../types.js';
import { classifyTikTok, type TikTokClient } from './client.js';

/**
 * TikTok publishing through the Content Posting API, "direct post": the video is sent by upload (in pieces) and TikTok makes
 * it public by itself once it has processed it, so there is no holding it for the hour: the upload is the publishing, which
 * is why it happens at the hour and not before, and why `verify` is what waits for TikTok to finish. Pictures can only be
 * pulled by TikTok from a domain verified in its developer portal.
 *
 * Until TikTok audits the app every post is forced to private; the app treats that as a state (published, private, said
 * plainly), as it does for YouTube. TikTok's own guidelines call a tool that uploads to accounts a team manages itself
 * "not acceptable", so the audit may be refused: the account then stays on hand-over.
 *
 * TikTok obliges an app that posts for people to show certain controls, with no defaults chosen for them: who can see the
 * post, what is allowed on it (all unticked), whether it promotes a brand, and TikTok's own consent text, word for word.
 */
const PRIVACY = [
  { value: 'SELF_ONLY', label: 'Only me' },
  { value: 'MUTUAL_FOLLOW_FRIENDS', label: 'Friends' },
  { value: 'FOLLOWER_OF_CREATOR', label: 'Followers' },
  { value: 'PUBLIC_TO_EVERYONE', label: 'Everyone' },
];
const CONSENT = "By posting, you agree to TikTok's Music Usage Confirmation.";
const CONSENT_BRANDED = "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.";

const CAPS: Capabilities = {
  network: 'tiktok',
  placements: [
    {
      id: 'video', label: 'Video', accepts: ['video'], items: { min: 1, max: 1 }, aspect: { min: 0.1, max: 10 }, recommendedAspect: { min: 0.5, max: 0.6 },
      durationSec: { min: 3, max: 600 }, safeZones: { top: 0.1, bottom: 0.25, left: 0.05, right: 0.18 },
      profiles: { video: 'tt-video' }, nativeScheduling: false,
    },
    {
      id: 'photo', label: 'Photos', accepts: ['image'], items: { min: 1, max: 35 }, safeZones: { top: 0.08, bottom: 0.2, left: 0.05, right: 0.15 },
      profiles: { image: 'tt-photo' }, nativeScheduling: false,
    },
  ],
  text: { maxChars: 2200, maxHashtags: 100, previewCutoff: 80, firstComment: false },
  aiLabel: true,
  nativeScheduling: null,
  options: [
    { key: 'privacy', label: 'Who can see this post', type: 'select', required: true, choices: PRIVACY, help: 'TikTok asks that nobody is chosen for you.' },
    { key: 'allowComment', label: 'Allow comments', type: 'checkbox', default: false },
    { key: 'allowDuet', label: 'Allow duets', type: 'checkbox', default: false, placements: ['video'] },
    { key: 'allowStitch', label: 'Allow stitches', type: 'checkbox', default: false, placements: ['video'] },
    { key: 'commercial', label: 'This post promotes a brand, product or service', type: 'checkbox', default: false },
    { key: 'yourBrand', label: 'Your own brand', type: 'checkbox', default: false, showWhen: 'commercial', help: 'You are promoting yourself or your own business.' },
    { key: 'brandedContent', label: 'Branded content', type: 'checkbox', default: false, showWhen: 'commercial', help: 'You are promoting another brand or a third party. It cannot be private.' },
    { key: 'consent', label: 'I agree', type: 'checkbox', required: true, notice: CONSENT },
    { key: 'consentBranded', label: 'I agree', type: 'checkbox', required: true, showWhen: 'brandedContent', notice: CONSENT_BRANDED },
    { key: 'title', label: 'Title of the photos', type: 'text', maxLength: 90, placements: ['photo'], help: 'The title of the piece is used if this is empty.' },
  ],
};

const mainOf = (input: PublishInput): MediaItem[] =>
  input.media.filter((m) => m.kind === 'video' || m.kind === 'image').sort((a, b) => a.position - b.position);
const flag = (input: PublishInput, key: string) => input.options[key] === true;
const audited = (a: Account) => a.providerData.audited === true;
/** Until the audit, TikTok only accepts private posts. */
const effectivePrivacy = (input: PublishInput, a: Account) => (audited(a) ? String(input.options.privacy ?? '') : 'SELF_ONLY');

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

export interface TikTokOptions {
  /** Size of each piece of an upload. Below this a video goes in one piece. */
  chunkBytes?: number;
}

export function createTikTok(client: TikTokClient, opts: TikTokOptions = {}): Connector {
  const CHUNK = opts.chunkBytes ?? 10 * 1024 * 1024;
  const SINGLE_MAX = opts.chunkBytes ?? 64 * 1024 * 1024;

  const postInfo = (input: PublishInput, account: Account) => ({
    privacy_level: effectivePrivacy(input, account),
    disable_comment: !flag(input, 'allowComment'),
    brand_content_toggle: flag(input, 'commercial') && flag(input, 'brandedContent'),
    brand_organic_toggle: flag(input, 'commercial') && flag(input, 'yourBrand'),
  });

  const connector: Connector = {
    network: 'tiktok',
    provider: 'tiktok',

    capabilities: () => CAPS,

    defaultPlacement({ media }) {
      if (media.some((m) => m.kind === 'video')) return 'video';
      if (media.some((m) => m.kind === 'image')) return 'photo';
      return null;
    },

    validate(input, account): Issue[] {
      const issues = validateAgainst(CAPS, input);
      const err = (code: string, message: string, field: Issue['field'] = 'placement'): Issue => ({ severity: 'error', code, message, field });
      const privacy = String(input.options.privacy ?? '');
      if (!PRIVACY.some((p) => p.value === privacy)) issues.push(err('tiktok.privacy', 'Choose who can see this post. TikTok asks that nobody is chosen for you.'));
      if (flag(input, 'commercial') && !flag(input, 'yourBrand') && !flag(input, 'brandedContent')) {
        issues.push(err('tiktok.commercial', 'You said the post promotes something: say whether it is your own brand, branded content, or both.'));
      }
      if (flag(input, 'brandedContent') && privacy === 'SELF_ONLY') issues.push(err('tiktok.branded.private', 'Branded content cannot be private on TikTok.'));
      if (!flag(input, 'consent')) issues.push(err('tiktok.consent', `TikTok needs this agreement before posting: "${CONSENT}"`));
      if (flag(input, 'brandedContent') && !flag(input, 'consentBranded')) issues.push(err('tiktok.consent.branded', `TikTok needs this agreement for branded content: "${CONSENT_BRANDED}"`));
      if (!audited(account)) {
        issues.push({
          severity: 'warning', code: 'tiktok.unaudited', field: 'schedule',
          message: "This TikTok app has not passed TikTok's audit yet: the post will be made private (visible only to you) whatever is chosen above, and a person has to make it public in TikTok.",
        });
      }
      if (input.placement === 'photo') {
        issues.push({
          severity: 'warning', code: 'tiktok.photo.domain', field: 'media',
          message: "TikTok downloads photos itself, and only from a domain verified in its developer portal. If the media domain is not verified there, this will be refused.",
        });
      }
      return issues;
    },

    async prepare(input, account, handle: Handle, env: ConnectorEnv): Promise<PrepareResult> {
      if (handle.creatorChecked) return { done: true, handle };
      const token = (await env.token()).accessToken;
      // What this creator may do right now, asked before any upload so a refusal is a wait or a clear message, not a failed upload.
      const info = (await client.request<{ data?: { privacy_level_options?: string[]; max_video_post_duration_sec?: number } }>('/v2/post/publish/creator_info/query/', token, { method: 'POST', json: {} })).data ?? {};
      const privacy = effectivePrivacy(input, account);
      if (info.privacy_level_options && !info.privacy_level_options.includes(privacy)) {
        throw new ConnectorError('file_rejected', `TikTok does not offer "${PRIVACY.find((p) => p.value === privacy)?.label ?? privacy}" for this account right now. Choose another setting for who can see the post.`, { detail: info });
      }
      const video = mainOf(input)[0];
      if (input.placement === 'video' && video?.durationMs && info.max_video_post_duration_sec && video.durationMs / 1000 > info.max_video_post_duration_sec) {
        throw new ConnectorError('file_rejected', `This account can post videos of up to ${info.max_video_post_duration_sec} seconds on TikTok; this one is ${Math.round(video.durationMs / 1000)}`);
      }
      const h = { ...handle, creatorChecked: true };
      await env.persist(h);
      return { done: true, handle: h };
    },

    async publish(input, account, handle: Handle, env: ConnectorEnv): Promise<Published> {
      const token = (await env.token()).accessToken;
      let h: Handle = { ...handle };
      const username = account.providerData.username ? String(account.providerData.username) : undefined;
      const profile = username ? `https://www.tiktok.com/@${username}` : 'https://www.tiktok.com/';

      if (input.placement === 'photo') {
        if (!h.publishId) {
          const main = mainOf(input);
          const title = String(typeof input.options.title === 'string' && input.options.title.trim() ? input.options.title : input.title).slice(0, 90);
          const r = await client.request<{ data: { publish_id: string } }>('/v2/post/publish/content/init/', token, {
            method: 'POST',
            json: {
              post_info: { title, description: input.text.slice(0, 4000), ...postInfo(input, account), auto_add_music: false },
              source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: main.map((m) => m.url) },
              post_mode: 'DIRECT_POST', media_type: 'PHOTO',
            },
          });
          h = { ...h, publishId: r.data.publish_id, privacy: effectivePrivacy(input, account) };
          await env.persist(h);
        }
        return { externalId: h.publishId as string, url: profile };
      }

      const m = mainOf(input)[0]!;
      const single = m.bytes <= SINGLE_MAX;
      const chunk = single ? m.bytes : CHUNK;
      const total = single ? 1 : Math.max(1, Math.floor(m.bytes / chunk));
      if (!h.publishId) {
        const r = await client.request<{ data: { publish_id: string; upload_url: string } }>('/v2/post/publish/video/init/', token, {
          method: 'POST',
          json: {
            post_info: {
              title: input.text.slice(0, 2200), ...postInfo(input, account), disable_duet: !flag(input, 'allowDuet'), disable_stitch: !flag(input, 'allowStitch'), is_aigc: input.aiGenerated,
            },
            source_info: { source: 'FILE_UPLOAD', video_size: m.bytes, chunk_size: chunk, total_chunk_count: total },
          },
        });
        h = { ...h, publishId: r.data.publish_id, uploadUrl: r.data.upload_url, chunksDone: 0, privacy: effectivePrivacy(input, account) };
        await env.persist(h);
      }
      for (let i = (h.chunksDone as number) ?? 0; i < total; i++) {
        const start = i * chunk;
        const end = i === total - 1 ? m.bytes - 1 : start + chunk - 1;
        const bytes = await readRange(env, m.key, start, end - start + 1);
        const r = await call(h.uploadUrl as string, {
          method: 'PUT',
          headers: { 'content-type': m.mime, 'content-length': String(bytes.length), 'content-range': `bytes ${start}-${end}/${m.bytes}` },
          body: new Uint8Array(bytes) as unknown as BodyInit, timeoutMs: 30 * 60_000,
        });
        if (r.status === 404 || r.status === 410) {
          // The upload address lapsed: start again with a new one.
          await env.persist({ ...h, publishId: undefined, uploadUrl: undefined, chunksDone: 0 });
          throw new ConnectorError('transient', 'The TikTok upload address expired, so the upload starts again', { httpStatus: r.status });
        }
        const err = classifyTikTok(r);
        if (err) throw err;
        if (r.status !== 200 && r.status !== 201 && r.status !== 206) throw new ConnectorError('unknown', `TikTok answered ${r.status} to an upload piece`, { httpStatus: r.status });
        h = { ...h, chunksDone: i + 1 };
        await env.persist(h);
      }
      return { externalId: h.publishId as string, url: profile };
    },

    async verify(account, externalId, handle, env): Promise<VerifyResult> {
      const token = (await env.token()).accessToken;
      const r = await client.request<{ data?: { status?: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] } }>('/v2/post/publish/status/fetch/', token, {
        method: 'POST', json: { publish_id: externalId },
      });
      const s = r.data ?? {};
      const username = account.providerData.username ? String(account.providerData.username) : undefined;
      if (s.status === 'FAILED') throw new ConnectorError('file_rejected', `TikTok could not publish the post: ${s.fail_reason ?? 'no reason given'}`, { detail: s });
      if (s.status === 'PUBLISH_COMPLETE') {
        const postId = s.publicaly_available_post_id?.[0] !== undefined ? String(s.publicaly_available_post_id[0]) : undefined;
        const url = postId && username ? `https://www.tiktok.com/@${username}/video/${postId}` : username ? `https://www.tiktok.com/@${username}` : undefined;
        const priv = (handle.privacy ?? 'SELF_ONLY') === 'SELF_ONLY';
        if (priv) {
          return {
            visibility: 'private', url, handle: postId ? { postId } : undefined,
            note: audited(account) ? 'The post is private on TikTok, as chosen' : "The post is on TikTok but private, because TikTok has not audited this app yet: a person has to make it public in TikTok",
          };
        }
        return { visibility: 'public', url, handle: postId ? { postId } : undefined };
      }
      if (s.status === 'SEND_TO_USER_INBOX') return { visibility: 'private', note: "TikTok put the post in the account's inbox as a draft: a person has to finish it in the TikTok app" };
      return { visibility: 'processing', note: s.status };
    },

    async health(_account, env): Promise<HealthResult> {
      const t = await env.token();
      await client.request('/v2/user/info/', t.accessToken, { query: { fields: 'open_id' } });
      return { valid: true };
    },

    async fetchMetrics(_account, _externalId, handle, env): Promise<MetricsResult> {
      const postId = handle.postId as string | undefined;
      if (!postId) return { common: {}, raw: null, note: 'TikTok gives a post an id only once it is public: a private post has no figures to read' };
      const token = (await env.token()).accessToken;
      const r = await client.request<{ data?: { videos?: { id: string; view_count?: number; like_count?: number; comment_count?: number; share_count?: number }[] } }>('/v2/video/query/', token, {
        method: 'POST', query: { fields: 'id,view_count,like_count,comment_count,share_count' }, json: { filters: { video_ids: [postId] } },
      });
      const v = r.data?.videos?.[0];
      if (!v) throw new ConnectorError('file_rejected', 'TikTok does not return this video any more');
      return { common: { views: v.view_count, likes: v.like_count, comments: v.comment_count, shares: v.share_count }, raw: r, note: 'TikTok gives no reach, saves or watch time through this API' };
    },
  };
  return connector;
}
