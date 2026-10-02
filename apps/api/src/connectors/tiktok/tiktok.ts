import { call } from '../http.js';
import { isKnown, msg, render, requestLocale, type Key, type Localized, type Params } from '../../i18n/index.js';
import { issue, validateAgainst } from '../validate.js';
import {
  ConnectorError,
  type Account, type AccountOptions, type Capabilities, type Connector, type ConnectorEnv, type Handle, type HealthResult, type Issue,
  type MediaItem, type MetricsResult, type OptionField, type PrepareResult, type Published, type PublishInput, type VerifyResult,
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
 * post, what is allowed on it (all unticked), whether it promotes a brand, and TikTok's own consent text, word for word. And it
 * obliges the app to ask TikTok, while the post is being written, what this creator may do (creator_info): only the privacy
 * choices it returns may be offered, comments, duets and stitches it has switched off must be shown switched off, and the
 * creator's nickname must be shown. That is accountOptions(); what it says is kept on the account so scheduling is checked against
 * it, and publishing asks again before anything is sent.
 */
const PRIVACY = [
  { value: 'SELF_ONLY', label: 'Only me' },
  { value: 'MUTUAL_FOLLOW_FRIENDS', label: 'Friends' },
  { value: 'FOLLOWER_OF_CREATOR', label: 'Followers' },
  { value: 'PUBLIC_TO_EVERYONE', label: 'Everyone' },
];
const CONSENT = "By posting, you agree to TikTok's Music Usage Confirmation.";
const CONSENT_BRANDED = "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.";
const PROCESSING_NOTE = 'After it is sent, TikTok can take a few minutes to process the post before it shows on the profile.';
const UNAUDITED_HELP = "Until TikTok audits this app, it only takes posts that only the account can see (\"Only me\"), and only from a TikTok account that is itself set to private in TikTok's settings.";

/** What creator_info said about this creator, kept on the account (providerData.creatorInfo). */
interface CreatorInfo {
  privacyLevelOptions?: string[];
  commentDisabled?: boolean;
  duetDisabled?: boolean;
  stitchDisabled?: boolean;
  maxVideoPostDurationSec?: number;
  nickname?: string;
  username?: string;
  fetchedAt?: string;
}

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
  options: optionFields(PRIVACY.map((p) => p.value), {}),
};

/**
 * The settings TikTok obliges the app to show, built from what creator_info says about this creator (or, without it, every choice
 * TikTok has). Nothing is chosen for the person: no privacy, everything unticked.
 */
function optionFields(privacyOptions: string[], info: CreatorInfo, audited = true): OptionField[] {
  const known = PRIVACY.filter((p) => privacyOptions.includes(p.value));
  const unknown = privacyOptions.filter((v) => !PRIVACY.some((p) => p.value === v)).map((v) => ({ value: v, label: v }));
  // Branded content cannot be private, so "Only me" cannot be picked while it is ticked.
  const choices = [...known, ...unknown]
    .filter((c) => audited || c.value === 'SELF_ONLY')
    .map((c) => (c.value === 'SELF_ONLY' ? { ...c, disabledWhen: 'brandedContent' } : c));
  const off = (flag: boolean | undefined, what: string) => (flag ? { disabled: true, help: `${what} are turned off for this account in TikTok's own settings.` } : {});
  return [
    ...(info.nickname || info.username
      ? [{ key: 'creator', label: `Posting to TikTok as ${info.nickname ?? info.username}${info.username && info.nickname ? ` (@${info.username})` : ''}`, type: 'info' as const }]
      : []),
    {
      key: 'privacy', label: 'Who can see this post', type: 'select', required: true, choices,
      help: audited ? 'TikTok asks that nobody is chosen for you.' : `TikTok asks that nobody is chosen for you. ${UNAUDITED_HELP}`,
    },
    { key: 'allowComment', label: 'Allow comments', type: 'checkbox', default: false, ...off(info.commentDisabled, 'Comments') },
    { key: 'allowDuet', label: 'Allow duets', type: 'checkbox', default: false, placements: ['video'], ...off(info.duetDisabled, 'Duets') },
    { key: 'allowStitch', label: 'Allow stitches', type: 'checkbox', default: false, placements: ['video'], ...off(info.stitchDisabled, 'Stitches') },
    { key: 'commercial', label: 'This post promotes a brand, product or service', type: 'checkbox', default: false, help: 'Say whether it is your own brand, branded content, or both.' },
    { key: 'yourBrand', label: 'Your brand', type: 'checkbox', default: false, showWhen: 'commercial', help: "You are promoting yourself or your own business. The post will be labelled 'Promotional content'." },
    { key: 'brandedContent', label: 'Branded content', type: 'checkbox', default: false, showWhen: 'commercial', help: "You are promoting another brand or a third party. The post will be labelled 'Paid partnership', and it cannot be private." },
    { key: 'consent', label: 'I agree', type: 'checkbox', required: true, hideWhen: 'brandedContent', notice: CONSENT },
    { key: 'consentBranded', label: 'I agree', type: 'checkbox', required: true, showWhen: 'brandedContent', notice: CONSENT_BRANDED },
    { key: 'title', label: 'Title of the photos', type: 'text', maxLength: 90, placements: ['photo'], help: 'The title of the piece is used if this is empty.' },
    ...(info.maxVideoPostDurationSec ? [{ key: 'maxDuration', label: `This account can post videos of up to ${info.maxVideoPostDurationSec} seconds.`, type: 'info' as const, placements: ['video'] }] : []),
    { key: 'processing', label: PROCESSING_NOTE, type: 'info' },
  ];
}

const creatorInfoOf = (a: Account): CreatorInfo => (a.providerData.creatorInfo ?? {}) as CreatorInfo;
const PRIVACY_LABEL = (v: string) => PRIVACY.find((p) => p.value === v)?.label ?? v;
/** A privacy choice's name, in the reader's language (TikTok's own value when it is one this app does not know). */
const privacyName = (v: string): Localized | string => {
  const key = `option.tiktok.privacy.choice.${v}`;
  return isKnown(key) ? msg(key as Key) : (PRIVACY.find((p) => p.value === v)?.label ?? v);
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

  const basePostInfo = (input: PublishInput, account: Account) => ({
    privacy_level: effectivePrivacy(input, account),
    disable_comment: !flag(input, 'allowComment'),
    brand_content_toggle: flag(input, 'commercial') && flag(input, 'brandedContent'),
    brand_organic_toggle: flag(input, 'commercial') && flag(input, 'yourBrand'),
  });

  async function creatorInfo(token: string) {
    return (await client.request<{ data?: {
      creator_username?: string; creator_nickname?: string; creator_avatar_url?: string; privacy_level_options?: string[];
      comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean; max_video_post_duration_sec?: number;
    } }>('/v2/post/publish/creator_info/query/', token, { method: 'POST', json: {} })).data ?? {};
  }

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
      const err = (code: string, params: Params = {}, field: Issue['field'] = 'placement'): Issue => issue('error', code, params, field);
      const privacy = String(input.options.privacy ?? '');
      // What TikTok said this creator may choose, when the post was being written; every choice TikTok has, if it was never asked.
      const info = creatorInfoOf(account);
      const offered = info.privacyLevelOptions ?? PRIVACY.map((p) => p.value);
      if (!privacy) {
        issues.push(err('tiktok.privacy'));
      } else if (!offered.includes(privacy)) {
        // The list of what is offered is put into words now, in the language of whoever is scheduling.
        issues.push(err('tiktok.privacy.unavailable', { choice: privacyName(privacy), choices: offered.map((v) => { const n = privacyName(v); return typeof n === 'string' ? n : render(requestLocale(), n); }).join(', ') }));
      }
      if (flag(input, 'commercial') && !flag(input, 'yourBrand') && !flag(input, 'brandedContent')) {
        issues.push(err('tiktok.commercial'));
      }
      if (flag(input, 'brandedContent') && privacy === 'SELF_ONLY') issues.push(err('tiktok.branded.private'));
      // One agreement is shown at a time: the branded-content one replaces the plain one.
      if (flag(input, 'brandedContent')) {
        if (!flag(input, 'consentBranded')) issues.push(err('tiktok.consent.branded', { notice: CONSENT_BRANDED }));
      } else if (!flag(input, 'consent')) {
        issues.push(err('tiktok.consent', { notice: CONSENT }));
      }
      const switchedOff: [string, boolean | undefined][] = [['allowComment', info.commentDisabled], ['allowDuet', info.duetDisabled], ['allowStitch', info.stitchDisabled]];
      for (const [key, disabled] of switchedOff) {
        if (disabled && flag(input, key)) issues.push(err(`tiktok.${key}.disabled`));
      }
      const video = mainOf(input).find((m) => m.kind === 'video');
      if (input.placement === 'video' && video?.durationMs && info.maxVideoPostDurationSec && video.durationMs / 1000 > info.maxVideoPostDurationSec) {
        issues.push(err('tiktok.duration', { max: String(info.maxVideoPostDurationSec), seconds: String(Math.round(video.durationMs / 1000)) }, 'media'));
      }
      if (!audited(account)) {
        issues.push(issue('warning', 'tiktok.unaudited', {}, 'schedule'));
      }
      if (input.placement === 'photo') {
        issues.push(issue('warning', 'tiktok.photo.domain', {}, 'media'));
      }
      return issues;
    },

    /** What TikTok says this creator may do, asked while the post is being written (TikTok's rule), as the settings to show. */
    async accountOptions(account, env): Promise<AccountOptions> {
      const token = (await env.token()).accessToken;
      const raw = await creatorInfo(token);
      const info: CreatorInfo = {
        privacyLevelOptions: raw.privacy_level_options, commentDisabled: raw.comment_disabled, duetDisabled: raw.duet_disabled, stitchDisabled: raw.stitch_disabled,
        maxVideoPostDurationSec: raw.max_video_post_duration_sec, nickname: raw.creator_nickname, username: raw.creator_username, fetchedAt: env.now().toISOString(),
      };
      return {
        fields: optionFields(info.privacyLevelOptions ?? [], info, audited(account)),
        remember: { creatorInfo: info, ...(info.username ? { username: info.username } : {}) },
      };
    },

    // The upload is the publishing (see above), so there is nothing to make ahead of the hour.
    async prepare(_input, _account, handle: Handle): Promise<PrepareResult> {
      return { done: true, handle };
    },

    async publish(input, account, handle: Handle, env: ConnectorEnv): Promise<Published> {
      const token = (await env.token()).accessToken;
      let h: Handle = { ...handle };
      let username = account.providerData.username ? String(account.providerData.username) : undefined;
      const profile = () => (username ? `https://www.tiktok.com/@${username}` : 'https://www.tiktok.com/');
      let switchedOff: { comment?: boolean; duet?: boolean; stitch?: boolean } = (h.switchedOff as typeof switchedOff | undefined) ?? {};

      // Asked again right before anything is sent, as TikTok wants: what was chosen when the post was written must still be on offer.
      if (!h.publishId) {
        const info = await creatorInfo(token);
        const privacy = effectivePrivacy(input, account);
        if (info.privacy_level_options && !info.privacy_level_options.includes(privacy)) {
          throw new ConnectorError('file_rejected', `TikTok no longer offers "${PRIVACY_LABEL(privacy)}" for this account (it offers ${info.privacy_level_options.map(PRIVACY_LABEL).join(', ')}). Schedule it again and choose who can see the post.`, { detail: info });
        }
        const video = mainOf(input)[0];
        if (input.placement === 'video' && video?.durationMs && info.max_video_post_duration_sec && video.durationMs / 1000 > info.max_video_post_duration_sec) {
          throw new ConnectorError('file_rejected', `This account can post videos of up to ${info.max_video_post_duration_sec} seconds on TikTok; this one is ${Math.round(video.durationMs / 1000)}`);
        }
        // What the creator has switched off stays off, whatever was ticked when the post was written.
        switchedOff = { comment: info.comment_disabled === true, duet: info.duet_disabled === true, stitch: info.stitch_disabled === true };
        username ??= info.creator_username;
        h = { ...h, switchedOff };
      }
      const postInfo = { ...basePostInfo(input, account), ...(switchedOff.comment ? { disable_comment: true } : {}) };

      if (input.placement === 'photo') {
        if (!h.publishId) {
          const main = mainOf(input);
          const title = String(typeof input.options.title === 'string' && input.options.title.trim() ? input.options.title : input.title).slice(0, 90);
          const r = await client.request<{ data: { publish_id: string } }>('/v2/post/publish/content/init/', token, {
            method: 'POST',
            json: {
              post_info: { title, description: input.text.slice(0, 4000), ...postInfo, auto_add_music: false },
              source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: main.map((m) => m.url) },
              post_mode: 'DIRECT_POST', media_type: 'PHOTO',
            },
          });
          h = { ...h, publishId: r.data.publish_id, privacy: effectivePrivacy(input, account) };
          await env.persist(h);
        }
        return { externalId: h.publishId as string, url: profile() };
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
              title: input.text.slice(0, 2200), ...postInfo,
              disable_duet: switchedOff.duet || !flag(input, 'allowDuet'), disable_stitch: switchedOff.stitch || !flag(input, 'allowStitch'), is_aigc: input.aiGenerated,
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
      return { externalId: h.publishId as string, url: profile() };
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
