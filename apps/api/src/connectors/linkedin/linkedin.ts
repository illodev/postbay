import { call } from '../http.js';
import { validateAgainst } from '../validate.js';
import {
  ConnectorError,
  type Account, type Capabilities, type Connector, type ConnectorEnv, type Handle, type HealthResult, type Issue,
  type MediaItem, type MetricsResult, type PrepareResult, type Published, type PublishInput, type VerifyResult,
} from '../types.js';
import { classifyLinkedIn, duplicateOf, urn, type LinkedInClient } from './client.js';

/**
 * LinkedIn publishing as a company page through the Posts API. Pictures, videos and documents are uploaded first (each
 * returns an id), then one call makes the post with them. There is no scheduling.
 *
 * LinkedIn has no idempotency key; it refuses a post that repeats another and names the original in the message, which is
 * how a post whose answer was lost is found again (see publish()).
 *
 * Every version of the API lives about a year and goes in a header (LINKEDIN_VERSION): that has to be moved forward by hand.
 */
const CAPS: Capabilities = {
  network: 'linkedin',
  placements: [
    { id: 'image', label: 'Picture', accepts: ['image'], items: { min: 1, max: 1 }, profiles: { image: 'li-image' }, nativeScheduling: false },
    { id: 'images', label: 'Several pictures', accepts: ['image'], items: { min: 2, max: 20 }, profiles: { image: 'li-image' }, nativeScheduling: false },
    {
      id: 'video', label: 'Video', accepts: ['video'], items: { min: 1, max: 1 }, durationSec: { min: 3, max: 1800 },
      profiles: { video: 'li-video' }, nativeScheduling: false,
    },
    // A PDF is not a picture or a video, so the shared checks see no files here; the connector asks for exactly one PDF.
    { id: 'document', label: 'Document (PDF)', accepts: [], items: { min: 0, max: 0 }, profiles: {}, nativeScheduling: false },
  ],
  text: { maxChars: 3000, previewCutoff: 210, firstComment: true, firstCommentMaxChars: 1250 },
  aiLabel: false,
  nativeScheduling: null,
  options: [
    { key: 'title', label: 'Title of the video or document', type: 'text', maxLength: 200, placements: ['video', 'document'], help: 'Shown above a document and on a video. The title of the piece is used if this is empty.' },
    { key: 'altText', label: 'Description of the picture (alt text)', type: 'text', maxLength: 1000, placements: ['image', 'images'], help: 'Read aloud to people who cannot see the picture.' },
  ],
};

const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

const mainOf = (input: PublishInput): MediaItem[] =>
  input.media.filter((m) => m.kind === 'video' || m.kind === 'image').sort((a, b) => a.position - b.position);
const pdfOf = (input: PublishInput) => input.media.find((m) => m.kind === 'pdf');
const orgUrn = (a: Account) => String(a.providerData.urn ?? `urn:li:organization:${a.externalId}`);
const titleOf = (input: PublishInput) => String(typeof input.options.title === 'string' && input.options.title.trim() ? input.options.title : input.title).slice(0, 200);

/**
 * The text of a post is read by LinkedIn as markup: these characters would start a mention or a template and cut the
 * text off, so each is escaped with a backslash. A hashtag (#) is left alone, so it stays a hashtag.
 */
export function escapeCommentary(text: string): string {
  return text.replace(/[\\|{}@[\]()<>*_~]/g, (c) => `\\${c}`);
}

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

export function createLinkedIn(client: LinkedInClient): Connector {
  /** Uploads go to an address LinkedIn gave back, which is already complete. */
  async function putTo(url: string, token: string, bytes: Buffer, type = 'application/octet-stream') {
    const r = await call(url, { method: 'PUT', body: new Uint8Array(bytes) as unknown as BodyInit, headers: { authorization: `Bearer ${token}`, 'content-type': type }, timeoutMs: 30 * 60_000 });
    const err = classifyLinkedIn(r);
    if (err) throw err;
    return r;
  }

  async function uploadSimple(kind: 'images' | 'documents', token: string, owner: string, m: MediaItem, env: ConnectorEnv): Promise<string> {
    const init = (await client.request(`/rest/${kind}?action=initializeUpload`, token, { method: 'POST', json: { initializeUploadRequest: { owner } } })).body?.value;
    await putTo(init.uploadUrl, token, await readRange(env, m.key, 0, m.bytes + 1), m.mime);
    return kind === 'images' ? init.image : init.document;
  }

  async function status(kind: 'videos' | 'documents', id: string, token: string): Promise<'ready' | 'pending'> {
    const s = (await client.request(`/rest/${kind}/${urn(id)}`, token)).body;
    if (s?.status === 'AVAILABLE') return 'ready';
    if (s?.status === 'PROCESSING_FAILED') throw new ConnectorError('file_rejected', `LinkedIn could not process the ${kind === 'videos' ? 'video' : 'document'}`, { detail: s });
    return 'pending';
  }

  const connector: Connector = {
    network: 'linkedin',
    provider: 'linkedin',

    capabilities: () => CAPS,

    defaultPlacement({ format, media }) {
      if (media.some((m) => m.kind === 'pdf')) return 'document';
      if (media.some((m) => m.kind === 'video')) return 'video';
      const images = media.filter((m) => m.kind === 'image').length;
      if (images > 1 || (format === 'carousel' && images > 0)) return images > 1 ? 'images' : 'image';
      return images === 1 ? 'image' : null;
    },

    validate(input): Issue[] {
      const issues = validateAgainst(CAPS, input);
      if (input.placement === 'document') {
        const pdf = pdfOf(input);
        if (!pdf) issues.push({ severity: 'error', code: 'media.count', field: 'media', message: 'A LinkedIn document needs exactly one PDF in this version' });
        else if (pdf.bytes > MAX_DOCUMENT_BYTES) issues.push({ severity: 'error', code: 'media.size', field: 'media', message: `${pdf.name} is larger than 100 MB, which is what LinkedIn takes for a document` });
        if (input.media.some((m) => m.kind === 'video' || m.kind === 'image')) {
          issues.push({ severity: 'warning', code: 'document.extra', field: 'media', message: 'The pictures and videos in this version are not sent: only the PDF is posted as a document' });
        }
      }
      return issues;
    },

    async prepare(input, account, handle: Handle, env: ConnectorEnv): Promise<PrepareResult> {
      const token = (await env.token()).accessToken;
      const owner = orgUrn(account);
      let h: Handle = { ...handle };
      const save = () => env.persist(h);

      if (input.placement === 'image' || input.placement === 'images') {
        const main = mainOf(input);
        const ids: string[] = Array.isArray(h.images) ? [...h.images] : [];
        for (let i = ids.length; i < main.length; i++) {
          ids.push(await uploadSimple('images', token, owner, main[i]!, env));
          h = { ...h, images: ids };
          await save(); // a picture already uploaded is not uploaded again if a later one fails
        }
        return { done: true, handle: h };
      }

      if (input.placement === 'document') {
        const pdf = pdfOf(input)!;
        if (!h.document) {
          h = { ...h, document: await uploadSimple('documents', token, owner, pdf, env) };
          await save();
        }
        return (await status('documents', h.document as string, token)) === 'ready' ? { done: true, handle: h } : { done: false, handle: h, retryAfterSec: 5 };
      }

      // Video: start, send the parts LinkedIn asked for, say they are all there, then wait for it to be processed.
      const m = mainOf(input)[0]!;
      if (!h.video) {
        const init = (await client.request('/rest/videos?action=initializeUpload', token, {
          method: 'POST', json: { initializeUploadRequest: { owner, fileSizeBytes: m.bytes, uploadCaptions: false, uploadThumbnail: false } },
        })).body?.value;
        h = { ...h, video: { urn: init.video, token: init.uploadToken ?? '', parts: init.uploadInstructions as { uploadUrl: string; firstByte: number; lastByte: number }[], etags: [] as string[], finalized: false } };
        await save();
      }
      const v = h.video as { urn: string; token: string; parts: { uploadUrl: string; firstByte: number; lastByte: number }[]; etags: string[]; finalized: boolean };
      if (!v.finalized) {
        for (let i = v.etags.length; i < v.parts.length; i++) {
          const p = v.parts[i]!;
          const r = await putTo(p.uploadUrl, token, await readRange(env, m.key, p.firstByte, p.lastByte - p.firstByte + 1));
          v.etags.push(r.headers.get('etag') ?? '');
          h = { ...h, video: v };
          await save();
        }
        await client.request('/rest/videos?action=finalizeUpload', token, { method: 'POST', json: { finalizeUploadRequest: { video: v.urn, uploadToken: v.token, uploadedPartIds: v.etags } } });
        v.finalized = true;
        h = { ...h, video: v };
        await save();
      }
      return (await status('videos', v.urn, token)) === 'ready' ? { done: true, handle: h } : { done: false, handle: h, retryAfterSec: 10 };
    },

    async publish(input, account, handle: Handle, env: ConnectorEnv): Promise<Published> {
      const token = (await env.token()).accessToken;
      const owner = orgUrn(account);
      let h: Handle = { ...handle };

      if (!h.postUrn) {
        if (!h.attemptedAt) {
          h = { ...h, attemptedAt: env.now().toISOString() };
          await env.persist(h); // written down BEFORE the call: if the answer is lost, the next try knows a post may exist
        }
        const alt = typeof input.options.altText === 'string' ? input.options.altText : '';
        const content =
          input.placement === 'image' ? { media: { id: (h.images as string[])[0], ...(alt ? { altText: alt } : {}) } }
          : input.placement === 'images' ? { multiImage: { images: (h.images as string[]).map((id) => ({ id, ...(alt ? { altText: alt } : {}) })) } }
          : input.placement === 'video' ? { media: { id: (h.video as { urn: string }).urn, title: titleOf(input) } }
          : { media: { id: h.document as string, title: titleOf(input) } };
        try {
          const r = await client.request('/rest/posts', token, {
            method: 'POST',
            json: {
              author: owner, commentary: escapeCommentary(input.text), visibility: 'PUBLIC', lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
              distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, content,
            },
          });
          const id = r.headers.get('x-restli-id');
          if (!id) throw new ConnectorError('unknown', 'LinkedIn created the post but did not say which one it is');
          h = { ...h, postUrn: id };
        } catch (err) {
          const original = duplicateOf(err);
          if (!original) throw err;
          // The message names the post it repeats. If that post was made after we started trying, it is ours.
          const post = (await client.request(`/rest/posts/${urn(original)}`, token)).body;
          const made = Number(post?.createdAt ?? post?.publishedAt ?? 0);
          if (!made || made < new Date(h.attemptedAt as string).getTime() - 60_000) throw err;
          h = { ...h, postUrn: original, recovered: true };
        }
        await env.persist(h); // from here on a retry must not post a second time
      }

      if (input.firstComment && !h.commentId && !h.firstCommentError) {
        try {
          const r = await client.request(`/rest/socialActions/${urn(h.postUrn as string)}/comments`, token, {
            method: 'POST', json: { actor: owner, message: { text: input.firstComment } },
          });
          h = { ...h, commentId: r.body?.['$URN'] ?? r.body?.id ?? true };
        } catch (err) {
          h = { ...h, firstCommentError: (err as Error).message };
          env.log.warn({ err: String(err) }, 'could not post the LinkedIn first comment');
        }
        await env.persist(h);
      }
      return { externalId: h.postUrn as string, url: `https://www.linkedin.com/feed/update/${h.postUrn}/` };
    },

    async verify(_account, externalId, _handle, env): Promise<VerifyResult> {
      const token = (await env.token()).accessToken;
      const url = `https://www.linkedin.com/feed/update/${externalId}/`;
      try {
        const p = (await client.request(`/rest/posts/${urn(externalId)}`, token)).body;
        if (p?.lifecycleState === 'PUBLISHED') return { visibility: 'public', url };
        return { visibility: 'processing', url, note: `LinkedIn says the post is ${String(p?.lifecycleState ?? 'not published yet').toLowerCase()}` };
      } catch (err) {
        if (err instanceof ConnectorError && err.errorClass === 'file_rejected') return { visibility: 'unknown', note: 'LinkedIn does not return this post any more' };
        throw err;
      }
    },

    async health(account, env): Promise<HealthResult> {
      const t = await env.token();
      await client.request(`/rest/organizations/${account.externalId}`, t.accessToken);
      // Where the app cannot renew the token, this is when the page has to be connected again.
      return { valid: true, expiresAt: t.expiresAt };
    },

    async fetchMetrics(account, externalId, _handle, env): Promise<MetricsResult> {
      const token = (await env.token()).accessToken;
      const param = externalId.startsWith('urn:li:ugcPost') ? 'ugcPosts' : 'shares';
      const r = (await client.request(
        `/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${urn(orgUrn(account))}&${param}=List(${urn(externalId)})`, token,
      )).body;
      const s = r?.elements?.[0]?.totalShareStatistics;
      if (!s) throw new ConnectorError('file_rejected', 'LinkedIn returned no figures for this post');
      return {
        common: { views: s.impressionCount, reach: s.uniqueImpressionsCount, likes: s.likeCount, comments: s.commentCount, shares: s.shareCount },
        raw: r,
        note: 'LinkedIn only gives the running total for a post, not a figure for each day',
      };
    },
  };
  return connector;
}
